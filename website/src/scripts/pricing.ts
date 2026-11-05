import { formatMoney, formatPerThousand, isBillingCurrency, packagesForCurrency, type BillingCurrency } from '../data/credit-packages';

const roots = [...document.querySelectorAll<HTMLElement>('[data-local-pricing]')];
if (roots.length) void loadPricing();
async function loadPricing() {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch('/api/pricing', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
    if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') || '')) throw new Error();
    const value = await response.json();
    if (!isBillingCurrency(value.currency) || value.trial_credits !== 1000 ||
        value.payment_method !== (value.currency === 'inr' ? 'upi' : 'card') ||
        !Array.isArray(value.plans) || value.plans.length !== 4 || !value.plans.every((plan: Record<string, unknown>, index: number) => {
          const expected = packagesForCurrency(value.currency)[index];
          return Object.keys(expected).every(key => plan?.[key] === expected[key as keyof typeof expected]);
        })) throw new Error();
    for (const root of roots) render(root, value.currency);
  } catch {
    for (const root of roots) {
      root.querySelector('[data-pricing-status]')!.textContent = 'Local prices could not be loaded. Refresh this page or sign in to check pricing.';
      root.setAttribute('aria-busy', 'false');
    }
  } finally { clearTimeout(timer); }
}
function render(root: HTMLElement, currency: BillingCurrency) {
  root.dataset.pricingCurrency = currency;
  root.querySelector('[data-pricing-trial]')!.textContent = formatMoney(0, currency);
  const packs = packagesForCurrency(currency);
  for (const pack of packs) {
    const card = root.querySelector<HTMLElement>(`[data-pricing-credits="${pack.credits}"]`)!;
    card.querySelector('[data-pricing-amount]')!.textContent = formatMoney(pack.amount_minor, currency);
    card.querySelector('[data-pricing-rate]')!.textContent = formatPerThousand(pack.amount_minor, pack.credits, currency);
    card.querySelector('[data-pricing-saving]')!.textContent = pack.saving ? `${pack.saving} lower unit price` : 'Entry pack';
    card.querySelector<HTMLAnchorElement>('[data-pricing-link]')!.href = '/signup?plan=' + pack.id;
  }
  root.querySelector('[data-pricing-status]')!.textContent = currency === 'inr' ? 'Prices in INR · Pay with UPI' : 'Prices in USD · Pay by card';
  root.querySelector('[data-pricing-note]')!.textContent = `Savings compare the price per 1,000 credits with the ${formatMoney(packs[0].amount_minor, currency)} pack. Sign in to see eligibility, limits, and checkout availability.`;
  root.setAttribute('aria-busy', 'false');
}
