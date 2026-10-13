// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIdempotencyKeyStore,
  resetIdempotencyKeyStoresForTests,
  settleIdempotencyKey,
} from "./idempotency-key-store";

describe("unresolved Treasury intent identity", () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetIdempotencyKeyStoresForTests();
  });
  afterEach(() => vi.useRealTimers());

  it.each([401, 403, 429])("preserves an ambiguous submit key after a later %s", (status) => {
    const store = createIdempotencyKeyStore("test:treasury-recovery");
    const original = store.claim("same-intent").key;
    settleIdempotencyKey(store, "same-intent", { status: null, replayed: false });
    settleIdempotencyKey(store, "same-intent", { status, replayed: false });
    expect(store.claim("same-intent").key).toBe(original);
  });

  it("does not replace an unresolved intent just because fifteen minutes elapsed", () => {
    vi.useFakeTimers();
    const store = createIdempotencyKeyStore("test:treasury-recovery");
    const original = store.claim("same-intent").key;
    settleIdempotencyKey(store, "same-intent", { status: 504, replayed: false });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    expect(store.claim("same-intent").key).toBe(original);
  });

  it("keeps the key before transport and restores it on reload, however much later", () => {
    vi.useFakeTimers();
    const store = createIdempotencyKeyStore("test:reload");
    const { key, persisted } = store.claim("intent");
    expect(persisted).toBe(true);
    resetIdempotencyKeyStoresForTests();
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    const reloaded = createIdempotencyKeyStore("test:reload");
    expect(reloaded.has("intent")).toBe(true);
    expect(reloaded.claim("intent").key).toBe(key);
  });

  it("reports a key whose write cannot persist, so a money flow refuses to submit", () => {
    const store = createIdempotencyKeyStore("test:quota");
    store.claim("intent");
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    try {
      expect(store.claim("intent").persisted).toBe(false);
    } finally {
      write.mockRestore();
    }
  });

  it("keeps entries an earlier build wrote, whatever extra fields they carry", () => {
    sessionStorage.setItem(
      "test:legacy",
      JSON.stringify([{ id: "intent", value: "old-key", createdAt: 0, expiresAt: 1 }])
    );
    expect(createIdempotencyKeyStore("test:legacy").claim("intent").key).toBe("old-key");
  });

  it.each(["deposit", "withdrawal"])(
    "allows three acknowledged %s intents with identical terms",
    (direction) => {
      const store = createIdempotencyKeyStore(`test:back-to-back:${direction}`);
      const keys: string[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        keys.push(store.claim("same-wallet-vault-amount").key);
        settleIdempotencyKey(store, "same-wallet-vault-amount", { status: 200, replayed: false });
      }
      expect(new Set(keys).size).toBe(3);
    }
  );
});
