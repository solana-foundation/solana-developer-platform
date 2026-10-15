// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIdempotencyKeyStore,
  resetIdempotencyKeyStoresForTests,
} from "@/lib/idempotency-key-store";
import { claimMovementKey } from "./value-movement-tracking";

describe("claimMovementKey", () => {
  const store = createIdempotencyKeyStore("test:private-channels:movement:v1");

  beforeEach(() => {
    sessionStorage.clear();
    resetIdempotencyKeyStoresForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function refuseWrites(): void {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
  }

  it("hands out a key the browser keeps", () => {
    expect(claimMovementKey(store, "deposit")).toEqual(expect.any(String));
  });

  it("refuses a fresh key the browser will not keep, and keeps nothing for it", () => {
    refuseWrites();

    expect(claimMovementKey(store, "deposit")).toBeNull();
    expect(store.has("deposit")).toBe(false);
  });

  // Jina (#2333): a persisted key whose rewrite failed refused the unchanged
  // retry, though the key it needed was already in storage.
  it("sends a retry under its persisted key after storage starts refusing writes", () => {
    const kept = store.claim("deposit").key;
    refuseWrites();

    expect(claimMovementKey(store, "deposit")).toBe(kept);
    // A new movement's key cannot be kept, so it is still not sent.
    expect(claimMovementKey(store, "withdrawal")).toBeNull();
  });
});
