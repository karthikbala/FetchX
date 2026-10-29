import type { APIRoute } from 'astro';
export const GET: APIRoute = () => new Response(import.meta.env.PUBLIC_SITE_ENV==='production'?'User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: https://fetch.headrun.ai/sitemap.xml\n':'User-agent: *\nDisallow: /\n',{headers:{'Content-Type':'text/plain; charset=utf-8'}});
