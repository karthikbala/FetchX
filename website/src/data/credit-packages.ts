export type BillingCurrency = 'usd' | 'inr';
export type CreditPackage = { id: string; name: string; amount_minor: number; currency: BillingCurrency; credits: number; saving: string | null };

export const creditPackages: readonly CreditPackage[] = [
  { id: 'credits-10000', name: '10,000 credits', amount_minor: 200, currency: 'usd', credits: 10_000, saving: null },
  { id: 'credits-50000', name: '50,000 credits', amount_minor: 800, currency: 'usd', credits: 50_000, saving: '20%' },
  { id: 'credits-150000', name: '150,000 credits', amount_minor: 2000, currency: 'usd', credits: 150_000, saving: '33.3%' },
  { id: 'credits-1000000', name: '1,000,000 credits', amount_minor: 10000, currency: 'usd', credits: 1_000_000, saving: '50%' },
];
export const inrCreditPackages: readonly CreditPackage[] = [
  { id: 'credits-10000-inr', name: '10,000 credits', amount_minor: 17500, currency: 'inr', credits: 10_000, saving: null },
  { id: 'credits-50000-inr', name: '50,000 credits', amount_minor: 75000, currency: 'inr', credits: 50_000, saving: '14.3%' },
  { id: 'credits-150000-inr', name: '150,000 credits', amount_minor: 180000, currency: 'inr', credits: 150_000, saving: '31.4%' },
  { id: 'credits-1000000-inr', name: '1,000,000 credits', amount_minor: 900000, currency: 'inr', credits: 1_000_000, saving: '48.6%' },
];
export const packagesForCurrency = (currency: BillingCurrency) => currency === 'inr' ? inrCreditPackages : creditPackages;
export const isBillingCurrency = (value: unknown): value is BillingCurrency => value === 'usd' || value === 'inr';
export const isCreditPlanId = (value: unknown): value is string => [...creditPackages, ...inrCreditPackages].some(pack => pack.id === value);
const integer = new Intl.NumberFormat('en-US');
const money = (currency: BillingCurrency, rate = false) => new Intl.NumberFormat(currency === 'inr' ? 'en-IN' : 'en-US', {
  style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: rate ? 2 : currency === 'inr' ? 0 : 2,
  maximumFractionDigits: rate ? 4 : 2,
});
export const formatMoney = (minor: number, currency: BillingCurrency) => money(currency).format(minor / 100);
export const formatPerThousand = (minor: number, credits: number, currency: BillingCurrency) => `${money(currency, true).format(minor / 100 / (credits / 1000))} / 1,000 credits`;
export const formatUsd = (cents: number) => formatMoney(cents, 'usd');
export const formatUsdPerThousand = (cents: number, credits: number) => formatPerThousand(cents, credits, 'usd');
export function formatCredits(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? integer.format(value) : '—';
}
