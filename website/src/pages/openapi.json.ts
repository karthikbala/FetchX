import type { APIRoute } from 'astro';
import { openApiDocument } from '../lib/openapi-reference.ts';

export const GET: APIRoute = () => new Response(JSON.stringify(openApiDocument, null, 2) + '\n', {
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});
