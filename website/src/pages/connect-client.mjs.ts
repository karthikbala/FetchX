import type { APIRoute } from 'astro';
import connectClient from '../../../clients/connect.mjs?raw';

export const GET: APIRoute = () => new Response(connectClient, {
  headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
});
