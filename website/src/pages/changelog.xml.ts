import type { APIRoute } from 'astro';
import { changelogAtom } from '../lib/changelog';

export const GET: APIRoute = () => new Response(changelogAtom(), { headers: { 'Content-Type': 'application/atom+xml; charset=utf-8' } });
