/**
 * In-memory marker for outbound messages the CRM itself just sent
 * through `EvolutionProvider.sender`.
 *
 * Evolution/Baileys echoes every send back through the same
 * `messages.upsert` webhook used for genuine inbound messages, tagged
 * `key.fromMe: true` — there is no way to tell "the CRM sent this" from
 * "someone sent this from the linked phone" at the webhook layer alone.
 * `EvolutionProvider.sender` marks a message id here the instant the
 * provider hands back a `providerMessageId` (before the DB insert even
 * runs); the webhook route checks it first, falling back to a DB lookup
 * (`messages.message_id`) for the case where the webhook echo somehow
 * wins the race against our own insert.
 *
 * Same trade-off as rate-limit.ts: a single Node process holds the Map,
 * so horizontal scale silently defeats it for the *fast* path — the DB
 * fallback in the webhook route is what keeps correctness under that
 * failure mode, this cache is purely a latency optimization to skip the
 * extra query in the common case.
 */

const TTL_MS = 60_000; // generous for a webhook echo round-trip

interface Entry {
  expiresAt: number;
}

const sent = new Map<string, Entry>();

// Opportunistic cleanup, same 1-in-N amortized sweep as rate-limit.ts —
// avoids a background timer while keeping the Map from growing unbounded.
const LIGHT_SWEEP_EVERY = 1000;
let callsSinceSweep = 0;

function sweepExpired(now: number) {
  for (const [id, entry] of sent) {
    if (entry.expiresAt <= now) sent.delete(id);
  }
}

/** Call the instant a provider hands back a `providerMessageId` for a
 *  send the CRM itself initiated. */
export function markSentByCrm(providerMessageId: string): void {
  sent.set(providerMessageId, { expiresAt: Date.now() + TTL_MS });

  callsSinceSweep += 1;
  if (callsSinceSweep >= LIGHT_SWEEP_EVERY) {
    callsSinceSweep = 0;
    sweepExpired(Date.now());
  }
}

/** True when this message id was marked by `markSentByCrm` and hasn't
 *  expired yet. */
export function wasSentByCrm(providerMessageId: string): boolean {
  const entry = sent.get(providerMessageId);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    sent.delete(providerMessageId);
    return false;
  }
  return true;
}

/** Test-only helper — mirrors rate-limit.ts's __resetRateLimitForTests.
 *  Not wired up in production code. */
export function __resetSentByCrmCacheForTests() {
  sent.clear();
  callsSinceSweep = 0;
}
