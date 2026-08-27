import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchParsedTransaction = vi.hoisted(() => vi.fn());
vi.mock("@/routes/payments/handlers/observed-transfers", () => ({ fetchParsedTransaction }));

import type { PaymentTransferRow } from "@/db/repositories";
import type { Env } from "@/types/env";
import { verifyRampSettlement } from "./settlement-verifier";

const DESTINATION = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const OTHER_WALLET = "5xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
// Devnet USDC, which is what the well-known catalogue resolves "USDC" to off mainnet.
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const OTHER_MINT = "So11111111111111111111111111111111111111112";

const env = { SOLANA_NETWORK: "devnet", SOLANA_RPC_URL: "https://api.devnet.solana.com" } as Env;

function transfer(overrides: Partial<PaymentTransferRow> = {}): PaymentTransferRow {
  return {
    id: "xfr_verify",
    type: "onramp",
    token: "USDC",
    amount: "25",
    destination_address: DESTINATION,
    source_address: null,
    settlement_signature: "sig_under_test",
    created_at: CREATED_AT,
    ...overrides,
  } as PaymentTransferRow;
}

/** The transfer is created first; any legitimate settlement lands after it. */
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const CREATED_AT_SECONDS = Math.floor(Date.parse(CREATED_AT) / 1000);
/** Ten minutes after the order, comfortably inside any legitimate window. */
const AFTER_CREATED = CREATED_AT_SECONDS + 600;

function balance(owner: string, mint: string, amount: string, decimals = 6) {
  return { owner, mint, uiTokenAmount: { amount, decimals } };
}

/** A transaction that credits `DESTINATION` with 25 USDC. */
function goodTransaction() {
  return {
    slot: 1234,
    blockTime: AFTER_CREATED,
    meta: {
      err: null,
      preTokenBalances: [balance(DESTINATION, USDC_DEVNET, "0")],
      postTokenBalances: [balance(DESTINATION, USDC_DEVNET, "25000000")],
    },
  };
}

describe("verifyRampSettlement", () => {
  beforeEach(() => {
    fetchParsedTransaction.mockReset();
  });

  it("verifies a transaction that credits the expected wallet with the expected amount", async () => {
    fetchParsedTransaction.mockResolvedValue(goodTransaction());

    const result = await verifyRampSettlement(env, transfer());

    expect(result).toEqual({ verified: true, slot: 1234, method: "provider_signature" });
  });

  // Everything below must refuse to verify. A lenient matcher here would turn this feature into
  // a false guarantee on a money path, which is worse than making no claim at all.

  it("refuses when the transaction is not on chain", async () => {
    fetchParsedTransaction.mockResolvedValue(null);
    expect(await verifyRampSettlement(env, transfer())).toMatchObject({ verified: false });
  });

  it("refuses when the transaction failed", async () => {
    fetchParsedTransaction.mockResolvedValue({
      ...goodTransaction(),
      meta: { ...goodTransaction().meta, err: { InstructionError: [0, "Custom"] } },
    });
    expect(await verifyRampSettlement(env, transfer())).toMatchObject({ verified: false });
  });

  it("refuses when the credited mint is not the transfer's token", async () => {
    fetchParsedTransaction.mockResolvedValue({
      slot: 1234,
      blockTime: AFTER_CREATED,
      meta: {
        err: null,
        preTokenBalances: [balance(DESTINATION, OTHER_MINT, "0")],
        postTokenBalances: [balance(DESTINATION, OTHER_MINT, "25000000")],
      },
    });
    expect(await verifyRampSettlement(env, transfer())).toMatchObject({ verified: false });
  });

  it("refuses when the credit landed in a different wallet", async () => {
    fetchParsedTransaction.mockResolvedValue({
      slot: 1234,
      blockTime: AFTER_CREATED,
      meta: {
        err: null,
        preTokenBalances: [balance(OTHER_WALLET, USDC_DEVNET, "0")],
        postTokenBalances: [balance(OTHER_WALLET, USDC_DEVNET, "25000000")],
      },
    });
    expect(await verifyRampSettlement(env, transfer())).toMatchObject({ verified: false });
  });

  it("refuses when less than the expected amount moved", async () => {
    fetchParsedTransaction.mockResolvedValue({
      slot: 1234,
      blockTime: AFTER_CREATED,
      meta: {
        err: null,
        preTokenBalances: [balance(DESTINATION, USDC_DEVNET, "0")],
        postTokenBalances: [balance(DESTINATION, USDC_DEVNET, "24999999")],
      },
    });
    expect(await verifyRampSettlement(env, transfer())).toMatchObject({ verified: false });
  });

  it("refuses an off-ramp whose wallet was credited rather than debited", async () => {
    // Same movement as the happy path, but an off-ramp must send funds OUT. Checking the signed
    // direction rather than the magnitude is what catches this.
    fetchParsedTransaction.mockResolvedValue(goodTransaction());

    const result = await verifyRampSettlement(
      env,
      transfer({ type: "offramp", source_address: DESTINATION, destination_address: null })
    );

    expect(result).toMatchObject({ verified: false });
  });

  it("verifies an off-ramp that debits the source wallet", async () => {
    fetchParsedTransaction.mockResolvedValue({
      slot: 99,
      blockTime: AFTER_CREATED,
      meta: {
        err: null,
        preTokenBalances: [balance(DESTINATION, USDC_DEVNET, "25000000")],
        postTokenBalances: [balance(DESTINATION, USDC_DEVNET, "0")],
      },
    });

    const result = await verifyRampSettlement(
      env,
      transfer({ type: "offramp", source_address: DESTINATION, destination_address: null })
    );

    expect(result).toEqual({ verified: true, slot: 99, method: "provider_signature" });
  });

  it("refuses when the RPC lookup fails, rather than resolving the row either way", async () => {
    fetchParsedTransaction.mockRejectedValue(new Error("connection reset"));
    expect(await verifyRampSettlement(env, transfer())).toMatchObject({ verified: false });
  });

  it("refuses when no settlement signature was recorded", async () => {
    expect(await verifyRampSettlement(env, transfer({ settlement_signature: null }))).toMatchObject(
      { verified: false }
    );
    expect(fetchParsedTransaction).not.toHaveBeenCalled();
  });

  it("refuses when the token cannot be resolved to a mint", async () => {
    fetchParsedTransaction.mockResolvedValue(goodTransaction());
    expect(await verifyRampSettlement(env, transfer({ token: "NOTATOKEN" }))).toMatchObject({
      verified: false,
    });
  });

  // Gates added after review found the predicate accepted any qualifying movement through the
  // wallet rather than this transfer's settlement.

  it("refuses a transaction that predates the transfer", async () => {
    fetchParsedTransaction.mockResolvedValue({
      ...goodTransaction(),
      blockTime: CREATED_AT_SECONDS - 3600,
    });
    expect(await verifyRampSettlement(env, transfer())).toMatchObject({ verified: false });
  });

  it("refuses when the transaction has no block time", async () => {
    fetchParsedTransaction.mockResolvedValue({ ...goodTransaction(), blockTime: null });
    expect(await verifyRampSettlement(env, transfer())).toMatchObject({ verified: false });
  });

  it("allows clock skew between our clock and cluster time", async () => {
    // Slightly BEFORE created_at, inside the skew window: cluster time and our clock are not synced.
    fetchParsedTransaction.mockResolvedValue({
      ...goodTransaction(),
      blockTime: CREATED_AT_SECONDS - 60,
    });
    expect(await verifyRampSettlement(env, transfer())).toMatchObject({ verified: true });
  });

  it("refuses when created_at cannot be parsed", async () => {
    fetchParsedTransaction.mockResolvedValue(goodTransaction());
    expect(await verifyRampSettlement(env, transfer({ created_at: "not a date" }))).toMatchObject({
      verified: false,
    });
  });

  it("refuses when MORE than the expected amount moved", async () => {
    // The hole this closes: an at-least bound let any larger unrelated transfer satisfy the check.
    fetchParsedTransaction.mockResolvedValue({
      slot: 1234,
      blockTime: AFTER_CREATED,
      meta: {
        err: null,
        preTokenBalances: [balance(DESTINATION, USDC_DEVNET, "0")],
        postTokenBalances: [balance(DESTINATION, USDC_DEVNET, "26000000")],
      },
    });
    expect(await verifyRampSettlement(env, transfer())).toMatchObject({ verified: false });
  });

  it("refuses an off-ramp that debits more than the expected amount", async () => {
    fetchParsedTransaction.mockResolvedValue({
      slot: 99,
      blockTime: AFTER_CREATED,
      meta: {
        err: null,
        preTokenBalances: [balance(DESTINATION, USDC_DEVNET, "26000000")],
        postTokenBalances: [balance(DESTINATION, USDC_DEVNET, "0")],
      },
    });
    expect(
      await verifyRampSettlement(
        env,
        transfer({ type: "offramp", source_address: DESTINATION, destination_address: null })
      )
    ).toMatchObject({ verified: false });
  });
});
