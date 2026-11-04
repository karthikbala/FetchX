export const previewViews = ['playground', 'requests', 'keys', 'billing', 'onboarding'] as const;
export type PreviewView = 'overview' | typeof previewViews[number];
export const viewTitles: Record<PreviewView, { title: string; eyebrow: string; description: string }> = {
  overview: { title: 'A clear view of your requests.', eyebrow: 'WORKSPACE OVERVIEW', description: 'Your project’s retained usage, outcomes, and next steps.' },
  playground: { title: 'Request playground', eyebrow: 'PLAYGROUND', description: 'Fetch a URL or render it in a browser.' },
  requests: { title: 'Every request. Accounted for.', eyebrow: 'REQUEST HISTORY', description: 'Inspect retained outcomes and recover results without redispatch.' },
  keys: { title: 'Your connection to FetchX.', eyebrow: 'API KEYS', description: 'Create scoped credentials, rotate them, and revoke access.' },
  billing: { title: 'Know where you stand.', eyebrow: 'CREDITS & USAGE', description: 'Trial usage, paid credits, and purchase history.' },
  onboarding: { title: 'From zero to your first response.', eyebrow: 'GETTING STARTED', description: 'Verify your email, create a project and key, then make a request.' },
};
