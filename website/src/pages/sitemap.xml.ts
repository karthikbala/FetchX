import type { APIRoute } from 'astro';
import { publicPages } from '../data/site-pages';

export const GET: APIRoute = () => new Response(
  '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
  publicPages.map(page => `<url><loc>https://fetchx.ai${page.path}</loc></url>`).join('') +
  '</urlset>',
  { headers: { 'Content-Type': 'application/xml; charset=utf-8' } }
);
