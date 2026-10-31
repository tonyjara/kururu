/**
 * What a token would cost on the API, as a table somebody read off a page.
 *
 * The user pays a subscription, so no figure made from this is a bill. It is
 * here because list price is the only denomination anybody publishes, and
 * because it is what makes a cache read and an output token addable: five
 * billion tokens mean nothing until the five billion are weighed. Anthropic
 * does not publish how tokens weigh against a plan's limits, and nothing may
 * read this table as if it said.
 *
 * A table in the repository rather than a fetch, because the ledger makes no
 * request of anybody and a price is a fact with a date on it. Dated entries
 * rather than one price per model, because a row is priced as of the moment
 * it was billed, so a price that changes does not rewrite last month. An entry
 * covers everything from its `from` until the model's next one, and the first
 * entry of a model also covers anything older than itself: the page was read
 * in 2026-10 and what a model cost before that is not on it.
 *
 * **A model not in the table has no price, never a guess.** Its tokens are
 * still exact, and `costOf` says null so the row is drawn as unpriced. A gap
 * between an estimate and the figure a program wrote for itself means this
 * file is stale. The `update-models` skill keeps it, beside `LAUNCHERS`.
 *
 * Read from <https://platform.claude.com/docs/en/about-claude/pricing> on
 * 2026-10-31. Dollars per million tokens. Not here: a web search's $10 per
 * thousand, because a billed message's row has no column for it and none of
 * the transcripts of this Mac carry one; Claude Code's own figure does.
 */

export interface ModelPrice {
  input: number;
  write5m: number;
  write1h: number;
  read: number;
  output: number;
}

interface PriceEntry {
  /** The model id without its date or its `[1m]`: see `baseModelId`. */
  model: string;
  /** `YYYY-MM-DD`, in UTC, from which this holds. */
  from: string;
  price: ModelPrice;
  /** A prompt over this many tokens, cache included, pays `price` here for the whole request. */
  over?: { tokens: number; price: ModelPrice };
  /** What fast mode multiplies every kind of token by, on the models that have it. */
  fast?: number;
}

function p(input: number, write5m: number, write1h: number, read: number, output: number): ModelPrice {
  return { input, write5m, write1h, read, output };
}

const READ_ON = "2026-01-01";

export const PRICES: readonly PriceEntry[] = [
  { model: "claude-fable-5-1", from: READ_ON, price: p(10, 12.5, 20, 0.25, 50) },
  { model: "claude-mythos-5-1", from: READ_ON, price: p(10, 12.5, 20, 0.25, 50) },
  { model: "claude-fable-5", from: READ_ON, price: p(10, 12.5, 20, 1, 50) },
  { model: "claude-mythos-5", from: READ_ON, price: p(10, 12.5, 20, 1, 50) },
  { model: "claude-opus-5-5", from: READ_ON, price: p(4, 5, 8, 0.2, 20), fast: 2 },
  { model: "claude-opus-5", from: READ_ON, price: p(5, 6.25, 10, 0.5, 25), fast: 2 },
  { model: "claude-opus-4-8", from: READ_ON, price: p(5, 6.25, 10, 0.5, 25), fast: 2 },
  { model: "claude-opus-4-7", from: READ_ON, price: p(5, 6.25, 10, 0.5, 25) },
  { model: "claude-opus-4-6", from: READ_ON, price: p(5, 6.25, 10, 0.5, 25) },
  { model: "claude-opus-4-5", from: READ_ON, price: p(5, 6.25, 10, 0.5, 25) },
  { model: "claude-opus-4-1", from: READ_ON, price: p(15, 18.75, 30, 1.5, 75) },
  { model: "claude-opus-4", from: READ_ON, price: p(15, 18.75, 30, 1.5, 75) },
  { model: "claude-sonnet-5-5", from: READ_ON, price: p(2, 2.5, 4, 0.1, 10) },
  { model: "claude-sonnet-5", from: READ_ON, price: p(2, 2.5, 4, 0.2, 10) },
  { model: "claude-sonnet-4-6", from: READ_ON, price: p(3, 3.75, 6, 0.3, 15) },
  { model: "claude-sonnet-4-5", from: READ_ON, price: p(3, 3.75, 6, 0.3, 15) },
  { model: "claude-sonnet-4", from: READ_ON, price: p(3, 3.75, 6, 0.3, 15) },
  {
    model: "claude-haiku-5-5",
    from: READ_ON,
    price: p(0.1, 0.125, 0.2, 0.01, 0.5),
    over: { tokens: 100_000, price: p(0.5, 0.625, 1, 0.05, 2.5) },
  },
  { model: "claude-haiku-4-5", from: READ_ON, price: p(1, 1.25, 2, 0.1, 5) },
  { model: "claude-haiku-3-5", from: READ_ON, price: p(0.8, 1, 1.6, 0.08, 4) },
];

/** US-only inference costs this much more on every kind of token. Global routing, the default, costs nothing extra. */
const US_ONLY = 1.1;

/**
 * The name a model is priced under. `claude-opus-5[1m]` is the same model at a
 * longer window, and `claude-haiku-4-5-20251001` is a dated spelling of the
 * same price.
 */
export function baseModelId(id: string): string {
  return id
    .replace(/\[[^\]]*\]/g, "")
    .trim()
    .replace(/-\d{8}$/, "");
}

/** The entry that held for this model at this moment, or null when the table has never heard of it. */
export function priceOf(model: string, at: number): PriceEntry | null {
  const base = baseModelId(model);
  const entries = PRICES.filter((entry) => entry.model === base);
  if (!entries.length) return null;
  const day = new Date(Number.isFinite(at) ? at : 0).toISOString().slice(0, 10);
  let held = entries[0]!;
  for (const entry of entries) if (entry.from <= day && entry.from >= held.from) held = entry;
  return held;
}

export interface BilledTokens {
  input: number;
  write5m: number;
  write1h: number;
  read: number;
  output: number;
}

/** How a request was served, as far as it changes the price. */
export interface BilledAs {
  fast?: boolean;
  usOnly?: boolean;
}

/**
 * A billed message at list price, in dollars, or null for a model the table
 * does not have.
 *
 * Output covers thinking, which is billed as output and is reported inside
 * that count. Nothing billed costs nothing whatever its model, which is what
 * makes Claude Code's `<synthetic>` records a zero and not an unpriced row:
 * no model served them.
 */
export function costOf(model: string, at: number, tokens: BilledTokens, as: BilledAs = {}): number | null {
  const prompt = tokens.input + tokens.write5m + tokens.write1h + tokens.read;
  if (prompt + tokens.output === 0) return 0;
  const entry = priceOf(model, at);
  if (!entry) return null;
  const price = entry.over && prompt > entry.over.tokens ? entry.over.price : entry.price;
  const dollars =
    (tokens.input * price.input + tokens.write5m * price.write5m + tokens.write1h * price.write1h + tokens.read * price.read + tokens.output * price.output) / 1e6;
  return dollars * (as.fast && entry.fast ? entry.fast : 1) * (as.usOnly ? US_ONLY : 1);
}
