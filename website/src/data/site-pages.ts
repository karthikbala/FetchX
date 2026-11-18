import { docPages } from './api-docs';
import { marketingPages } from './marketing-content';

export const publicPages = [
  { path: '/', title: 'FetchX', description: 'Web Scraping API & Web Unblocker for developers, data teams and AI builders.' },
  { path: '/developers', title: 'Developers', description: 'API examples, native HTTP access and reviewed browser workflows.' },
  { path: '/pricing', title: 'Pricing', description: 'A one-time free trial for eligible accounts and prepaid credit packs with local checkout pricing.' },
  { path: '/samples', title: 'Sample data', description: 'Fictional commerce, property and logistics datasets.' },
  { path: '/pilot', title: 'Technical evaluation', description: 'Discuss your source access and integration requirements.' },
  { path: '/privacy', title: 'Privacy', description: 'Website enquiries and data handling.' },
  { path: '/terms', title: 'Website terms', description: 'Website and product preview terms.' },
  ...marketingPages,
  ...docPages.map(page => ({ path: page.slug ? '/docs/' + page.slug : '/docs', title: page.title, description: page.description })),
];
