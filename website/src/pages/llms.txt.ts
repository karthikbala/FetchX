import type { APIRoute } from 'astro';
import { publicPages } from '../data/site-pages';
import { docPages } from '../data/api-docs';

export const GET: APIRoute = () => new Response([
  '# FetchX', '',
  '> Web scraping and public web access infrastructure for developers, data teams and AI applications.', '',
  'The implementation includes optional email-verified accounts and project workspaces backed by a configured control service. Availability depends on operator deployment and configuration; this website does not establish public service readiness. When enabled, self-service accounts support approved native HTTP access, scoped API keys, retained request history and service-recorded credits. Actual trial eligibility and allocation come from operator configuration. Advertised prices and commercial allowances remain proposals; signup and plan selection do not purchase, upgrade or activate a subscription. Marketing dashboard illustrations and downloadable sample records remain synthetic. Use the API documentation to distinguish current interfaces from proposed capabilities.', '',
  '## Product and resources', '',
  ...publicPages.filter(page => !page.path.startsWith('/docs')).map(page => `- [${page.title}](https://fetchx.ai${page.path}): ${page.description}`), '',
  '## API documentation', '',
  ...docPages.map(page => `- [${page.title}](https://fetchx.ai/docs/${page.slug || 'quickstart'}.md): ${page.description}`), '',
  'The v2 fetch endpoint supports native HTTP and requires an approved access profile, explicit route and durable idempotency key. Self-service account access does not enable browser execution. Reviewed browser workflows use the separate v1 API and require independent qualification and configuration. API transport success and application data acceptance are separate.', '',
].join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
