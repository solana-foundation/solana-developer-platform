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
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { DvpCreateRequest } from "./use-dvp-create-submit";
import { useDvpCreateSubmit } from "./use-dvp-create-submit";

// Submitting confirms in words, so the hook needs the catalog they come from.
function withI18n({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const LEGACY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WALLET_A = "cwlt_a";
const ADDRESS_A = "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn";
const ADDRESS_B = "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg";

function request(overrides: Partial<DvpCreateRequest> = {}): DvpCreateRequest {
  return {
    parties: {
      a: { ref: { walletId: WALLET_A }, address: ADDRESS_A },
      b: { ref: { address: ADDRESS_B }, address: ADDRESS_B },
    },
    payerWalletId: null,
    amountA: "1000",
    amountB: "2000",
    expiry: "2027-01-01",
    mintA: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
    mintB: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE",
    refString: "",
    tokenProgramA: T22,
    tokenProgramB: T22,
    // Empty is the ordinary trade: each party is paid at its own address.
    userASettlementDestination: "",
    userBSettlementDestination: "",
    ...overrides,
  };
}

/** Submits once and reports the request that went out. */
async function requestFor(overrides: Partial<DvpCreateRequest> = {}): Promise<{
  idempotencyKey: string;
  body: Record<string, unknown>;
}> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: { trade: { id: "dvp_1" } } }),
  });
  vi.stubGlobal("fetch", fetchMock);

  const { result } = renderHook(() => useDvpCreateSubmit(), { wrapper: withI18n });
  await act(async () => {
    await result.current.submit(request(overrides));
  });

  const call = fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string>; body?: string };
  return {
    idempotencyKey: call.headers?.["Idempotency-Key"] ?? "",
    body: call.body ? (JSON.parse(call.body) as Record<string, unknown>) : {},
  };
}

describe("useDvpCreateSubmit wire shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the party slots as their wire refs, exactly", async () => {
    const { body } = await requestFor();

    expect(body.partyA).toEqual({ walletId: WALLET_A });
    expect(body.partyB).toEqual({ address: ADDRESS_B });
  });

  it("sends a counterparty slot as its account id", async () => {
    const { body } = await requestFor({
      parties: {
        a: { ref: { counterpartyAccountId: "cpa_1" }, address: ADDRESS_A },
        b: { ref: { address: ADDRESS_B }, address: ADDRESS_B },
      },
    });

    expect(body.partyA).toEqual({ counterpartyAccountId: "cpa_1" });
  });

  it("omits payerWalletId when the project settlement wallet pays", async () => {
    const { body } = await requestFor({ payerWalletId: null });

    expect(body).not.toHaveProperty("payerWalletId");
  });

  it("sends payerWalletId only when a wallet was picked", async () => {
    const { body } = await requestFor({ payerWalletId: "cwlt_payer" });

    expect(body.payerWalletId).toBe("cwlt_payer");
  });

  it("omits empty settlement destinations rather than sending empty strings", async () => {
    const { body } = await requestFor();

    expect(body).not.toHaveProperty("userASettlementDestination");
    expect(body).not.toHaveProperty("userBSettlementDestination");
  });
});

describe("useDvpCreateSubmit idempotency key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is stable for the same trade, so a double submit replays", async () => {
    expect((await requestFor()).idempotencyKey).toBe((await requestFor()).idempotencyKey);
  });

  // Each of these was previously absent from the key while being present in the
  // API's fingerprint, so two distinct trades collided and the second was
  // refused. One case per field, because a single combined case would still
  // pass with all but one of them restored.
  describe("distinguishes trades that differ only by", () => {
    const base = requestFor().then((value) => value.idempotencyKey);

    it.each([
      ["the asset mint", { mintA: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE" }],
      ["the cash mint", { mintB: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1" }],
      [
        "the party A reference kind",
        {
          parties: {
            a: { ref: { address: ADDRESS_A }, address: ADDRESS_A },
            b: { ref: { address: ADDRESS_B }, address: ADDRESS_B },
          },
        },
      ],
      [
        "the party B address",
        {
          parties: {
            a: { ref: { walletId: WALLET_A }, address: ADDRESS_A },
            b: { ref: { address: `${ADDRESS_B}1` }, address: `${ADDRESS_B}1` },
          },
        },
      ],
      ["the payer wallet", { payerWalletId: "cwlt_other" }],
      ["the asset token program", { tokenProgramA: LEGACY }],
      ["the cash token program", { tokenProgramB: LEGACY }],
      ["the reference", { refString: "invoice-42" }],
      // Where the proceeds go is a term of the trade. Same wallet, same
      // amounts, same parties, different payee is a DIFFERENT trade, and
      // the API fingerprints it as one — so a key that ignored these would
      // send the second request into a mismatched replay and get it refused.
      [
        "where the asset side is paid",
        { userASettlementDestination: "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC" },
      ],
      [
        "where the cash side is paid",
        { userBSettlementDestination: "BmA22WnK8p5Ai5mkzJhk64DCxMiUiii69tgSmUGMWPSh" },
      ],
    ])("%s", async (_label, overrides) => {
      expect((await requestFor(overrides)).idempotencyKey).not.toBe(await base);
    });
  });

  // The fields that were already covered, kept under test so a refactor of the
  // digest cannot quietly drop one.
  describe("still distinguishes trades that differ by", () => {
    it.each([
      ["the asset amount", { amountA: "1001" }],
      ["the cash amount", { amountB: "2001" }],
      ["the expiry", { expiry: "2027-01-02" }],
    ])("%s", async (_label, overrides) => {
      expect((await requestFor(overrides)).idempotencyKey).not.toBe(
        (await requestFor()).idempotencyKey
      );
    });
  });

  // A pasted mint carries no program and defaults to Token-2022 at submit. The
  // key must reflect what is SENT, or an explicit T22 and a pasted address
  // would hash differently while creating the identical trade.
  it("treats an unspecified token program as the Token-2022 default it sends", async () => {
    expect((await requestFor({ tokenProgramA: null })).idempotencyKey).toBe(
      (await requestFor({ tokenProgramA: T22 })).idempotencyKey
    );
  });

  // `crypto.subtle` exists only in a secure context, so a dashboard reached
  // over plain http on a LAN address does not have it. An earlier version of
  // this derived the key with `subtle.digest` and threw on every create in any
  // environment without it — CI included, which is how it was caught.
  it("derives the key without crypto.subtle", async () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { getRandomValues: original.getRandomValues.bind(original) },
    });
    try {
      await expect(requestFor()).resolves.toMatchObject({
        idempotencyKey: /^dvp-create-[0-9a-f]{32}$/,
      });
    } finally {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: original });
    }
  });

  // Free text, and the separator problem it creates: a plain join would let
  // a reference containing the separator impersonate a different field split.
  it("does not collide when a reference contains the field separator", async () => {
    const a = await requestFor({ refString: 'a", "b' });
    const b = await requestFor({ refString: 'a\\", \\"b' });

    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });
});
