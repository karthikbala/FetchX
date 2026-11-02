import type { APIRoute, GetStaticPaths } from 'astro';
import { docPages } from '../../data/api-docs';
import type { DocPage } from '../../data/api-docs';
import { docMarkdown } from '../../lib/docs-markdown';

export const getStaticPaths: GetStaticPaths = () => docPages.map(page => ({ params: { slug: page.slug || 'quickstart' }, props: { page } }));
export const GET: APIRoute = ({ props }) => new Response(docMarkdown(props.page as DocPage), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
