import type { APIRoute } from 'astro';
import { changelog } from '../lib/changelog';

export const GET: APIRoute = () => new Response(JSON.stringify(changelog, null, 2) + '\n', {
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});
