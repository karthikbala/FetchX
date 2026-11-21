// Console views and the request code samples shown in the playground.
export const consoleViews = ['playground', 'requests', 'keys', 'billing', 'onboarding'] as const;
export type ConsoleView = 'overview' | typeof consoleViews[number];
export const viewTitles: Record<ConsoleView, { title: string; eyebrow: string; description: string }> = {
  overview: { title: 'Your project at a glance.', eyebrow: 'OVERVIEW', description: 'Credits, recent requests and what to do next.' },
  playground: { title: 'Fetch any URL', eyebrow: 'PLAYGROUND', description: 'FetchX picks the route, climbs to a browser when it has to, and charges only when it gets the data.' },
  requests: { title: 'Every request, with its attempts.', eyebrow: 'REQUESTS', description: 'Results are kept for 7 days and the summary for 90.' },
  keys: { title: 'Your connection to FetchX.', eyebrow: 'API KEYS', description: 'Create scoped keys, rotate them, and revoke access.' },
  billing: { title: 'Credits and usage.', eyebrow: 'CREDITS & USAGE', description: 'One balance: trial and purchased credits, spent only on successful requests.' },
  onboarding: { title: 'From zero to your first response.', eyebrow: 'GETTING STARTED', description: 'Verify your email, create a project and key, then make a request.' },
};

export const KEY_SCOPES = [
  { id: 'fetch:write', label: 'Send requests', detail: 'POST /v1/fetch' },
  { id: 'fetch:read', label: 'Read and delete results', detail: 'GET and DELETE /v1/fetch' },
  { id: 'usage:read', label: 'Read usage', detail: 'GET /v1/usage' },
] as const;

export const FORMATS = ['body', 'markdown', 'text', 'links', 'metadata', 'screenshot'] as const;

// Code for the same request against the public API.
export function requestCode(base: string, language: string, body: Record<string, unknown>) {
  const endpoint = base.replace(/\/$/, '') + '/v1/fetch';
  const json = JSON.stringify(body, null, 2);
  if (language === 'javascript') {
    return `import {FetchXClient} from './clients/javascript.mjs';\n\nconst fetchx = new FetchXClient({url: ${JSON.stringify(base)}, token: process.env.FETCHX_API_KEY});\nconst result = await fetchx.fetch(${json});\nconsole.log(result.status, result.error?.next ?? result.data);`;
  }
  if (language === 'python') {
    const args = Object.entries(body).map(([key, value]) => `    ${key}=${pythonValue(value)},`).join('\n');
    return `import os\nfrom clients.python import FetchXClient\n\nfetchx = FetchXClient(${JSON.stringify(base)}, os.environ['FETCHX_API_KEY'])\nresult = fetchx.fetch(\n${args}\n)\nprint(result['status'], result['error'] or result['data'])`;
  }
  const quoted = "'" + JSON.stringify(body).replaceAll("'", "'\\''") + "'";
  return `curl ${endpoint} \\\n  -H "Authorization: Bearer $FETCHX_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d ${quoted}`;
}

function pythonValue(value: unknown): string {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (Array.isArray(value)) return '[' + value.map(pythonValue).join(', ') + ']';
  if (typeof value === 'object') return '{' + Object.entries(value as Record<string, unknown>).map(([k, v]) => `${JSON.stringify(k)}: ${pythonValue(v)}`).join(', ') + '}';
  return JSON.stringify(value);
}
