export const creditPackages = [
  { id: 'credits-10000', name: '10,000 credits', amount_minor: 200, credits: 10_000, saving: null },
  { id: 'credits-50000', name: '50,000 credits', amount_minor: 800, credits: 50_000, saving: '20%' },
  { id: 'credits-150000', name: '150,000 credits', amount_minor: 2000, credits: 150_000, saving: '33.3%' },
  { id: 'credits-1000000', name: '1,000,000 credits', amount_minor: 10000, credits: 1_000_000, saving: '50%' },
] as const;

const integer = new Intl.NumberFormat('en-US');
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usdRate = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
export const formatUsd = (cents: number) => usd.format(cents / 100);
export const formatUsdPerThousand = (cents: number, credits: number) => `${usdRate.format(cents / 100 / (credits / 1000))} / 1,000 credits`;
export function formatCredits(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? integer.format(value) : '—';
}
