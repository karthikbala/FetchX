import type { APIRoute } from 'astro';
const launchReady = import.meta.env.PUBLIC_SITE_ENV === 'production' && import.meta.env.PUBLIC_PRODUCT_LAUNCH_READY === 'true';
const publicRules = 'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /app\nDisallow: /signup\nDisallow: /login\nSitemap: https://fetchx.ai/sitemap.xml\n';
export const GET: APIRoute = () => new Response(launchReady ? publicRules : 'User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
