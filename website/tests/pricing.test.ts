import { describe, expect, it } from 'vitest';
import { currencyForRequest, handlePricing, requestCountry } from '../src/server/pricing';
import { formatMoney, formatPerThousand, inrCreditPackages, isCreditPlanId } from '../src/data/credit-packages';

function request(country?: unknown, init: RequestInit = {}) {
  const value = new Request('https://fetchx.ai/api/pricing?currency=usd&country=US', init);
  if (country !== undefined) Object.defineProperty(value, 'cf', { value: { country } });
  return value;
}
describe('country-selected public pricing', () => {
  it('uses trusted Cloudflare country and ignores spoofed headers and query values', async () => {
    const incoming = request('IN', { headers: { 'CF-IPCountry': 'US', 'X-FetchX-Client-Country': 'US', 'Accept-Language': 'en-US' } });
    expect(requestCountry(incoming)).toBe('IN');
    const response = handlePricing(incoming), value = await response.json() as { currency: string; payment_method: string; trial_credits: number; plans: typeof inrCreditPackages };
    expect(value).toEqual({ currency: 'inr', payment_method: 'upi', trial_credits: 1000, plans: inrCreditPackages });
    expect(value.plans.map(plan => [plan.amount_minor, plan.credits, plan.saving])).toEqual([
      [17500, 10000, null], [75000, 50000, '14.3%'], [180000, 150000, '31.4%'], [900000, 1000000, '48.6%'],
    ]);
    expect(value.plans.every(plan => plan.currency === 'inr' && plan.id.endsWith('-inr'))).toBe(true);
  });
  it('defaults other and unknown locations to USD without trusting caller country headers', async () => {
    for (const country of ['US', 'GB', undefined, null, 'XX', 'in', 'IND', 1]) {
      const incoming = request(country, { headers: { 'CF-IPCountry': 'IN', 'X-FetchX-Client-Country': 'IN', 'Accept-Language': 'en-IN' } });
      expect(currencyForRequest(incoming)).toBe('usd');
      const value = await handlePricing(incoming).json() as { currency: string; plans: { currency: string; amount_minor: number }[] };
      expect(value.currency).toBe('usd');
      expect(value.plans.map(plan => plan.amount_minor)).toEqual([200, 800, 2000, 10000]);
      expect(value.plans.every(plan => plan.currency === 'usd')).toBe(true);
    }
  });
  it('prevents shared caching of location-selected prices and accepts only read methods', () => {
    const response = handlePricing(request('IN'));
    for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Cloudflare-CDN-Cache-Control']) expect(response.headers.get(header)).toContain('no-store');
    expect(response.headers.get('Cache-Control')).toContain('private');
    expect(handlePricing(request('IN', { method: 'HEAD' })).body).toBeNull();
    expect(handlePricing(request('IN', { method: 'POST' })).status).toBe(405);
    expect(handlePricing(request('IN', { method: 'POST' })).headers.get('Allow')).toBe('GET, HEAD');
  });
  it('formats actual minor units and keeps INR and USD plan hints distinct', () => {
    expect(formatMoney(17500, 'inr')).toBe('₹175');
    expect(formatMoney(900000, 'inr')).toBe('₹9,000');
    expect(formatMoney(200, 'usd')).toBe('$2.00');
    expect(formatPerThousand(17500, 10000, 'inr')).toBe('₹17.50 / 1,000 credits');
    expect(formatPerThousand(75000, 50000, 'inr')).toBe('₹15.00 / 1,000 credits');
    expect(formatPerThousand(180000, 150000, 'inr')).toBe('₹12.00 / 1,000 credits');
    expect(formatPerThousand(900000, 1000000, 'inr')).toBe('₹9.00 / 1,000 credits');
    expect(isCreditPlanId('credits-10000-inr')).toBe(true);
    expect(isCreditPlanId('credits-10000')).toBe(true);
    expect(isCreditPlanId('credits-10000-eur')).toBe(false);
  });
});
