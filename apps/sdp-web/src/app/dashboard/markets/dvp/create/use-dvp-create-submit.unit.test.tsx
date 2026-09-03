// @vitest-environment jsdom

/**
 * The create request, and above all its idempotency key.
 *
 * The key has to do two opposite things: make a double submit a replay, and
 * make a genuinely different trade a different request. Getting the second one
 * wrong is not a missed optimisation — the API compares a replay's fingerprint
 * against the stored one and refuses a mismatch, so a key that ignores a field
 * the fingerprint includes turns a valid trade into
 * "Idempotency key already used with different request payload".
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DvpCreateRequest } from "./use-dvp-create-submit";
import { useDvpCreateSubmit } from "./use-dvp-create-submit";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const LEGACY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function request(overrides: Partial<DvpCreateRequest> = {}): DvpCreateRequest {
  return {
    amountA: "1000",
    amountB: "2000",
    counterparty: "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg",
    expiry: "2027-01-01",
    mintA: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
    mintB: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE",
    refString: "",
    sdpSide: "a",
    tokenProgramA: T22,
    tokenProgramB: T22,
    walletId: "cwlt_leg",
    ...overrides,
  };
}

/** Submits once and reports the Idempotency-Key that went out. */
async function keyFor(overrides: Partial<DvpCreateRequest> = {}): Promise<string> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: { trade: { id: "dvp_1" } } }),
  });
  vi.stubGlobal("fetch", fetchMock);

  const { result } = renderHook(() => useDvpCreateSubmit());
  await act(async () => {
    await result.current.submit(request(overrides));
  });

  const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
  return headers["Idempotency-Key"];
}

describe("useDvpCreateSubmit idempotency key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is stable for the same trade, so a double submit replays", async () => {
    expect(await keyFor()).toBe(await keyFor());
  });

  // Each of these was previously absent from the key while being present in the
  // API's fingerprint, so two distinct trades collided and the second was
  // refused. One case per field, because a single combined case would still
  // pass with all but one of them restored.
  describe("distinguishes trades that differ only by", () => {
    const base = keyFor();

    it.each([
      ["the asset mint", { mintA: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE" }],
      ["the cash mint", { mintB: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1" }],
      ["the side SDP takes", { sdpSide: "b" as const }],
      ["the asset token program", { tokenProgramA: LEGACY }],
      ["the cash token program", { tokenProgramB: LEGACY }],
      ["the reference", { refString: "invoice-42" }],
    ])("%s", async (_label, overrides) => {
      expect(await keyFor(overrides)).not.toBe(await base);
    });
  });

  // The fields that were already covered, kept under test so a refactor of the
  // digest cannot quietly drop one.
  describe("still distinguishes trades that differ by", () => {
    it.each([
      ["the wallet", { walletId: "cwlt_other" }],
      ["the counterparty", { counterparty: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn" }],
      ["the asset amount", { amountA: "1001" }],
      ["the cash amount", { amountB: "2001" }],
      ["the expiry", { expiry: "2027-01-02" }],
    ])("%s", async (_label, overrides) => {
      expect(await keyFor(overrides)).not.toBe(await keyFor());
    });
  });

  // A pasted mint carries no program and defaults to Token-2022 at submit. The
  // key must reflect what is SENT, or an explicit T22 and a pasted address
  // would hash differently while creating the identical trade.
  it("treats an unspecified token program as the Token-2022 default it sends", async () => {
    expect(await keyFor({ tokenProgramA: null })).toBe(await keyFor({ tokenProgramA: T22 }));
  });
});
