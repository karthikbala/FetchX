import { packagesForCurrency, type BillingCurrency } from '../data/credit-packages';

// Cloudflare populates request.cf. Incoming headers, locale and query parameters
// are not evidence of the visitor's country.
export function requestCountry(request: Request): string | null {
  const country = (request as Request & { cf?: { country?: unknown } }).cf?.country;
  return typeof country === 'string' && /^[A-Z]{2}$/.test(country) && country !== 'XX' ? country : null;
}
export const currencyForRequest = (request: Request): BillingCurrency => requestCountry(request) === 'IN' ? 'inr' : 'usd';
export function publicPricing(request: Request) {
  const currency = currencyForRequest(request);
  return { currency, payment_method: currency === 'inr' ? 'upi' : 'card', trial_credits: 1000, plans: packagesForCurrency(currency) };
}
export function handlePricing(request: Request): Response {
  const allowed = request.method === 'GET' || request.method === 'HEAD';
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
    'CDN-Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store',
    Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow',
  });
  if (!allowed) headers.set('Allow', 'GET, HEAD');
  const status = allowed ? 200 : 405;
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(allowed ? publicPricing(request) : { error: 'method_not_allowed' }), { status, headers });
}
