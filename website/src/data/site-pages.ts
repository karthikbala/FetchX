import { docPages } from './api-docs';
import { marketingPages } from './marketing-content';

export const publicPages = [
  { path: '/', title: 'FetchX', description: 'Web Scraping API & Web Unblocker for developers, data teams and AI builders.' },
  { path: '/developers', title: 'Developers', description: 'API examples in cURL, JavaScript and Python, and the coding agent guide.' },
  { path: '/pricing', title: 'Pricing', description: 'A one-time free trial for eligible accounts and prepaid credit packs with local checkout pricing.' },
  { path: '/changelog', title: 'API changelog', description: 'Every change to the FetchX API, newest first, with deprecations and retired routes.' },
  { path: '/status', title: 'Status', description: 'Whether the FetchX API is up, maintenance, incidents and 90 days of uptime.' },
  { path: '/samples', title: 'Sample data', description: 'Fictional commerce, property and logistics datasets.' },
  { path: '/pilot', title: 'Technical evaluation', description: 'Discuss your source access and integration requirements.' },
  { path: '/privacy', title: 'Privacy', description: 'Website enquiries and data handling.' },
  { path: '/terms', title: 'Website terms', description: 'Website and product preview terms.' },
  ...marketingPages,
  ...docPages.map(page => ({ path: page.slug ? '/docs/' + page.slug : '/docs', title: page.title, description: page.description })),
];
