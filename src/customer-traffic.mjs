const RATE_USD_PER_GB = 2;
const BYTES_PER_GB = 1_000_000_000;
const NANODOLLARS_PER_USD = 1_000_000_000n;

function validBytes(value) {
 return Number.isSafeInteger(value) && value >= 0;
}

function formatUsd(nanodollars) {
 const dollars = nanodollars / NANODOLLARS_PER_USD;
 const fraction = nanodollars % NANODOLLARS_PER_USD;
 return `${dollars}.${String(fraction).padStart(9, '0')}`;
}

function charge({status, bytes, maxBillableBytes}, rateUsdPerGb) {
 if (!['measured', 'no_traffic', 'unknown', 'pending'].includes(status)) {
  throw new TypeError('customer_traffic_status_invalid');
 }
 if (maxBillableBytes !== undefined && !validBytes(maxBillableBytes)) {
  throw new TypeError('customer_traffic_cap_invalid');
 }
 if (status === 'measured' && !validBytes(bytes)) {
  throw new TypeError('customer_traffic_bytes_invalid');
 }

 let meteredBytes = null;
 let billableBytes = null;
 let costUsd = null;
 if (status === 'no_traffic') {
  meteredBytes = 0;
 } else if (status === 'measured') {
  meteredBytes = bytes;
 }
 if (meteredBytes !== null) {
  billableBytes = Math.min(meteredBytes, maxBillableBytes ?? meteredBytes);
  // A dollar rate per decimal GB is the same integer number of nanodollars
  // per byte. Preserve those units until formatting the final amount.
  const nanodollars = BigInt(billableBytes) * BigInt(rateUsdPerGb);
  costUsd = formatUsd(nanodollars);
 }

 return {
  currency: 'USD',
  rate_usd_per_gb: rateUsdPerGb,
  bytes_per_gb: BYTES_PER_GB,
  basis: 'bidirectional_proxy_bytes',
  status,
  metered_bytes: meteredBytes,
  billable_bytes: billableBytes,
  cost_usd: costUsd
 };
}

// Integer arithmetic preserves sub-microdollar charges without hop rounding.
export function residentialTrafficCharge(input) {
 return charge(input, RATE_USD_PER_GB);
}

export function residentialTrafficReservation(bytes) {
 const maximum = residentialTrafficCharge({status: 'measured', bytes});
 const maximumNanodollars = BigInt(bytes) * BigInt(RATE_USD_PER_GB);
 const maximumMicrodollars = (maximumNanodollars + 999n) / 1000n;
 return {
  currency: maximum.currency,
  rate_usd_per_gb: maximum.rate_usd_per_gb,
  bytes_per_gb: maximum.bytes_per_gb,
  basis: maximum.basis,
  reserved_bytes: bytes,
  max_cost_usd: maximum.cost_usd,
  max_estimated_micro_usd: Number(maximumMicrodollars)
 };
}

// Historical rows have no admission snapshot and remain unpriced. Completion
// uses the saved rate, never a current configuration lookup.
export function finishResidentialTrafficCharge(admitted, {
 dispatched, unknown = false, partial = false, bytes, maxBillableBytes
}) {
 if (!admitted) return null;
 if (admitted.currency !== 'USD' || admitted.bytes_per_gb !== BYTES_PER_GB ||
     !Number.isSafeInteger(admitted.rate_usd_per_gb) || admitted.rate_usd_per_gb < 0) {
  throw new TypeError('customer_traffic_admission_invalid');
 }

 let status = 'measured';
 if (!dispatched) {
  status = 'no_traffic';
 } else if (unknown || partial || !validBytes(bytes)) {
  status = 'unknown';
 }
 return charge({status, bytes, maxBillableBytes}, admitted.rate_usd_per_gb);
}
