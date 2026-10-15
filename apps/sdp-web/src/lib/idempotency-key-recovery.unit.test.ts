// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchResultAnswer } from "./idempotency";
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
    settleIdempotencyKey(store, "same-intent", original, {
      status: null,
      replayed: false,
      code: null,
    });
    settleIdempotencyKey(store, "same-intent", original, { status, replayed: false, code: null });
    expect(store.claim("same-intent").key).toBe(original);
  });

  it("retires a key on a 409 whose outcome is unknown, so the next press mints a fresh one", () => {
    const store = createIdempotencyKeyStore("test:outcome-unknown");
    const conflict = (code: string) => fetchResultAnswer({ ok: false, status: 409, code });
    const original = store.claim("same-intent").key;

    expect(
      settleIdempotencyKey(store, "same-intent", original, conflict("IDEMPOTENCY_KEY_IN_FLIGHT"))
    ).toBe(false);
    expect(store.claim("same-intent").key).toBe(original);
    expect(
      settleIdempotencyKey(
        store,
        "same-intent",
        original,
        conflict("IDEMPOTENCY_KEY_OUTCOME_UNKNOWN")
      )
    ).toBe(true);
    expect(store.claim("same-intent").key).not.toBe(original);
  });

  it("does not replace an unresolved intent just because fifteen minutes elapsed", () => {
    vi.useFakeTimers();
    const store = createIdempotencyKeyStore("test:treasury-recovery");
    const original = store.claim("same-intent").key;
    settleIdempotencyKey(store, "same-intent", original, {
      status: 504,
      replayed: false,
      code: null,
    });
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

  it("reports a new key whose write cannot persist, and a stored key as persisted", () => {
    const store = createIdempotencyKeyStore("test:quota");
    const kept = store.claim("intent").key;
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    try {
      expect(store.claim("other-intent").persisted).toBe(false);
      expect(store.claim("intent")).toEqual({ key: kept, persisted: true });
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
        const { key } = store.claim("same-wallet-vault-amount");
        keys.push(key);
        settleIdempotencyKey(store, "same-wallet-vault-amount", key, {
          status: 200,
          replayed: false,
          code: null,
        });
      }
      expect(new Set(keys).size).toBe(3);
    }
  );
});
