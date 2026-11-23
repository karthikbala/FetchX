// A console API key's own limits: credits it may spend per UTC day and per UTC
// month, and when it expires. Set in the console (control_keys, see
// control-identity.mjs); checked when a request is admitted (FetchFront) and a
// batch is submitted, and shown by GET /v1/me. A key's spend is what its
// requests were charged plus what its running requests hold, counted by when
// each request started, across the keys it was rotated from (its lineage), so
// rotating a key does not reset its limits.
import {GatewayError} from '../policy.mjs';

export const KEY_LIMIT_MAX = 100_000_000;
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The UTC day and month that `now` falls in.
export function periodsAt(now = new Date()) {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    credits_per_day: {from: day, to: new Date(day.getTime() + DAY_MS)},
    credits_per_month: {from: month, to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))},
  };
}

const NO_LIMITS = Object.freeze({credits_per_day: null, credits_per_month: null, expires_at: null, room: Infinity, binding: null, held: 0});

// The key's limits and where it stands against them now (db: a pool or a
// client inside a transaction). Null fields when the key has no such limit, or
// for a request made without a console key.
export async function keyLimitState(db, keyId, now = new Date()) {
  if (typeof keyId !== 'string' || !UUID.test(keyId)) return NO_LIMITS;
  const key = (await db.query(`SELECT project, COALESCE(lineage, id) AS lineage, credit_limit_day, credit_limit_month, expires_at
    FROM control_keys WHERE id = $1`, [keyId])).rows[0];
  if (!key) return NO_LIMITS;
  const expiresAt = key.expires_at ? new Date(key.expires_at).toISOString() : null;
  const limits = {credits_per_day: key.credit_limit_day, credits_per_month: key.credit_limit_month};
  if (limits.credits_per_day === null && limits.credits_per_month === null) return {...NO_LIMITS, expires_at: expiresAt};
  const periods = periodsAt(now);
  // A day always lies inside its month, so one pass over the month covers both.
  const spent = (await db.query(`SELECT
      COALESCE(sum(CASE WHEN s.status = 'pending' THEN COALESCE(s.credits_max, 0) ELSE s.credits_charged END)
        FILTER (WHERE s.created_at >= $2), 0)::bigint AS day,
      COALESCE(sum(CASE WHEN s.status = 'pending' THEN COALESCE(s.credits_max, 0) ELSE s.credits_charged END), 0)::bigint AS month,
      COALESCE(sum(COALESCE(s.credits_max, 0)) FILTER (WHERE s.status = 'pending'), 0)::bigint AS held
    FROM fetch_settlements s
    WHERE s.key_id IN (SELECT id::text FROM control_keys WHERE project = $4 AND COALESCE(lineage, id) = $1) AND s.created_at >= $3`,
  [key.lineage, periods.credits_per_day.from, periods.credits_per_month.from, key.project])).rows[0];
  const used = {credits_per_day: Number(spent.day), credits_per_month: Number(spent.month)};
  const state = {expires_at: expiresAt, room: Infinity, binding: null, held: Number(spent.held)};
  for (const name of ['credits_per_day', 'credits_per_month']) {
    const limit = limits[name] === null ? null : Number(limits[name]);
    if (limit === null) {
      state[name] = null;
      continue;
    }
    const remaining = Math.max(0, limit - used[name]);
    state[name] = {limit, used: used[name], remaining, resets_at: periods[name].to.toISOString()};
    if (remaining < state.room) {
      state.room = remaining;
      state.binding = name;
    }
  }
  return state;
}

// What GET /v1/me shows.
export function publicLimits(state) {
  return {credits_per_day: state.credits_per_day, credits_per_month: state.credits_per_month, expires_at: state.expires_at};
}

// The refusal when a key's limit leaves less than the cheapest step needs.
export function keyLimitError(state, needed) {
  const hit = state[state.binding];
  return Object.assign(new GatewayError('key_limit_reached', 402), {details: {limit: state.binding, credits: hit.limit, used: hit.used,
    remaining: hit.remaining, needed, resets_at: hit.resets_at}});
}
