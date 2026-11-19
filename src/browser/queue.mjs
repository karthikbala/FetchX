// Waits for a free browser, first come first served, until the request's
// deadline. One gateway process owns all browser slots (it holds the runner
// lock), so an in-memory queue is enough.
import {GatewayError} from '../policy.mjs';
import {runCapture} from './runner.mjs';

const RETRY_MS = 250;
const TIMEOUT_WINDOW_MS = 300_000;

export class BrowserSlots {
  // pool: BrowserWorkerPool or null (then captures run on this host).
  constructor({pool = null, localConcurrency = 1, runner = runCapture} = {}) {
    this.pool = pool;
    this.localConcurrency = localConcurrency;
    this.runner = runner;
    this.localActive = 0;
    this.waiting = [];
    // For the autoscaler (pool metrics): who is waiting, how many hold a slot,
    // and recent waits that ran out.
    this.waiters = new Set();
    this.active = 0;
    this.timeouts = [];
  }

  metrics(now = Date.now()) {
    this.timeouts = this.timeouts.filter(at => now - at < TIMEOUT_WINDOW_MS);
    const oldest = Math.min(now, ...[...this.waiters].map(waiter => waiter.since));
    return {pending: this.waiters.size, active: this.active, oldest_wait_ms: now - oldest, recent_timeouts: this.timeouts.length};
  }

  #held(slot) {
    this.active++;
    let released = false;
    return {run: slot.run, release: () => {
      if (released) return;
      released = true;
      this.active--;
      slot.release();
    }};
  }

  #tryLocal() {
    if (this.localActive >= this.localConcurrency) return null;
    this.localActive++;
    let released = false;
    return {
      run: (input, hooks, options) => this.runner(input, hooks, options),
      release: () => {
        if (released) return;
        released = true;
        this.localActive--;
        this.#wake();
      },
    };
  }

  async #tryPool(runtime) {
    try {
      const slot = await this.pool.acquire(runtime);
      return {run: slot.run, release: () => { slot.release(); this.#wake(); }};
    } catch (error) {
      if (error instanceof GatewayError && error.code === 'browser_capacity') return null;
      throw error;
    }
  }

  #wake() {
    const next = this.waiting.shift();
    next?.();
  }

  // Resolves to {run, release}; release() must always be called.
  async acquire(runtime, {deadline}) {
    const waiter = {since: Date.now()};
    this.waiters.add(waiter);
    try {
      return this.#held(await this.#wait(runtime, deadline));
    } finally {
      this.waiters.delete(waiter);
    }
  }

  async #wait(runtime, deadline) {
    for (;;) {
      const slot = this.pool ? await this.#tryPool(runtime) : this.#tryLocal();
      if (slot) return slot;
      const remaining = deadline - Date.now();
      if (remaining <= RETRY_MS) {
        this.timeouts.push(Date.now());
        throw new GatewayError('browser_capacity', 503);
      }
      // Pool workers free up without telling us, so also poll.
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          const index = this.waiting.indexOf(wake);
          if (index >= 0) this.waiting.splice(index, 1);
          resolve();
        }, Math.min(RETRY_MS * 4, remaining - RETRY_MS));
        const wake = () => { clearTimeout(timer); resolve(); };
        this.waiting.push(wake);
      });
    }
  }
}
