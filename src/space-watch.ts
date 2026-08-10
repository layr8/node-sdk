// Space watch — LAYR8-869/DEBT-055. Cross-language contract:
// ~/Developments/contracts/sdk-space-watch.md.
//
// The broker (`mcp/src/broker/{wallet.ts,discovery.ts,daemon.ts}`) and Loom
// (`agents/loom/lib/loom/mcp/catalog.ex`) each grew their own poll + diff +
// notify loop for "does my MCP tool surface still look the same." Both watch
// two independent signals — a wallet (VG/credential set) and a resource set
// (Space directory MCP Instance cards) — polled, not pushed, because nothing
// on the wire tells an SDK "your wallet changed" or "a resource came up."
// `SpaceWatcher` is the one place that mechanism lives for Node/TypeScript
// consumers; `layr8` (elixir_sdk)'s `Layr8.SpaceWatcher` GenServer is the
// equivalent for Elixir. What a "change" MEANS to notify (an MCP wire
// notification for the broker, a stale-cache flag for Loom) stays entirely a
// consumer decision — this module only owns poll/diff/debounce.
//
// Signature computation: `SpaceWatcher` is generic over the fetched value (`W`
// for wallet, `R` for resources) rather than assuming any particular domain
// shape (a `Cred[]`, a directory card list, …) — bundling that in would tie
// the watcher to `mcp`'s VG/discovery model and make it useless to any other
// consumer. The default `walletSignature`/`resourceSignature` — this module's
// exported `orderIndependentSignature` — covers the common case where the
// fetched value already IS the list of stable ids (`string[]`): sorted,
// deduped, joined. A caller whose fetched value is a richer object (the
// broker's `Cred[]`, resource objects with both `key` and `did`) passes its
// own `walletSignature`/`resourceSignature` reducer; the watcher only ever
// compares the resulting strings for equality and hands the ORIGINAL fetched
// value to the change callback, so the callback still gets full fidelity (the
// broker's `onResourcesChange` needs the whole `Resource[]` to update its
// routing table, not just the signature it changed to).

/** Sorted, deduped, comma-joined identity of a set of ids — order-independent. */
export function orderIndependentSignature(items: readonly string[]): string {
  return [...new Set(items)].sort().join(",");
}

/** Default signature for a fetched value: works when `T` is already `string[]`. */
function defaultSignature<T>(value: T): string {
  return Array.isArray(value) ? orderIndependentSignature(value.map(String)) : String(value);
}

export type SpaceWatchSignal = "wallet" | "resources";

export interface SpaceWatcherOptions<W = string[], R = string[]> {
  /** Returns the caller's current credential set. Called on every wallet poll. */
  fetchWallet: () => Promise<W>;
  /** Returns the caller's current resource set. Called on every resource poll. */
  fetchResources: () => Promise<R>;
  /** Called with the new wallet value when its signature changes. Never called
   * on the first successful poll — that seeds the baseline silently. */
  onWalletChange?: (wallet: W) => void;
  /** Called with the new resource value when its signature changes (after the
   * empty-result debounce, if applicable). Never called on the first
   * successful poll. */
  onResourcesChange?: (resources: R) => void;
  /** Reduces a fetched wallet value to an order-independent identity string.
   * Defaults to `orderIndependentSignature` over `value` when it's an array. */
  walletSignature?: (wallet: W) => string;
  /** Reduces a fetched resource value to an order-independent identity string.
   * MUST return `""` for "no resources" — that's what drives the empty-result
   * debounce. Defaults to `orderIndependentSignature` over `value` when it's
   * an array. */
  resourceSignature?: (resources: R) => string;
  /** Called (not thrown) when a fetch rejects, so the consumer can log it. The
   * watcher always retains the last-accepted signature and retries next poll —
   * a transient fetch failure must never read as "everything disappeared." */
  onError?: (signal: SpaceWatchSignal, err: unknown) => void;
  /** Default 15_000. */
  walletPollMs?: number;
  /** Default 60_000. */
  resourcePollMs?: number;
  /** Injectable timer, so both intervals are unit-testable without a real
   * clock (e.g. `vi.useFakeTimers()` swaps the globals these default to). */
  setIntervalFn?: (handler: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

const DEFAULT_WALLET_POLL_MS = 15_000;
const DEFAULT_RESOURCE_POLL_MS = 60_000;

/**
 * Take this resource poll, or ride out a possibly-transient empty result? A
 * directory (or any resource source) answering with nothing is not an error,
 * but it's just as likely to be a momentary blip (a keepalive miss evicting a
 * card that comes straight back) as a real teardown, and acting on it strips
 * every resource-derived tool from every live session. Anything non-empty
 * applies at once; so does an empty result when there was nothing to lose.
 * Ported verbatim from the broker's `acceptsDiscovery`
 * (`mcp/src/broker/daemon.ts`).
 */
export function acceptsResourcePoll(isEmpty: boolean, hadResources: boolean, emptyStreak: number): boolean {
  return !isEmpty || !hadResources || emptyStreak >= 2;
}

/**
 * Watches two independent signals — a wallet and a resource set — on
 * independent poll intervals, diffs each against its own last-accepted
 * signature, and calls back on a real change. See the contract at
 * `~/Developments/contracts/sdk-space-watch.md` for the full semantics this
 * implements; this class is the boundary-tested reference.
 */
export class SpaceWatcher<W = string[], R = string[]> {
  private readonly opts: Required<
    Pick<SpaceWatcherOptions<W, R>, "fetchWallet" | "fetchResources" | "walletPollMs" | "resourcePollMs">
  > &
    SpaceWatcherOptions<W, R>;

  private readonly walletSig: (wallet: W) => string;
  private readonly resourceSig: (resources: R) => string;
  private readonly setIntervalFn: (handler: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;

  private lastWalletSig: string | undefined;
  private lastResourceSig: string | undefined;
  private resourceEmptyStreak = 0;

  private walletHandle: unknown;
  private resourceHandle: unknown;
  private started = false;

  constructor(options: SpaceWatcherOptions<W, R>) {
    this.opts = {
      ...options,
      walletPollMs: options.walletPollMs ?? DEFAULT_WALLET_POLL_MS,
      resourcePollMs: options.resourcePollMs ?? DEFAULT_RESOURCE_POLL_MS,
    };
    this.walletSig = options.walletSignature ?? defaultSignature;
    this.resourceSig = options.resourceSignature ?? defaultSignature;
    this.setIntervalFn = options.setIntervalFn ?? ((h, ms) => setInterval(h, ms));
    this.clearIntervalFn = options.clearIntervalFn ?? ((h) => clearInterval(h as NodeJS.Timeout));
  }

  /** Seed both baselines immediately, then poll each on its own interval. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.walletTick();
    void this.resourceTick();
    this.walletHandle = this.setIntervalFn(() => void this.walletTick(), this.opts.walletPollMs);
    this.resourceHandle = this.setIntervalFn(() => void this.resourceTick(), this.opts.resourcePollMs);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.walletHandle !== undefined) this.clearIntervalFn(this.walletHandle);
    if (this.resourceHandle !== undefined) this.clearIntervalFn(this.resourceHandle);
    this.walletHandle = undefined;
    this.resourceHandle = undefined;
  }

  /** Force an immediate out-of-cycle wallet check, e.g. right after minting a grant. */
  async refreshWallet(): Promise<void> {
    await this.walletTick();
  }

  /** Force an immediate out-of-cycle resource check, e.g. right after registering a pod. */
  async refreshResources(): Promise<void> {
    await this.resourceTick();
  }

  private async walletTick(): Promise<void> {
    let value: W;
    try {
      value = await this.opts.fetchWallet();
    } catch (err) {
      this.opts.onError?.("wallet", err);
      return; // retain last-accepted signature; retry next poll
    }
    const sig = this.walletSig(value);
    const isFirstPoll = this.lastWalletSig === undefined;
    if (!isFirstPoll && sig !== this.lastWalletSig) this.opts.onWalletChange?.(value);
    this.lastWalletSig = sig; // wallet never debounces empty
  }

  private async resourceTick(): Promise<void> {
    let value: R;
    try {
      value = await this.opts.fetchResources();
    } catch (err) {
      this.opts.onError?.("resources", err);
      return; // retain last-accepted signature; retry next poll
    }
    const sig = this.resourceSig(value);
    const isEmpty = sig === "";
    this.resourceEmptyStreak = isEmpty ? this.resourceEmptyStreak + 1 : 0;
    const hadResources = this.lastResourceSig !== undefined && this.lastResourceSig !== "";
    if (!acceptsResourcePoll(isEmpty, hadResources, this.resourceEmptyStreak)) {
      return; // ride out one empty blip; last-accepted signature is untouched
    }
    const isFirstPoll = this.lastResourceSig === undefined;
    if (!isFirstPoll && sig === this.lastResourceSig) return;
    this.lastResourceSig = sig;
    if (!isFirstPoll) this.opts.onResourcesChange?.(value);
  }
}
