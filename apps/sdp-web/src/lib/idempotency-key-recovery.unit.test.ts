// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyIdempotencyKeyOutcome,
  createIdempotencyKeyStore,
  resetIdempotencyKeyStoresForTests,
  resolveHeldIdempotencyKey,
} from "./idempotency-key-store";

describe("unresolved Treasury intent identity", () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetIdempotencyKeyStoresForTests();
  });
  afterEach(() => vi.useRealTimers());

  it.each([401, 403, 429])("preserves an ambiguous submit key after a later %s", async (status) => {
    const store = createIdempotencyKeyStore("test:treasury-recovery");
    const original = store.claim("same-intent");
    applyIdempotencyKeyOutcome(store, "same-intent", { ok: false, status: null });
    applyIdempotencyKeyOutcome(store, "same-intent", { ok: false, status });
    const retry = await resolveHeldIdempotencyKey(
      store,
      "same-intent",
      new AbortController().signal,
      async () => ({ kind: "unavailable" })
    );
    expect(retry).toMatchObject({ kind: "key", key: original });
  });

  it("does not replace an unresolved intent just because fifteen minutes elapsed", async () => {
    vi.useFakeTimers();
    const store = createIdempotencyKeyStore("test:treasury-recovery");
    const original = store.claim("same-intent");
    applyIdempotencyKeyOutcome(store, "same-intent", { ok: false, status: 504 });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const retry = await resolveHeldIdempotencyKey(
      store,
      "same-intent",
      new AbortController().signal,
      async () => ({ kind: "unavailable" })
    );
    expect(retry).toMatchObject({ kind: "key", key: original });
  });
  it("pins before transport and restores the identity on reload after the draft TTL", () => {
    vi.useFakeTimers();
    const store = createIdempotencyKeyStore("test:reload");
    const key = store.claim("intent");
    expect(store.beginSubmission("intent")).toEqual({ wasUncertain: false });
    resetIdempotencyKeyStoresForTests();
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    const reloaded = createIdempotencyKeyStore("test:reload");
    expect(reloaded.claim("intent")).toBe(key);
    expect(reloaded.beginSubmission("intent")).toEqual({ wasUncertain: true });
  });

  it("refuses submission when its pending marker cannot persist", () => {
    const store = createIdempotencyKeyStore("test:quota");
    store.claim("intent");
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    try {
      expect(store.beginSubmission("intent")).toBeNull();
    } finally {
      write.mockRestore();
    }
  });

  it("keeps legacy expired entries because the old writer did not distinguish drafts", () => {
    sessionStorage.setItem(
      "test:legacy",
      JSON.stringify([{ id: "intent", value: "old-key", createdAt: 0 }])
    );
    expect(createIdempotencyKeyStore("test:legacy").claim("intent")).toBe("old-key");
  });

  it.each(["deposit", "withdrawal"])(
    "allows three acknowledged %s intents with identical terms",
    (direction) => {
      const store = createIdempotencyKeyStore(`test:back-to-back:${direction}`);
      const keys: string[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        keys.push(store.claim("same-wallet-vault-amount"));
        const submission = store.beginSubmission("same-wallet-vault-amount");
        expect(submission).toEqual({ wasUncertain: false });
        applyIdempotencyKeyOutcome(
          store,
          "same-wallet-vault-amount",
          { ok: true, status: 200, data: { kind: "submitted" } },
          submission?.wasUncertain
        );
      }
      expect(new Set(keys).size).toBe(3);
    }
  );
  it("preserves an approval-held key across authorization failures and releases explicit same-key denial", () => {
    const store = createIdempotencyKeyStore("test:approval-recovery");
    const key = store.claim("intent");
    store.hold("intent");
    const attempt = store.beginSubmission("intent");
    expect(attempt).toEqual({ wasUncertain: true });
    applyIdempotencyKeyOutcome(store, "intent", { ok: false, status: 403 }, attempt?.wasUncertain);
    expect(store.claim("intent")).toBe(key);
    applyIdempotencyKeyOutcome(store, "intent", {
      ok: false,
      status: 403,
      body: { error: { details: { intentOutcome: "denied", idempotencyKey: key } } },
    });
    expect(store.claim("intent")).not.toBe(key);
  });
});
