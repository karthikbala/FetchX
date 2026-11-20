// Sticky residential sessions and pacing for browser steps, after the rules a
// production crawl behind DataDome taught (cloak-setup):
//
// - IP reputation decides most walls, and a residential session (one exit IP)
//   that got a browser through to a host is the most valuable thing FetchX
//   has for that host. It is kept, with the device identity it used, and the
//   next browser step for the host reuses it: one browser at a time per
//   session, never shared by two at once.
// - A session is retired after `rotateAfter` pages (walls cluster at ~60 pages
//   per session; rotating at 40 avoids them) or `maxAgeMs`, and dropped at the
//   first wall, rate limit, or change of exit IP.
// - Pages on one session are paced `sessionGapMs` apart (4 s was tolerated;
//   faster was rate-flagged), and on hosts that have challenged FetchX before,
//   browser steps from all sessions are spaced `hostGapMs` apart, so a burst of
//   requests never reaches the site at once.
//
// Kept in memory: one gateway process owns all browser work, and a restart
// only means fresh draws until sessions prove themselves again. Only routing
// data is kept (host, provider, country, session id, exit IP, device
// identity): never cookies, URLs or anything a caller sent.
import {setTimeout as sleep} from 'node:timers/promises';

export const SESSION_DEFAULTS = Object.freeze({sessionGapMs: 4000, hostGapMs: 1000, rotateAfter: 40, maxAgeMs: 25 * 60_000,
  maxPerHost: 8, maxHosts: 5000});
// Pacing never waits so long that the step cannot finish before the deadline.
const STEP_RESERVE_MS = 45_000;

export function sessionSettings(config) {
  const settings = {...SESSION_DEFAULTS, ...config.browser?.sessions};
  for (const [name, value] of Object.entries(settings)) {
    if (!Number.isSafeInteger(value) || value < 0) settings[name] = SESSION_DEFAULTS[name];
  }
  return settings;
}

const keyOf = ({host, provider, country}) => `${host}|${provider}|${country ?? ''}`;

export class StickySessions {
  constructor(config, {now = Date.now, wait = sleep, random = Math.random} = {}) {
    Object.assign(this, {settings: sessionSettings(config), now, wait, random});
    this.sessions = new Map();
    this.hostNext = new Map();
  }

  #live(key) {
    const now = this.now();
    const {rotateAfter, maxAgeMs} = this.settings;
    const list = (this.sessions.get(key) ?? []).filter(s => s.busy || (s.pages < rotateAfter && now - s.since < maxAgeMs));
    if (list.length) this.sessions.set(key, list);
    else this.sessions.delete(key);
    return list;
  }

  // A known-good session for this host, provider and country, leased to one
  // step, or null when there is none free (the step draws a fresh one).
  lease(where) {
    const free = this.#live(keyOf(where)).filter(s => !s.busy).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (!free) return null;
    free.busy = true;
    return {session: free.session, ip: free.ip, identity: free.identity, pages: free.pages, lastUsedAt: free.lastUsedAt};
  }

  // Of `providers`, the one holding a free known-good session for this host
  // (the most recently used), or null. The first browser step of a request
  // starts there, so a session that got through is not passed over for a
  // fresh draw on another provider.
  keptProvider({host, country}, providers) {
    let best = null;
    for (const provider of providers) {
      for (const kept of this.#live(keyOf({host, provider, country}))) {
        if (!kept.busy && (!best || kept.lastUsedAt > best.at)) best = {provider, at: kept.lastUsedAt};
      }
    }
    return best?.provider ?? null;
  }

  // Records the step's outcome on its session. `passed` keeps (or adds) the
  // session; anything the site said against it drops the session.
  // `neutral` (nothing reached the site) only frees it.
  settle(where, {session, ip = null, identity = null}, outcome) {
    const key = keyOf(where);
    const list = this.sessions.get(key) ?? [];
    const index = list.findIndex(s => s.session === session);
    const entry = index >= 0 ? list[index] : null;
    if (outcome === 'neutral') {
      if (entry) entry.busy = false;
      return;
    }
    if (outcome !== 'passed' || (entry?.ip && ip && entry.ip !== ip)) {
      if (index >= 0) list.splice(index, 1);
      if (!list.length) this.sessions.delete(key);
      return;
    }
    const now = this.now();
    if (entry) {
      Object.assign(entry, {busy: false, pages: entry.pages + 1, lastUsedAt: now, ip: ip ?? entry.ip,
        identity: identity ?? entry.identity});
      return;
    }
    if (list.length >= this.settings.maxPerHost) return;
    if (!this.sessions.has(key) && this.sessions.size >= this.settings.maxHosts) {
      this.sessions.delete(this.sessions.keys().next().value);
    }
    list.push({session, ip, identity, pages: 1, since: now, lastUsedAt: now, busy: false});
    this.sessions.set(key, list);
  }

  // Waits for the host's and the session's pace. Returns the milliseconds waited.
  async pace({host, guarded = false, lease = null, deadline = Infinity}) {
    const now = this.now();
    const {sessionGapMs, hostGapMs} = this.settings;
    let at = now;
    if (guarded) at = Math.max(at, this.hostNext.get(host) ?? 0);
    // A little jitter: a steady machine rhythm is itself a signal.
    if (lease) at = Math.max(at, lease.lastUsedAt + sessionGapMs + Math.floor(this.random() * 1500));
    at = Math.min(at, Math.max(now, deadline - STEP_RESERVE_MS));
    if (guarded) {
      this.hostNext.set(host, at + hostGapMs);
      if (this.hostNext.size > this.settings.maxHosts) this.hostNext.delete(this.hostNext.keys().next().value);
    }
    const waited = Math.max(0, at - now);
    if (waited) await this.wait(waited);
    return waited;
  }
}
