import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "@/test/helpers/deferred";
import { createMintLookupCache, type MintLookupLoad } from "./mint-lookup-cache";

afterEach(() => {
  vi.useRealTimers();
});

describe("createMintLookupCache", () => {
  it("reuses an answer until its TTL passes, then asks again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const cache = createMintLookupCache<number>(30_000);
    const fetchMissing = vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, 2])));

    await cache.lookup("devnet", ["MintA"], fetchMissing);
    vi.advanceTimersByTime(29_999);
    await expect(cache.lookup("devnet", ["MintA"], fetchMissing)).resolves.toEqual(
      new Map([["MintA", 2]])
    );
    expect(fetchMissing).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await cache.lookup("devnet", ["MintA"], fetchMissing);
    expect(fetchMissing).toHaveBeenCalledTimes(2);
  });

  it("drops expired entries for mints nobody asks about again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const cache = createMintLookupCache<number>(30_000);
    const fetchMissing = vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, 1])));

    await cache.lookup("devnet", ["MintA", "MintB"], fetchMissing);
    vi.advanceTimersByTime(30_000);
    await cache.lookup("devnet", ["MintC"], fetchMissing);

    expect(cache.entryCountForTests()).toBe(1);
  });

  it("asks only for the mints it does not have", async () => {
    const cache = createMintLookupCache<number>(30_000);
    const fetchMissing = vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, 1])));

    await cache.lookup("devnet", ["MintA"], fetchMissing);
    const values = await cache.lookup("devnet", ["MintA", "MintB", "MintB", " "], fetchMissing);

    expect(fetchMissing.mock.calls.map(([mints]) => mints)).toEqual([["MintA"], ["MintB"]]);
    expect(values).toEqual(
      new Map([
        ["MintA", 1],
        ["MintB", 1],
      ])
    );
  });

  it("never keeps a mint the vendor did not answer, or a failed batch", async () => {
    const cache = createMintLookupCache<number>(30_000);
    const unanswered = vi.fn(async () => new Map<string, number>());
    const failing = vi.fn(async () => {
      throw new Error("vendor down");
    });

    await expect(cache.lookup("devnet", ["MintA"], unanswered)).resolves.toEqual(new Map());
    await expect(cache.lookup("devnet", ["MintA"], failing)).resolves.toEqual(new Map());
    const recovered = vi.fn(async () => new Map([["MintA", 3]]));
    await expect(cache.lookup("devnet", ["MintA"], recovered)).resolves.toEqual(
      new Map([["MintA", 3]])
    );
    expect([unanswered, failing, recovered].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("shares one lookup between callers asking at the same time", async () => {
    const cache = createMintLookupCache<number>(30_000);
    let answer: (value: Map<string, number>) => void = () => {};
    const fetchMissing = vi.fn(
      () =>
        new Promise<Map<string, number>>((resolve) => {
          answer = resolve;
        })
    );

    const first = cache.lookup("devnet", ["MintA"], fetchMissing);
    const second = cache.lookup("devnet", ["MintA"], fetchMissing);
    answer(new Map([["MintA", 4]]));

    await expect(Promise.all([first, second])).resolves.toEqual([
      new Map([["MintA", 4]]),
      new Map([["MintA", 4]]),
    ]);
    expect(fetchMissing).toHaveBeenCalledTimes(1);
  });

  it("keeps clusters apart", async () => {
    const cache = createMintLookupCache<string>(60 * 60_000);
    const fetchMissing = vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, "SYM"])));

    await cache.lookup("devnet", ["MintA"], fetchMissing);
    await cache.lookup("mainnet-beta", ["MintA"], fetchMissing);

    expect(fetchMissing).toHaveBeenCalledTimes(2);
  });
});

describe("createMintLookupCache read", () => {
  it("rejects every caller sharing a failed load and keeps nothing", async () => {
    const cache = createMintLookupCache<number>(30_000);
    const pending = deferred<MintLookupLoad<number>>();
    const failing = vi.fn(() => pending.promise);
    const failure = new Error("mint read failed");

    const first = cache.read("devnet", "MintA", failing);
    const second = cache.read("devnet", "MintA", failing);
    pending.reject(failure);

    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(failing).toHaveBeenCalledOnce();
    expect(cache.entryCountForTests()).toBe(0);
    const recovered = vi.fn(async () => ({ value: 6, keep: true }));
    await expect(cache.read("devnet", "MintA", recovered)).resolves.toBe(6);
    expect(recovered).toHaveBeenCalledOnce();
  });

  it("makes one load for callers reading a cold mint at the same time", async () => {
    const cache = createMintLookupCache<number>(30_000);
    const pending = deferred<MintLookupLoad<number>>();
    const load = vi.fn(() => pending.promise);

    const first = cache.read("devnet", "MintA", load);
    const second = cache.read("devnet", "MintA", load);
    pending.resolve({ value: 6, keep: true });

    await expect(Promise.all([first, second])).resolves.toEqual([6, 6]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("reuses a kept value until its TTL passes, then loads again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const cache = createMintLookupCache<number>(30_000);
    const load = vi.fn(async () => ({ value: 6, keep: true }));

    await cache.read("devnet", "MintA", load);
    vi.advanceTimersByTime(29_999);
    await expect(cache.read("devnet", "MintA", load)).resolves.toBe(6);
    expect(load).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1);
    await cache.read("devnet", "MintA", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("answers a load it may not keep to every caller sharing it, then loads again", async () => {
    const cache = createMintLookupCache<number>(30_000);
    const pending = deferred<MintLookupLoad<number>>();
    const load = vi.fn(() => pending.promise);

    const first = cache.read("devnet", "MintA", load);
    const second = cache.read("devnet", "MintA", load);
    pending.resolve({ value: 6, keep: false });

    await expect(Promise.all([first, second])).resolves.toEqual([6, 6]);
    expect(load).toHaveBeenCalledOnce();
    expect(cache.entryCountForTests()).toBe(0);
    const reload = vi.fn(async () => ({ value: 9, keep: false }));
    await expect(cache.read("devnet", "MintA", reload)).resolves.toBe(9);
    expect(reload).toHaveBeenCalledOnce();
  });
});
