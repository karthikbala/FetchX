"""Offline checks for the Python SDK's asyncio client (clients/python-sdk)."""
import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "clients" / "python-sdk" / "src"))

from fetchx import FetchXError, SpendLimitReached  # noqa: E402
from fetchx.testing import FakeFetchX, FakePage  # noqa: E402

SHOP = "https://shop.example.com"
DOCS = "https://docs.example.org"


def fake_sites(**options):
    pages = {f"{SHOP}/p/{i}": FakePage(f"<html>shop {i}</html>", next_url=f"{SHOP}/p/{i + 1}") for i in range(1, 4)}
    pages.update({f"{DOCS}/d/{i}": f"<html>docs {i}</html>" for i in range(1, 4)})
    return FakeFetchX(pages, **options)


async def tiny_sleep(_seconds):
    await asyncio.sleep(0.001)


class AsyncClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_fetch_polls_downloads_the_body_and_follows_next_pages(self):
        fake = fake_sites(pending_polls=2)
        async with fake.async_client() as fx:
            first = await fx.fetch(url=f"{SHOP}/p/1")
            second = await fx.next(first)
        self.assertEqual((first.body, second.body, second.page.number),
                         ("<html>shop 1</html>", "<html>shop 2</html>", 2))
        self.assertEqual((fx.credits_spent, fx.calls), (2, 2))

    async def test_a_lost_answer_is_resent_with_the_same_key(self):
        fake = fake_sites().drop(1, method="POST")
        fx = fake.async_client()
        result = await fx.fetch(url=f"{SHOP}/p/1")
        posts = [call for call in fake.requests if call.method == "POST"]
        self.assertEqual([post.json["idempotency_key"] for post in posts], [result.idempotency_key] * 2)
        self.assertEqual(len(fake.site_requests), 1)

    async def test_refusals_raise_and_failures_retry_only_when_allowed(self):
        fake = fake_sites().fail(f"{SHOP}/p/1", "blocked", retry_after_seconds=5)
        slept = []

        async def sleep(seconds):
            slept.append(seconds)

        fx = fake.async_client(retry_failed=1, sleep=sleep)
        result = await fx.fetch(url=f"{SHOP}/p/1", idempotency_key="a1")
        self.assertTrue(result.ok)
        self.assertEqual(slept, [5])
        self.assertEqual([c.json["idempotency_key"] for c in fake.requests if c.method == "POST"], ["a1", "a1.retry1"])
        with self.assertRaises(FetchXError) as caught:
            await fx.fetch(url="mailto:someone@example.com")
        self.assertEqual(caught.exception.code, "invalid_request")

    async def test_same_site_requests_take_turns_while_other_sites_run_alongside(self):
        fake = fake_sites(pending_polls=3)
        fx = fake.async_client(sleep=tiny_sleep, poll_every=0.001)
        results = await asyncio.gather(*(fx.fetch(url=f"{SHOP}/p/{i}") for i in range(1, 4)),
                                       *(fx.fetch(url=f"{DOCS}/d/{i}") for i in range(1, 4)))
        self.assertTrue(all(result.ok for result in results))
        self.assertEqual(fake.peak_running, {"shop.example.com": 1, "docs.example.org": 1})
        self.assertEqual([call.method for call in fake.requests[:2]], ["POST", "POST"],
                         "the second site starts while the first is still running")

        fake = fake_sites(pending_polls=3)
        fx = fake.async_client(sleep=tiny_sleep, poll_every=0.001, per_site=None)
        await asyncio.gather(*(fx.fetch(url=f"{SHOP}/p/{i}") for i in range(1, 4)))
        self.assertEqual(fake.peak_running, {"shop.example.com": 3})

    async def test_batches_run_and_feed_results(self):
        fake = fake_sites(batch_step=1)
        fx = fake.async_client()
        results = await fx.run_batch([f"{SHOP}/p/1", f"{DOCS}/d/1"])
        self.assertEqual([result.body for result in results], ["<html>shop 1</html>", "<html>docs 1</html>"])
        batch = await fx.submit_batch([f"{SHOP}/p/2", f"{SHOP}/p/3"], defaults={"formats": ["markdown"]})
        seen = [item async for item in fx.batch_results(batch, want_body=True)]
        self.assertEqual(sorted(item.index for item in seen), [0, 1])
        self.assertEqual(seen[0].result.body, "<html>shop 2</html>")
        self.assertTrue((await fx.wait_batch(batch.id)).done)
        self.assertEqual((await fx.batch_items(batch.id)).items[1].status, "succeeded")
        self.assertEqual((await fx.cancel_batch(batch.id)).status, "finished")
        self.assertEqual(len(await fx.list_batches()), 2)

    async def test_spend_limit_hooks_and_account_calls(self):
        events = []

        async def hook(event):
            events.append(event.op)

        fake = fake_sites(credits=2)
        fx = fake.async_client(spend_limit=4, on_call=hook)
        await fx.fetch(url=f"{SHOP}/p/1")
        await fx.fetch(url=f"{DOCS}/d/1")
        with self.assertRaises(SpendLimitReached):
            await fx.fetch(url=f"{DOCS}/d/2")
        self.assertEqual(fx.remaining_credits, 0)
        self.assertEqual((await fx.balance()).credits, 1_000_000 - 4)
        self.assertEqual((await fx.usage()).credits_used, 4)
        self.assertEqual((await fx.estimate(url=f"{SHOP}/p/1")).credits.typical, 2)
        self.assertTrue((await fx.status()).operational)
        self.assertEqual((await fx.me()).scopes, ["fetch:write", "fetch:read", "usage:read"])
        self.assertEqual(events, ["fetch", "fetch", "fetch", "balance", "usage", "estimate", "status", "me"])

    async def test_reads_content_lists_and_waits(self):
        fake = fake_sites(pending_polls=4)
        fx = fake.async_client(max_wait=0)
        with self.assertRaises(FetchXError) as caught:
            await fx.fetch(url=f"{SHOP}/p/1")
        fetch_id = caught.exception.details["id"]
        self.assertEqual(caught.exception.code, "wait_timeout")
        done = await fx.wait(fetch_id, max_wait=30)
        self.assertEqual(done.body, "<html>shop 1</html>")
        self.assertEqual((await fx.content(fetch_id)).text, "<html>shop 1</html>")
        self.assertEqual((await fx.get(fetch_id)).id, fetch_id)
        self.assertEqual((await fx.get_raw(fetch_id))["status"], "succeeded")
        self.assertEqual([item.id for item in await fx.list()], [fetch_id])
        await fx.delete(fetch_id)
        with self.assertRaises(FetchXError) as caught:
            await fx.screenshot(fetch_id)
        self.assertEqual(caught.exception.status, 410)
        fake.pending_polls = 0
        captured = await fx.fetch(url=f"{SHOP}/p/2", capture=True)
        self.assertEqual([row["type"] for row in await fx.network(captured)], ["document"])
        self.assertEqual((await fx.network_call(captured, 1)).body, "<html>shop 2</html>")
        self.assertEqual((await fx.network_body(captured, 1)).text, "<html>shop 2</html>")
        self.assertEqual(len((await fx.network_har(captured))["log"]["entries"]), 1)
        await fx.aclose()


if __name__ == "__main__":
    unittest.main()
