/**
 * How long one address gets to answer when this process opens a connection.
 *
 * Why a module for one call: Node's default is 250 ms, and it is a limit that
 * reads like a fallback's tuning and behaves like an outage. When a name has an
 * A and an AAAA record Node tries them one after the other, giving every address
 * but the last that long, so on a Mac whose IPv6 has no route the IPv4 attempt
 * is timed out at 250 ms, IPv6 fails at once, and the request dies in under a
 * third of a second with `ETIMEDOUT, EHOSTUNREACH`. Telegram is about 240 ms
 * away from where this runs: the margin was ten milliseconds, and on 2026-10-31
 * that held Kuru's replies in the queue for nine minutes while curl, which
 * races the two families, and a long poll already connected were both fine.
 *
 * Why here and not on Telegram's requests: Node's `fetch` takes no such option
 * without bringing in undici's own Agent, and the limit is wrong for every far
 * address, not this one. OpenRouter's balance and the web providers go through
 * the same `fetch`.
 *
 * Rejected: turning `autoSelectFamily` off, which is what the error seems to ask
 * for. Then the first address is the only one, and a network where only IPv6
 * works cannot reach anything. Keeping the fallback and widening its patience
 * costs a silently dropped first family at most this long, per new connection.
 *
 * Two and a half seconds because it has to outlast a lost SYN, which macOS
 * sends again after one second, on a link that is already slow.
 */
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

export const CONNECT_ATTEMPT_MS = 2_500;

setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_MS);
