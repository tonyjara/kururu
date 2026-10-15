/**
 * What a web provider is, and the list they put themselves on.
 *
 * A provider is anything that can answer some of the four web tools — a
 * Firecrawl, a search API, the step that hands the call back to the agent's
 * own tools — and it is one file in `providers/` that implements this and
 * calls `registerWebProvider` when it is loaded. Nothing else is touched to
 * add one: the build collects the directory (`webProviders` in
 * `desktop/build.mjs`), the chain finds it on the list and gives it a place
 * in the order, and the Settings page draws it from what `view` describes,
 * because the page knows fields, not providers.
 *
 * A provider holds its own secrets, on the OpenRouter key's terms
 * (`openrouter.ts`): a file of its own in `~/.config/kururu`, 0600, read at
 * the moment of each request, never logged, never sent to a client, never
 * backed up. `web-<id>.json` is the name to use, because the backup page
 * already says those stay (`providerFile`).
 *
 * The chain decides the order, the switches, the timeouts and what counts as
 * a failure; a provider decides only how to do a call and what it costs. So
 * a provider never sleeps out a dead host, never retries, and never judges a
 * page — it returns what it got and the chain reads it (`resultVerdict`).
 */
import type { WebCall, WebCapability, WebFailure, WebField, WebHealth, WebReadout, WebResult, WebSettings, WebStep } from "../../../shared/web";

export interface ProviderDeps {
  /** What the window draws of this provider has changed. */
  changed(): void;
  /** How many windows are open: a figure nobody will see is not worth a request. */
  clients(): number;
  /** The chain's page limit, as it stands. */
  pageLimit(): number;
}

export interface RunContext {
  /** Aborted when the chain stops waiting. A provider passes it to every request it makes. */
  signal: AbortSignal;
  /** How long this step has, the provider's own timeout or what is left of the call's, whichever is less. */
  timeoutMs: number;
  /** The agent that asked, by name, or null. */
  agent: string | null;
  /** What the chain has done with this call so far. */
  trail: readonly WebStep[];
  /** The providers after this one that would be tried for this call: on, set up, able to. */
  after: readonly { id: string; label: string; paid: boolean }[];
  pageLimit: number;
}

/**
 * How one step went. `served` and `failed` are the usual two; `pass` is a
 * step that stood aside for this call (the hand-back, when the agent says its
 * own tools failed); `stop` ends the chain with a sentence for the agent,
 * which is how a step hands the call back.
 */
export type StepAnswer =
  | { outcome: "served"; result: WebResult; credits?: number; notes?: string[] }
  | { outcome: "failed"; failure: WebFailure; reason: string; credits?: number }
  | { outcome: "pass"; reason: string }
  | { outcome: "stop"; text: string };

/** What the Settings page draws of a provider, less what the chain knows itself. */
export interface ProviderView {
  summary: string;
  fields: WebField[];
  readouts: WebReadout[];
  about: string[];
  links: { label: string; href: string }[];
  /** What the Test button does, or null for nothing to test. */
  test: string | null;
}

export interface WebProvider {
  readonly id: string;
  readonly label: string;
  readonly kind: "service" | "handback";
  /** Costs the user money per call. Said in the tool descriptions and on the page. */
  readonly paid: boolean;
  /** On or off before the user has said. */
  defaultEnabled(): boolean;
  can(): readonly WebCapability[];
  /** Set up enough to be tried: an address, a key. */
  ready(): boolean;
  /** How long a call may take before the chain stops waiting. */
  timeoutMs(call: WebCall): number;
  run(call: WebCall, ctx: RunContext): Promise<StepAnswer>;
  /** Whether it answers, without spending anything. */
  health(): Promise<WebHealth>;
  view(): ProviderView;
  /** A field from Settings, checked. Throws the sentence the page prints. */
  setField?(name: string, value: unknown): Promise<void>;
  clearField?(name: string): void;
  /** The Settings page's Test: a sentence of what came back. Throws one when it failed. */
  test?(): Promise<string>;
  /** On the chain's tick, while a window is open: figures worth keeping fresh. */
  refresh?(): Promise<void>;
  /** What this provider's older settings say about the chain's, read once, when `web.json` is first written. */
  seed?(): Partial<Pick<WebSettings, "pageLimit">>;
  close?(): void;
}

export interface WebProviderDef {
  id: string;
  /** Where it goes in the default order, lowest first. The user's order wins once there is one. */
  rank: number;
  create(deps: ProviderDeps): WebProvider;
}

const registry = new Map<string, WebProviderDef>();

/** Put a provider on the list. A provider file calls this when it is loaded, and that is all it takes. */
export function registerWebProvider(def: WebProviderDef): void {
  if (registry.has(def.id)) throw new Error(`two web providers are called ${def.id}`);
  registry.set(def.id, def);
}

/** Everything registered, in the default order. */
export function webProviderDefs(): WebProviderDef[] {
  return [...registry.values()].sort((a, b) => a.rank - b.rank);
}

/** The file a provider keeps its settings and secrets in: `web-<id>.json`, which the backup leaves behind. */
export function providerFile(id: string): string {
  return `web-${id}.json`;
}
