// @vitest-environment jsdom

/**
 * Who the two parties are, and which wire shape the request takes.
 *
 * Each slot is exactly one of three references — a custody wallet, a
 * registered counterparty account, or a pasted address — and the request is
 * null unless every slot chose and filled its reference. The same-address
 * guard and the malformed-address refusal are the two client-side catches; the
 * API refuses both, but a round trip for either costs a provider call.
 */

import { describe, expect, it } from "vitest";
import type { DvpCreateCounterpartyAccount, DvpCreateWallet } from "./dvp-create.data";
import {
  type DvpPartiesContext,
  deriveDvpParties,
  partyRefFor,
  partySlotSchema,
} from "./use-dvp-parties";

const WALLET_ADDRESS = "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC";
const OTHER = "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg";
const THIRD = "BmA22WnK8p5Ai5mkzJhk64DCxMiUiii69tgSmUGMWPSh";

const wallets: DvpCreateWallet[] = [
  { id: "cwlt_1", address: WALLET_ADDRESS, label: "Treasury", balances: [] },
];

const counterpartyAccounts: DvpCreateCounterpartyAccount[] = [
  {
    counterpartyAccountId: "cpa_1",
    name: "Acme OTC",
    label: "Settlement wallet",
    address: THIRD,
  },
];

const context: DvpPartiesContext = { wallets, counterpartyAccounts };

function derive(
  partyA: Parameters<typeof deriveDvpParties>[0]["partyA"],
  partyB: Parameters<typeof deriveDvpParties>[0]["partyB"]
) {
  return deriveDvpParties({ partyA, partyB }, context);
}

describe("party slot validity", () => {
  it("accepts a wallet id once it names one of the offering wallets", () => {
    expect(partySlotSchema.safeParse({ mode: "wallet", walletId: "cwlt_1" }).success).toBe(true);
  });

  it("rejects a wallet slot with no wallet chosen", () => {
    expect(partySlotSchema.safeParse({ mode: "wallet", walletId: "" }).success).toBe(false);
  });

  it("accepts a counterparty id once chosen", () => {
    expect(
      partySlotSchema.safeParse({ mode: "counterparty", counterpartyAccountId: "cpa_1" }).success
    ).toBe(true);
  });

  it("rejects a pasted address that is not base58", () => {
    expect(partySlotSchema.safeParse({ mode: "address", address: "not-an-address" }).success).toBe(
      false
    );
  });

  it("rejects a pasted address that is still empty", () => {
    expect(partySlotSchema.safeParse({ mode: "address", address: "" }).success).toBe(false);
  });
});

describe("deriveDvpParties", () => {
  it("is not ready until both slots resolve", () => {
    const result = derive({ mode: "wallet", walletId: "cwlt_1" }, { mode: "address", address: "" });

    expect(result.ready).toBe(false);
    expect(result.request).toBeNull();
    expect(result.resolved.a).toMatchObject({ label: "Treasury", address: WALLET_ADDRESS });
  });

  it("resolves two pasted parties to addresses on the wire", () => {
    const result = derive({ mode: "address", address: OTHER }, { mode: "address", address: THIRD });

    expect(result.ready).toBe(true);
    expect(result.request).toEqual({ partyA: { address: OTHER }, partyB: { address: THIRD } });
    expect(result.wire).toEqual({
      a: { ref: { address: OTHER }, address: OTHER },
      b: { ref: { address: THIRD }, address: THIRD },
    });
  });

  it("resolves a wallet party to its id on the wire", () => {
    const result = derive(
      { mode: "wallet", walletId: "cwlt_1" },
      { mode: "address", address: OTHER }
    );

    expect(result.request).toEqual({
      partyA: { walletId: "cwlt_1" },
      partyB: { address: OTHER },
    });
    // The idempotency key hashes the RESOLVED address, not the id.
    expect(result.wire?.a.address).toBe(WALLET_ADDRESS);
  });

  it("resolves a counterparty party to its account id on the wire", () => {
    const result = derive(
      { mode: "counterparty", counterpartyAccountId: "cpa_1" },
      { mode: "address", address: OTHER }
    );

    expect(result.request).toEqual({
      partyA: { counterpartyAccountId: "cpa_1" },
      partyB: { address: OTHER },
    });
    expect(result.resolved.a).toMatchObject({ label: "Acme OTC", address: THIRD });
  });

  // A trade needs two parties. The program refuses one address on both sides,
  // and catching it here saves a round trip that costs a provider call.
  it("refuses two slots resolving to the same address", () => {
    const result = derive(
      { mode: "wallet", walletId: "cwlt_1" },
      { mode: "address", address: WALLET_ADDRESS }
    );

    expect(result.sameAddress).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.request).toBeNull();
  });

  // A wallet id that names nothing is a stale slot, not a valid one: the
  // schema cannot see the offering list, so resolution must.
  it("refuses a wallet id that resolves to no wallet", () => {
    const result = derive(
      { mode: "wallet", walletId: "cwlt_missing" },
      { mode: "address", address: OTHER }
    );

    expect(result.ready).toBe(false);
    expect(result.request).toBeNull();
  });
});

describe("partyRefFor", () => {
  it("maps each slot variant to its wire union arm", () => {
    expect(partyRefFor({ mode: "wallet", walletId: "cwlt_1" })).toEqual({ walletId: "cwlt_1" });
    expect(partyRefFor({ mode: "counterparty", counterpartyAccountId: "cpa_1" })).toEqual({
      counterpartyAccountId: "cpa_1",
    });
    expect(partyRefFor({ mode: "address", address: OTHER })).toEqual({ address: OTHER });
  });
});
