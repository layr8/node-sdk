import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { SpaceWatcher, orderIndependentSignature, acceptsResourcePoll } from "../src/space-watch.js";

/**
 * Space watch — boundary test for the semantics every Layr8 SDK's watcher
 * shares: dual poll, order-independent signature diff, the resource
 * empty-result debounce, and error handling that never wipes retained
 * state. Uses vitest's fake timers rather than the watcher's injectable timer
 * hooks — `vi.useFakeTimers()` swaps the same globals the watcher defaults
 * to, so no extra plumbing is needed to make both poll intervals
 * deterministic.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("orderIndependentSignature", () => {
  it("is the same for the same set in any order", () => {
    expect(orderIndependentSignature(["b", "a", "c"])).toBe(orderIndependentSignature(["c", "b", "a"]));
  });

  it("dedupes", () => {
    expect(orderIndependentSignature(["a", "a", "b"])).toBe(orderIndependentSignature(["a", "b"]));
  });

  it("is empty string for an empty set", () => {
    expect(orderIndependentSignature([])).toBe("");
  });
});

describe("acceptsResourcePoll", () => {
  it("accepts anything non-empty immediately", () => {
    expect(acceptsResourcePoll(false, true, 0)).toBe(true);
  });

  it("accepts an empty result when there was nothing to lose", () => {
    expect(acceptsResourcePoll(true, false, 1)).toBe(true);
  });

  it("rejects a single empty poll when we previously had resources", () => {
    expect(acceptsResourcePoll(true, true, 1)).toBe(false);
  });

  it("accepts on the second consecutive empty poll", () => {
    expect(acceptsResourcePoll(true, true, 2)).toBe(true);
  });
});

describe("SpaceWatcher — baseline seeding", () => {
  it("does not call onWalletChange or onResourcesChange on the first successful poll", async () => {
    const onWalletChange = vi.fn();
    const onResourcesChange = vi.fn();
    const watcher = new SpaceWatcher({
      fetchWallet: async () => ["vg-1"],
      fetchResources: async () => ["did:mcp:a"],
      onWalletChange,
      onResourcesChange,
    });

    watcher.start();
    await vi.waitFor(() => {});

    expect(onWalletChange).not.toHaveBeenCalled();
    expect(onResourcesChange).not.toHaveBeenCalled();
    watcher.stop();
  });
});

describe("SpaceWatcher — wallet signal", () => {
  it("notifies with the new value when the signature actually changes", async () => {
    let wallet = ["vg-1"];
    const onWalletChange = vi.fn();
    const watcher = new SpaceWatcher({
      fetchWallet: async () => wallet,
      fetchResources: async () => [],
      onWalletChange,
      walletPollMs: 1000,
    });

    watcher.start();
    await flushMicrotasks();
    expect(onWalletChange).not.toHaveBeenCalled(); // baseline seed

    wallet = ["vg-1", "vg-2"];
    await vi.advanceTimersByTimeAsync(1000);

    expect(onWalletChange).toHaveBeenCalledTimes(1);
    expect(onWalletChange).toHaveBeenCalledWith(["vg-1", "vg-2"]);
    watcher.stop();
  });

  it("is order-independent — a shuffled-but-equal set does not notify", async () => {
    let wallet = ["vg-1", "vg-2"];
    const onWalletChange = vi.fn();
    const watcher = new SpaceWatcher({
      fetchWallet: async () => wallet,
      fetchResources: async () => [],
      onWalletChange,
      walletPollMs: 1000,
    });

    watcher.start();
    await flushMicrotasks();

    wallet = ["vg-2", "vg-1"]; // same set, different order
    await vi.advanceTimersByTimeAsync(1000);

    expect(onWalletChange).not.toHaveBeenCalled();
    watcher.stop();
  });

  it("does NOT debounce an empty result — a real emptying notifies immediately", async () => {
    let wallet = ["vg-1"];
    const onWalletChange = vi.fn();
    const watcher = new SpaceWatcher({
      fetchWallet: async () => wallet,
      fetchResources: async () => [],
      onWalletChange,
      walletPollMs: 1000,
    });

    watcher.start();
    await flushMicrotasks();

    wallet = [];
    await vi.advanceTimersByTimeAsync(1000);

    expect(onWalletChange).toHaveBeenCalledTimes(1);
    expect(onWalletChange).toHaveBeenCalledWith([]);
    watcher.stop();
  });

  it("a fetch error retains the last-accepted signature and does not notify or throw", async () => {
    let shouldFail = false;
    const onWalletChange = vi.fn();
    const onError = vi.fn();
    const watcher = new SpaceWatcher({
      fetchWallet: async () => {
        if (shouldFail) throw new Error("wallet read failed");
        return ["vg-1"];
      },
      fetchResources: async () => [],
      onWalletChange,
      onError,
      walletPollMs: 1000,
    });

    watcher.start();
    await flushMicrotasks(); // baseline: ["vg-1"]

    shouldFail = true;
    await vi.advanceTimersByTimeAsync(1000); // errors — retains signature

    shouldFail = false;
    await vi.advanceTimersByTimeAsync(1000); // same value as baseline again

    expect(onWalletChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("wallet", expect.any(Error));
    watcher.stop();
  });

  it("refreshWallet() forces an immediate out-of-cycle check", async () => {
    let wallet = ["vg-1"];
    const onWalletChange = vi.fn();
    const watcher = new SpaceWatcher({
      fetchWallet: async () => wallet,
      fetchResources: async () => [],
      onWalletChange,
      walletPollMs: 60_000, // long enough that only a manual refresh could trigger it
    });

    watcher.start();
    await flushMicrotasks();

    wallet = ["vg-1", "vg-2"];
    await watcher.refreshWallet();

    expect(onWalletChange).toHaveBeenCalledTimes(1);
    watcher.stop();
  });
});

describe("SpaceWatcher — resource signal (empty debounce)", () => {
  it("ignores a single empty poll and does not notify", async () => {
    let resources = ["did:mcp:a"];
    const onResourcesChange = vi.fn();
    const watcher = new SpaceWatcher({
      fetchWallet: async () => [],
      fetchResources: async () => resources,
      onResourcesChange,
      resourcePollMs: 1000,
    });

    watcher.start();
    await flushMicrotasks(); // baseline: ["did:mcp:a"]

    resources = []; // one blip
    await vi.advanceTimersByTimeAsync(1000);

    expect(onResourcesChange).not.toHaveBeenCalled();
    watcher.stop();
  });

  it("accepts and notifies after two consecutive empty polls", async () => {
    let resources = ["did:mcp:a"];
    const onResourcesChange = vi.fn();
    const watcher = new SpaceWatcher({
      fetchWallet: async () => [],
      fetchResources: async () => resources,
      onResourcesChange,
      resourcePollMs: 1000,
    });

    watcher.start();
    await flushMicrotasks(); // baseline

    resources = [];
    await vi.advanceTimersByTimeAsync(1000); // 1st empty — ignored
    await vi.advanceTimersByTimeAsync(1000); // 2nd empty — accepted

    expect(onResourcesChange).toHaveBeenCalledTimes(1);
    expect(onResourcesChange).toHaveBeenCalledWith([]);
    watcher.stop();
  });

  it("applies a shrink to a still-non-empty set immediately, no debounce", async () => {
    let resources = ["did:mcp:a", "did:mcp:b"];
    const onResourcesChange = vi.fn();
    const watcher = new SpaceWatcher({
      fetchWallet: async () => [],
      fetchResources: async () => resources,
      onResourcesChange,
      resourcePollMs: 1000,
    });

    watcher.start();
    await flushMicrotasks();

    resources = ["did:mcp:a"];
    await vi.advanceTimersByTimeAsync(1000);

    expect(onResourcesChange).toHaveBeenCalledTimes(1);
    expect(onResourcesChange).toHaveBeenCalledWith(["did:mcp:a"]);
    watcher.stop();
  });

  it("a fetch error retains the last-accepted signature and does not notify or throw", async () => {
    let shouldFail = false;
    const onResourcesChange = vi.fn();
    const onError = vi.fn();
    const watcher = new SpaceWatcher({
      fetchWallet: async () => [],
      fetchResources: async () => {
        if (shouldFail) throw new Error("directory unreachable");
        return ["did:mcp:a"];
      },
      onResourcesChange,
      onError,
      resourcePollMs: 1000,
    });

    watcher.start();
    await flushMicrotasks();

    shouldFail = true;
    await vi.advanceTimersByTimeAsync(1000);

    expect(onResourcesChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("resources", expect.any(Error));
    watcher.stop();
  });

  it("refreshResources() forces an immediate out-of-cycle check", async () => {
    let resources = ["did:mcp:a"];
    const onResourcesChange = vi.fn();
    const watcher = new SpaceWatcher({
      fetchWallet: async () => [],
      fetchResources: async () => resources,
      onResourcesChange,
      resourcePollMs: 60_000,
    });

    watcher.start();
    await flushMicrotasks();

    resources = ["did:mcp:a", "did:mcp:b"];
    await watcher.refreshResources();

    expect(onResourcesChange).toHaveBeenCalledTimes(1);
    watcher.stop();
  });
});

/** Let the microtask queue (pending promises from `start()`'s immediate seed ticks) drain. */
async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}
