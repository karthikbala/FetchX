import type { APIRoute } from 'astro';
import { publicPages } from '../data/site-pages';
import { docPages } from '../data/api-docs';

export const GET: APIRoute = () => new Response([
  '# FetchX', '',
  '> Web scraping and public web access infrastructure for developers, data teams and AI applications.', '',
  'Send a URL to POST /v1/fetch and FetchX returns the page: it starts with plain HTTP, moves to datacenter and residential IPs and a Camoufox browser when the site requires it, solves Turnstile, reCAPTCHA, hCaptcha and MTCaptcha in the browser, and remembers what worked per site. Responses can include markdown, text, links, metadata, parsed JSON or a screenshot. Only successful requests are charged, at the price of the step that got the data; every account gets 1,000 trial credits once, and credit packs are sold through Stripe. A failed request returns a stable error code and a next action.', '',
  '## Product and resources', '',
  ...publicPages.filter(page => !page.path.startsWith('/docs')).map(page => `- [${page.title}](https://fetchx.ai${page.path}): ${page.description}`), '',
  '## API documentation', '',
  '- [FetchX OpenAPI contract](https://fetchx.ai/openapi.json): The /v1 endpoints, schemas and examples.',
  ...docPages.map(page => `- [${page.title}](https://fetchx.ai/docs/${page.slug || 'quickstart'}.md): ${page.description}`), '',
  'Authenticate with a project API key (Bearer fxk_...). Send an idempotency_key so a resend after a lost response returns the first result and is charged once. Methods other than GET and HEAD get exactly one attempt.', '',
].join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
