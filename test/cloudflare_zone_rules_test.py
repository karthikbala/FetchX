"""Offline checks for ops/cloudflare/zone_rules.py and the rules it keeps in Cloudflare."""
import contextlib
import importlib.util
import io
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('zone_rules', ROOT / 'ops/cloudflare/zone_rules.py')
zone_rules = importlib.util.module_from_spec(spec)
spec.loader.exec_module(zone_rules)

OURS = {'ref': 'fetchx_api_no_browser_integrity_check', 'description': 'API host', 'expression': '(http.host eq "app.fetchx.ai")',
        'action': 'set_config', 'action_parameters': {'bic': False}, 'enabled': True}
DASHBOARD = {'id': 'd1', 'ref': 'd1', 'version': '3', 'last_updated': '2026-11-01T00:00:00Z', 'description': 'made by hand',
             'expression': '(http.request.uri.path wildcard "/blog/*")', 'action': 'set_config', 'action_parameters': {'rocket_loader': True}, 'enabled': True}


class RulesFileTests(unittest.TestCase):
    def test_the_api_host_only_loses_browser_integrity_check(self):
        config = zone_rules.load_rules()
        self.assertEqual(config['zone'], 'fetchx.ai')
        self.assertEqual(list(config['phases']), ['http_config_settings'])
        [rule] = config['phases']['http_config_settings']
        self.assertEqual(rule['expression'], '(http.host eq "app.fetchx.ai")')
        self.assertEqual(rule['action'], 'set_config')
        self.assertEqual(rule['action_parameters'], {'bic': False})
        self.assertTrue(rule['enabled'])

    def test_rules_need_their_own_ref_and_an_expression(self):
        for rules in ([{**OURS, 'ref': ''}], [OURS, OURS], [{**OURS, 'expression': ''}]):
            with tempfile.NamedTemporaryFile('w', suffix='.json') as file:
                json.dump({'zone': 'fetchx.ai', 'phases': {'http_config_settings': rules}}, file)
                file.flush()
                with self.assertRaises(ValueError):
                    zone_rules.load_rules(file.name)


class MergeTests(unittest.TestCase):
    def test_adds_the_rule_after_rules_made_elsewhere_and_keeps_them(self):
        rules, changes = zone_rules.merge([DASHBOARD], [OURS])
        self.assertEqual(changes, [('add', OURS['ref'])])
        self.assertEqual(rules[0], {key: value for key, value in DASHBOARD.items() if key not in ('version', 'last_updated')})
        self.assertEqual(rules[1], OURS)

    def test_an_empty_phase_gets_just_the_rule(self):
        self.assertEqual(zone_rules.merge([], [OURS]), ([OURS], [('add', OURS['ref'])]))

    def test_a_rule_already_live_is_left_alone(self):
        live = {**OURS, 'id': 'r1', 'version': '1', 'last_updated': '2026-11-21T00:00:00Z'}
        rules, changes = zone_rules.merge([live, DASHBOARD], [OURS])
        self.assertEqual(changes, [('unchanged', OURS['ref'])])
        self.assertEqual([rule.get('id') for rule in rules], ['r1', 'd1'])

    def test_a_changed_rule_is_updated_in_place_and_keeps_its_id(self):
        live = {**OURS, 'id': 'r1', 'action_parameters': {'bic': True}, 'version': '1'}
        rules, changes = zone_rules.merge([DASHBOARD, live], [OURS])
        self.assertEqual(changes, [('update', OURS['ref'])])
        self.assertEqual(rules[1], {**OURS, 'id': 'r1'})

    def test_a_disabled_copy_counts_as_changed(self):
        _, changes = zone_rules.merge([{**OURS, 'id': 'r1', 'enabled': False}], [OURS])
        self.assertEqual(changes, [('update', OURS['ref'])])

    def test_remove_takes_out_only_our_rule(self):
        rules, changes = zone_rules.remove([DASHBOARD, {**OURS, 'id': 'r1'}], [OURS['ref']])
        self.assertEqual(changes, [('remove', OURS['ref'])])
        self.assertEqual([rule['id'] for rule in rules], ['d1'])
        self.assertEqual(zone_rules.remove([DASHBOARD], [OURS['ref']])[1], [('absent', OURS['ref'])])


class FakeCloudflare(BaseHTTPRequestHandler):
    """Just enough of the Cloudflare API: one zone, one http_config_settings entrypoint."""
    zone_rules_live = None  # None: the phase has no entrypoint ruleset yet
    puts = []

    def log_message(self, *args):
        pass

    def reply(self, status, result=None):
        body = json.dumps({'success': status < 400, 'errors': [] if status < 400 else [{'code': 10000, 'message': 'nope'}], 'result': result}).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.headers['Authorization'] != 'Bearer fixture-token':
            return self.reply(403)
        if self.path == '/zones?name=fetchx.ai':
            return self.reply(200, [{'id': 'z1', 'name': 'fetchx.ai'}])
        if self.path == '/zones/z1/rulesets/phases/http_config_settings/entrypoint':
            cls = type(self)
            return self.reply(404) if cls.zone_rules_live is None else self.reply(200, {'id': 'rs1', 'rules': cls.zone_rules_live})
        self.reply(404)

    def do_PUT(self):
        cls = type(self)
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        cls.puts.append(body)
        cls.zone_rules_live = [{**rule, 'id': rule.get('id') or f'new{n}', 'version': '1'} for n, rule in enumerate(body['rules'])]
        self.reply(200, {'id': 'rs1', 'version': str(len(cls.puts)), 'rules': cls.zone_rules_live})


class CommandTests(unittest.TestCase):
    def setUp(self):
        FakeCloudflare.zone_rules_live, FakeCloudflare.puts = None, []
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), FakeCloudflare)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        token = tempfile.NamedTemporaryFile('w', suffix='.token', delete=False)
        token.write('fixture-token\n')
        token.close()
        self.addCleanup(Path(token.name).unlink)
        self.patch('API', f'http://127.0.0.1:{self.server.server_port}')
        self.patch('TOKEN_FILE', token.name)

    def patch(self, name, value):
        old = getattr(zone_rules, name)
        setattr(zone_rules, name, value)
        self.addCleanup(setattr, zone_rules, name, old)

    def run_command(self, command):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            zone_rules.main([command])
        return out.getvalue()

    def test_plan_changes_nothing_apply_creates_the_entrypoint_and_remove_rolls_back(self):
        self.assertIn('add fetchx_api_no_browser_integrity_check', self.run_command('plan'))
        self.assertEqual(FakeCloudflare.puts, [])
        self.assertIn('saved', self.run_command('apply'))
        [rule] = FakeCloudflare.puts[0]['rules']
        self.assertEqual((rule['expression'], rule['action_parameters']), ('(http.host eq "app.fetchx.ai")', {'bic': False}))
        self.assertIn('unchanged fetchx_api_no_browser_integrity_check', self.run_command('apply'))
        self.assertEqual(len(FakeCloudflare.puts), 1)
        self.assertIn('remove fetchx_api_no_browser_integrity_check', self.run_command('remove'))
        self.assertEqual(FakeCloudflare.puts[-1], {'rules': []})

    def test_rules_made_in_the_dashboard_survive(self):
        FakeCloudflare.zone_rules_live = [DASHBOARD]
        self.assertIn('1 other rule(s) kept', self.run_command('apply'))
        self.assertEqual([rule.get('id') for rule in FakeCloudflare.puts[0]['rules']], ['d1', None])

    def test_a_token_without_zone_access_says_what_it_needs(self):
        Path(zone_rules.TOKEN_FILE).write_text('other-token')
        with self.assertRaisesRegex(SystemExit, 'Config Rules > Edit'):
            self.run_command('plan')


if __name__ == '__main__':
    unittest.main()
