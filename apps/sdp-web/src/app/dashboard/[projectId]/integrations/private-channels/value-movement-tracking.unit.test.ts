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

  it("refuses to send under a kept key it cannot rewrite, and keeps that key", () => {
    const kept = store.claim("deposit").key;
    refuseWrites();

    expect(claimMovementKey(store, "deposit")).toBeNull();
    vi.restoreAllMocks();
    expect(store.claim("deposit").key).toBe(kept);
  });
});
