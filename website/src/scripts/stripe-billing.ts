// Hosted billing leaves payment details with Stripe. A saved operation key and
// its plan ID allow recovery after a lost response or a return from Checkout.
import { formatCredits, formatMoney, formatPerThousand, isBillingCurrency, type BillingCurrency } from '../data/credit-packages';

type Mode = 'test' | 'live';
type Plan = { id: string; name: string; amount_minor: number; currency: BillingCurrency; credits: number; can_purchase?: boolean };
type Pending = { key: string; planId: string; state?: string; currency?: BillingCurrency; amount_minor?: number; credits?: number };
type Purchase = Omit<Plan, 'id'> & { plan_id: string; status: 'paid' | 'test_paid_unapplied' | 'reversed'; paid_at: string };
type Billing = {
  mode: Mode;
  currency: BillingCurrency;
  plans: Plan[];
  purchases?: Purchase[];
  pending_checkout?: { idempotency_key: string; plan_id: string; state: string; currency?: BillingCurrency; amount_minor?: number; credits?: number } | null;
  can_checkout: boolean;
  can_resume_checkout?: boolean;
  checkout_unavailable_reason?: string;
  payment_hold?: boolean;
};
type Context = {
  project: string;
  stripe: Billing;
  pending: Pending | null;
  returnHint: string | null;
  notice: string;
  busy: string;
  poll: ReturnType<typeof setTimeout> | undefined;
  pollsRemaining: number;
};
type Options = {
  request: (path: string, options?: { method?: string; body?: Record<string, unknown>; timeout?: number }) => Promise<Record<string, unknown>>;
  refreshAccounting: (project: string) => Promise<unknown>;
  canInteract: () => boolean;
  preferredPlan: string | null;
};
const keyPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const validKey = (value: unknown): value is string => typeof value === 'string' && keyPattern.test(value);
const validPlanId = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
const checkoutMessages = new Map([
  ['creating', 'A checkout attempt is saved. Check its status or resume the same checkout.'],
  ['awaiting_payment', 'This checkout is awaiting payment. You can resume the saved session.'],
  ['awaiting_webhook', 'Payment confirmation is processing. FetchX will update this project when the payment is verified.'],
  ['complete', 'Checkout has completed. FetchX is still verifying payment for this project.'],
  ['expired', 'The saved checkout has expired. You can start a new checkout when billing is available.'],
  ['paid', 'Payment confirmed. Your paid credit balance has been updated.'],
  ['test_paid_unapplied', 'Test payment confirmed. Your paid credit balance is unchanged.'],
  ['payment_failed', 'Stripe reports a payment failure. Check the saved checkout status before continuing.'],
  ['failed', 'Payment failed. No credits were added. You can start a new checkout when billing is available.'],
  ['reversed', 'Stripe reports a payment reversal. Review your paid credit balance and purchase history.'],
  ['payment_hold', 'Billing is on hold. Contact FetchX to review the payment before starting another checkout.'],
  ['reconciliation_required', 'This checkout needs review before it can be resumed. Check its saved status or contact FetchX.'],
  ['missing', 'The saved checkout is still unconfirmed. Check its status again before starting another purchase.'],
]);
const terminal = new Set(['expired', 'paid', 'test_paid_unapplied', 'payment_failed', 'failed', 'reversed']);
const resumable = new Set(['creating', 'awaiting_payment', 'missing']);
const purchaseLabels = new Map([['paid', 'Paid'], ['test_paid_unapplied', 'Test payment'], ['reversed', 'Reversed']]);
const matchesPaymentMode = (state: string, mode: Mode) => state === 'paid' ? mode === 'live' : state !== 'test_paid_unapplied' || mode === 'test';

function isPlan(value: unknown): value is Plan {
  const plan = value as Plan | null;
  return !!plan && validPlanId(plan.id) && typeof plan.name === 'string' && plan.name.length > 0 && plan.name.length <= 80 &&
    Number.isSafeInteger(plan.amount_minor) && plan.amount_minor > 0 && isBillingCurrency(plan.currency) &&
    Number.isSafeInteger(plan.credits) && plan.credits > 0;
}
function readBilling(value: unknown): Billing | null {
  const billing = value as Billing | null;
  if (!billing || (billing.mode !== 'test' && billing.mode !== 'live') || !Array.isArray(billing.plans) ||
      !isBillingCurrency(billing.currency) || !billing.plans.every(plan => isPlan(plan) && plan.currency === billing.currency)) return null;
  return billing;
}
function hostedCheckoutUrl(value: unknown, mode: Mode) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.origin === 'https://checkout.stripe.com' && !url.username && !url.password && !url.search &&
        new RegExp(`^/c/pay/cs_${mode}_[A-Za-z0-9]{1,200}$`).test(url.pathname)) return url.href;
  } catch { /* Ignore invalid hosted URLs. */ }
  return null;
}
function errorCode(error: unknown) {
  return error instanceof Error && 'code' in error ? error.code : '';
}

export function mountStripeBilling(root: HTMLElement, options: Options) {
  const find = <T extends HTMLElement = HTMLElement>(name: string) => root.querySelector<T>(`[data-stripe-${name}]`)!;
  const mode = find('mode'), modeHelp = find('mode-help'), plans = find('plans');
  const status = find('status'), error = find('error'), history = find('history');
  const purchases = find('purchases');
  const check = find<HTMLButtonElement>('check'), resume = find<HTMLButtonElement>('resume');
  let current: Context | null = null;
  let planButtons: { plan: Plan; button: HTMLButtonElement }[] = [];
  const url = new URL(window.location.href);
  let returnHint = url.searchParams.get('checkout');
  if (returnHint === 'success' || returnHint === 'cancelled') {
    url.searchParams.delete('checkout');
    window.history.replaceState(window.history.state, '', url);
  } else returnHint = null;

  const active = (context: Context) => current === context && options.canInteract();
  const path = (context: Context) => `/projects/${encodeURIComponent(context.project)}/billing/stripe`;
  const storageKey = (context: Context) => `fetchx-pending-checkout:${context.stripe.mode}:${context.project}`;
  function savedCheckout(context: Context): Pending | null {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey(context)) || 'null');
      return validKey(saved?.idempotency_key) && validPlanId(saved?.plan_id)
        ? { key: saved.idempotency_key, planId: saved.plan_id } : null;
    }
    catch { return null; }
  }
  function remember(context: Context, pending: Pending) {
    try {
      sessionStorage.setItem(storageKey(context), JSON.stringify({ idempotency_key: pending.key, plan_id: pending.planId }));
      const saved = savedCheckout(context);
      if (saved?.key !== pending.key || saved.planId !== pending.planId) throw new Error();
    } catch { throw new Error('Enable browser session storage so FetchX can retain the checkout key before sending it.'); }
  }
  function forget(context: Context, key: string) {
    try { if (savedCheckout(context)?.key === key) sessionStorage.removeItem(storageKey(context)); }
    catch { /* A retained key can safely be checked again. */ }
  }
  function serverPending(billing: Billing): Pending | null {
    const pending = billing.pending_checkout;
    return validKey(pending?.idempotency_key) && validPlanId(pending?.plan_id)
      ? { key: pending.idempotency_key, planId: pending.plan_id, state: pending.state, ...(isBillingCurrency(pending.currency) ? { currency: pending.currency, amount_minor: pending.amount_minor, credits: pending.credits } : {}) } : null;
  }
  function showError(message: string) {
    error.textContent = message;
    error.hidden = !message;
  }
  const salesAvailable = (stripe: Billing) => stripe.plans.length > 0 && stripe.payment_hold !== true && !stripe.checkout_unavailable_reason;
  const canBuy = (stripe: Billing, planId: string) => stripe.plans.some(plan => plan.id === planId && plan.can_purchase === true);
  function canResume(context: Context) {
    const { stripe, pending } = context;
    const remote = serverPending(stripe);
    return !!pending && stripe.payment_hold !== true && resumable.has(pending.state || '') &&
      (remote ? remote.key === pending.key && stripe.can_resume_checkout === true : salesAvailable(stripe) && canBuy(stripe, pending.planId));
  }
  const readinessMessages = new Map([
    ['stripe_currency_unavailable', 'INR checkout is currently unavailable. Please check back before starting a purchase.'],
    ['paid_credit_route_unavailable', 'Checkout will open when a paid route is ready for this project.'],
    ['paid_credit_capacity_unavailable', 'Paid route capacity is currently unavailable for this project. Check back before starting another checkout.'],
    ['paid_credit_payment_hold', 'Billing is on hold. Contact FetchX to review this project’s paid credits.'],
  ]);
  function render(context: Context) {
    const { pending, stripe, busy } = context;
    const canStart = salesAvailable(stripe) && stripe.can_checkout === true && !pending && stripe.plans.some(plan => plan.can_purchase === true);
    const actionsDisabled = !!busy || !active(context);
    check.hidden = !pending;
    resume.hidden = !canResume(context);
    check.disabled = resume.disabled = actionsDisabled;
    resume.textContent = pending?.currency ? `Resume saved ${pending.currency.toUpperCase()} checkout` : 'Resume saved checkout';
    for (const { plan, button } of planButtons) {
      button.hidden = !canStart || plan.can_purchase !== true;
      button.disabled = actionsDisabled;
    }
    status.textContent = busy || context.notice ||
      readinessMessages.get(stripe.checkout_unavailable_reason || '') ||
      (pending && checkoutMessages.get(pending.state || '')) ||
      (pending ? 'A checkout key is saved. Check its status to continue.' : canStart ? 'Choose a package to continue to Stripe Checkout.' :
        'Paid credit checkout is currently unavailable for this project.');
  }
  function configure(context: Context) {
    const stripe = context.stripe;
    mode.textContent = stripe.mode === 'test' ? 'STRIPE SANDBOX' : 'LIVE BILLING';
    modeHelp.textContent = stripe.mode === 'test'
      ? 'Sandbox payments use Stripe test payment details and leave project paid credits unchanged.'
      : stripe.currency === 'inr'
        ? 'Prices and payment are in INR. Pay with UPI in Stripe Checkout. Paid credits have no scheduled expiration.'
        : 'Prices and payment are in USD. Pay by card in Stripe Checkout. Paid credits have no scheduled expiration.';
    purchases.replaceChildren();
    const savedPurchases = Array.isArray(stripe.purchases) ? stripe.purchases : [];
    for (const purchase of savedPurchases) {
      const purchaseStatus = purchaseLabels.get(purchase?.status);
      if (!purchaseStatus || !matchesPaymentMode(purchase.status, stripe.mode) || !validPlanId(purchase.plan_id) || !isBillingCurrency(purchase.currency) ||
          !Number.isSafeInteger(purchase.amount_minor) || !Number.isSafeInteger(purchase.credits) ||
          typeof purchase.paid_at !== 'string' || !Number.isFinite(Date.parse(purchase.paid_at))) continue;
      const item = document.createElement('li');
      const day = new Date(purchase.paid_at).toLocaleDateString();
      item.textContent = `${day} · ${formatCredits(purchase.credits)} credits · ${formatMoney(purchase.amount_minor, purchase.currency)} · ${purchaseStatus}`;
      purchases.append(item);
    }
    history.hidden = !purchases.childElementCount;
    plans.replaceChildren();
    planButtons = stripe.plans.map(plan => {
      const card = document.createElement('article');
      card.className = 'pp-stripe-plan';
      if (plan.id === options.preferredPlan) card.classList.add('pp-stripe-plan-preferred');
      const name = document.createElement('h3'), price = document.createElement('p'), total = document.createElement('p');
      name.textContent = plan.name;
      price.className = 'pp-stripe-price';
      price.textContent = formatPerThousand(plan.amount_minor, plan.credits, plan.currency);
      total.textContent = `${formatCredits(plan.credits)} credits for ${formatMoney(plan.amount_minor, plan.currency)}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pp-button pp-button-secondary';
      button.dataset.stripePlan = plan.id;
      button.textContent = `Choose ${plan.name}`;
      button.addEventListener('click', () => { void checkout(context, plan.id); });
      card.append(name, price, total);
      const entry = stripe.plans.reduce((first, item) => item.credits < first.credits ? item : first, plan);
      const saving = Math.round((1 - plan.amount_minor / plan.credits / (entry.amount_minor / entry.credits)) * 1000) / 10;
      if (saving > 0) {
        const discount = document.createElement('p');
        discount.textContent = `${saving}% lower unit price than the entry pack`;
        card.append(discount);
      }
      card.append(button);
      if (plan.can_purchase !== true && !stripe.checkout_unavailable_reason) {
        const unavailable = document.createElement('p');
        unavailable.textContent = 'Currently unavailable for this project.';
        card.append(unavailable);
      }
      plans.append(card);
      return { plan, button };
    });
    render(context);
  }
  function poll(context: Context) {
    if (context.pollsRemaining < 1) return;
    clearTimeout(context.poll);
    context.pollsRemaining--;
    context.poll = setTimeout(() => { void lookup(context, true); }, 2000);
  }
  async function refresh(context: Context) {
    const updated = readBilling(await options.refreshAccounting(context.project));
    if (!active(context)) return;
    if (!updated || updated.mode !== context.stripe.mode) { reset(); return; }
    context.stripe = updated;
    if (!context.pending) context.pending = serverPending(updated);
    configure(context);
  }
  async function applyStatus(context: Context, pending: Pending, response: Record<string, unknown>) {
    if (response.mode !== context.stripe.mode || typeof response.state !== 'string' || !checkoutMessages.has(response.state) || !matchesPaymentMode(response.state, context.stripe.mode) ||
        response.plan_id !== undefined && response.plan_id !== pending.planId) {
      throw new Error('FetchX could not verify the checkout response. Check the saved checkout status.');
    }
    if (response.currency !== undefined) {
      const expectedCurrency = pending.planId.endsWith('-inr') ? 'inr' : 'usd';
      if (!isBillingCurrency(response.currency) || response.currency !== expectedCurrency ||
          !Number.isSafeInteger(response.amount_minor) || Number(response.amount_minor) <= 0 ||
          !Number.isSafeInteger(response.credits) || Number(response.credits) <= 0)
        throw new Error('FetchX could not verify the saved checkout currency. Check its status before continuing.');
      pending.currency = response.currency;
      pending.amount_minor = Number(response.amount_minor);
      pending.credits = Number(response.credits);
    }
    const state = response.state;
    pending.state = state;
    context.notice = '';
    if (terminal.has(state)) {
      forget(context, pending.key);
      context.pending = null;
      context.notice = checkoutMessages.get(state)!;
      // Hide purchase actions until a fresh catalog and purchase history are confirmed.
      context.stripe = { ...context.stripe, can_checkout: false };
      render(context);
      await refresh(context);
      return;
    }
    if (state === 'complete' || state === 'awaiting_webhook' || context.returnHint === 'success' && state === 'awaiting_payment') {
      context.notice = checkoutMessages.get('awaiting_webhook')!;
      poll(context);
    } else if (context.returnHint === 'cancelled' && state === 'awaiting_payment') {
      context.notice = 'You returned from Stripe without completing checkout. The saved checkout is still available.';
    }
  }
  async function action(context: Context, loading: string, run: () => Promise<void>, fallback: string) {
    if (!active(context) || context.busy) return;
    clearTimeout(context.poll);
    context.busy = loading;
    showError('');
    render(context);
    try { await run(); }
    catch (error) {
      if (active(context)) showError(error instanceof Error && !('code' in error) ? error.message : fallback);
    } finally {
      if (active(context)) { context.busy = ''; render(context); }
    }
  }
  async function lookup(context: Context, background = false) {
    const pending = context.pending;
    if (!pending) return;
    if (!background) context.pollsRemaining = 6;
    await action(context, background ? context.notice : 'Checking saved checkout…', async () => {
      let result;
      try { result = await options.request(`${path(context)}/checkout/${pending.key}`); }
      catch (error) {
        if (errorCode(error) !== 'stripe_checkout_not_found') throw error;
        if (active(context)) {
          const remote = serverPending(context.stripe);
          if (remote && remote.key !== pending.key) context.pending = remote;
          else pending.state = 'missing';
          context.notice = '';
        }
        return;
      }
      if (active(context)) await applyStatus(context, pending, result);
    }, 'FetchX could not check the saved checkout. Try checking its status again.');
  }
  async function checkout(context: Context, planId: string) {
    const previous = context.pending;
    const stripe = context.stripe;
    if (previous ? !canResume(context) || previous.planId !== planId
                 : !salesAvailable(stripe) || stripe.can_checkout !== true || !canBuy(stripe, planId)) return;
    await action(context, 'Opening Stripe Checkout…', async () => {
      const key = previous?.key || crypto.randomUUID();
      const pending: Pending = { key, planId, state: 'creating' };
      remember(context, pending);
      context.pending = pending;
      context.returnHint = null;
      context.notice = '';
      context.pollsRemaining = 6;
      let result;
      try { result = await options.request(`${path(context)}/checkout`, { method: 'POST', body: { plan_id: planId, idempotency_key: key }, timeout: 40_000 }); }
      catch (error) {
        if (!active(context)) return;
        if (['stripe_currency_unavailable', 'stripe_checkout_currency_mismatch', 'paid_credit_route_unavailable', 'paid_credit_capacity_unavailable', 'paid_credit_payment_hold'].includes(String(errorCode(error)))) {
          await refresh(context);
          return;
        }
        if (errorCode(error) === 'stripe_checkout_reconciliation_required') { pending.state = 'reconciliation_required'; return; }
        if (errorCode(error) === 'stripe_checkout_already_open') {
          // A concurrent tab can win checkout creation. Prefer the server's saved attempt.
          forget(context, key);
          context.pending = null;
          context.stripe = { ...context.stripe, can_checkout: false };
          await refresh(context);
          return;
        }
        pending.state = undefined;
        throw error;
      }
      if (!active(context)) return;
      await applyStatus(context, pending, result);
      if (!active(context) || result.state !== 'awaiting_payment') return;
      const destination = hostedCheckoutUrl(result.checkout_url, context.stripe.mode);
      if (!destination) throw new Error('The saved checkout returned an invalid Stripe link. Check its status before resuming.');
      window.location.assign(destination);
    }, 'Checkout could not be confirmed. Check the saved checkout before continuing.');
  }
  check.addEventListener('click', () => { if (current) void lookup(current); });
  resume.addEventListener('click', () => { if (current?.pending?.planId) void checkout(current, current.pending.planId); });
  function reset() {
    clearTimeout(current?.poll);
    current = null;
    root.hidden = true;
    plans.replaceChildren();
    planButtons = [];
    purchases.replaceChildren();
    status.textContent = '';
    showError('');
  }
  function setProject(project: string, value: unknown) {
    reset();
    const stripe = readBilling(value);
    if (!stripe || !options.canInteract()) return;
    const context: Context = { project, stripe, pending: null, returnHint, notice: '', busy: '', poll: undefined, pollsRemaining: 6 };
    returnHint = null;
    const saved = savedCheckout(context), pending = serverPending(stripe);
    context.pending = saved && pending?.key !== saved.key ? saved : pending;
    current = context;
    root.hidden = false;
    configure(context);
    if (context.pending) void lookup(context);
  }
  return { reset, setProject };
}
