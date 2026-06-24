import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { Signature, SolanaRpc } from "./rpc";
import { encodeSolanaPayURL, findReference, validateTransfer } from "./solana-pay";

const RECIPIENT = "Hsd1nrFjY1Q5C5x2pZ7y6FfQ9aMqV4cWcYkX7m2nT3p" as Address;
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const REFERENCE = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" as Address;
const SIG = "5h1cE" as Signature;

const stubSignatures = (items: unknown[]): SolanaRpc =>
  ({ getSignaturesForAddress: () => ({ send: async () => items }) }) as unknown as SolanaRpc;

const stubTransaction = (tx: unknown): SolanaRpc =>
  ({ getTransaction: () => ({ send: async () => tx }) }) as unknown as SolanaRpc;

const balance = (owner: string, mint: string, amount: string) => ({
  owner,
  mint,
  uiTokenAmount: { amount },
});

describe("encodeSolanaPayURL", () => {
  it("encodes a fixed-amount spl transfer request", () => {
    const url = encodeSolanaPayURL({
      recipient: RECIPIENT,
      amount: "0.01",
      splToken: MINT,
      reference: REFERENCE,
      memo: "preq_abc123",
    });
    expect(url).toBe(
      `solana:${RECIPIENT}?amount=0.01&spl-token=${MINT}&reference=${REFERENCE}&memo=preq_abc123`
    );
  });

  it("percent-encodes label and message spaces", () => {
    const url = encodeSolanaPayURL({
      recipient: RECIPIENT,
      amount: "1",
      splToken: MINT,
      reference: REFERENCE,
      memo: "preq_abc123",
      label: "Acme Inc",
      message: "Invoice 42",
    });
    expect(url).toContain("label=Acme%20Inc");
    expect(url).toContain("message=Invoice%2042");
  });

  it("carries the payment request id as the on-chain memo", () => {
    const url = encodeSolanaPayURL({
      recipient: RECIPIENT,
      amount: "1",
      splToken: MINT,
      reference: REFERENCE,
      memo: "preq_abc123",
    });
    expect(url).toContain("memo=preq_abc123");
  });
});

describe("findReference", () => {
  it("returns the oldest signature touching the reference", async () => {
    const rpc = stubSignatures([
      { signature: "newest", slot: 20n, blockTime: 2n, err: null },
      { signature: "oldest", slot: 10n, blockTime: 1n, err: null },
    ]);
    const result = await findReference(rpc, REFERENCE);
    expect(result?.signature).toBe("oldest");
  });

  it("returns null when the reference has not been paid", async () => {
    expect(await findReference(stubSignatures([]), REFERENCE)).toBeNull();
  });
});

describe("validateTransfer", () => {
  it("is valid when the recipient receives the exact amount", async () => {
    const rpc = stubTransaction({
      meta: {
        err: null,
        preTokenBalances: [],
        postTokenBalances: [balance(RECIPIENT, MINT, "1000000")],
      },
    });
    const result = await validateTransfer(rpc, SIG, {
      recipient: RECIPIENT,
      splToken: MINT,
      amount: 1_000_000n,
    });
    expect(result).toEqual({ valid: true, received: 1_000_000n });
  });

  it("allows overpayment", async () => {
    const rpc = stubTransaction({
      meta: {
        err: null,
        preTokenBalances: [balance(RECIPIENT, MINT, "500000")],
        postTokenBalances: [balance(RECIPIENT, MINT, "2000000")],
      },
    });
    const result = await validateTransfer(rpc, SIG, {
      recipient: RECIPIENT,
      splToken: MINT,
      amount: 1_000_000n,
    });
    expect(result).toEqual({ valid: true, received: 1_500_000n });
  });

  it("is invalid on underpayment", async () => {
    const rpc = stubTransaction({
      meta: {
        err: null,
        preTokenBalances: [],
        postTokenBalances: [balance(RECIPIENT, MINT, "999999")],
      },
    });
    const result = await validateTransfer(rpc, SIG, {
      recipient: RECIPIENT,
      splToken: MINT,
      amount: 1_000_000n,
    });
    expect(result).toEqual({ valid: false, received: 999_999n });
  });

  it("ignores balances for a different owner or mint", async () => {
    const rpc = stubTransaction({
      meta: {
        err: null,
        preTokenBalances: [],
        postTokenBalances: [
          balance("someoneElse", MINT, "1000000"),
          balance(RECIPIENT, "OtherMint1111111111111111111111111111111111", "1000000"),
        ],
      },
    });
    const result = await validateTransfer(rpc, SIG, {
      recipient: RECIPIENT,
      splToken: MINT,
      amount: 1_000_000n,
    });
    expect(result).toEqual({ valid: false, received: 0n });
  });

  it("is invalid when the transaction failed", async () => {
    const rpc = stubTransaction({
      meta: {
        err: { InstructionError: [0, "Custom"] },
        preTokenBalances: [],
        postTokenBalances: [balance(RECIPIENT, MINT, "1000000")],
      },
    });
    const result = await validateTransfer(rpc, SIG, {
      recipient: RECIPIENT,
      splToken: MINT,
      amount: 1_000_000n,
    });
    expect(result).toEqual({ valid: false, received: 0n });
  });

  it("throws when the signature resolves to no transaction", async () => {
    await expect(
      validateTransfer(stubTransaction(null), SIG, {
        recipient: RECIPIENT,
        splToken: MINT,
        amount: 1_000_000n,
      })
    ).rejects.toThrow(/not found/);
  });

  it("throws loudly on a malformed balance amount instead of mis-reading it as zero", async () => {
    const rpc = stubTransaction({
      meta: {
        err: null,
        preTokenBalances: [],
        postTokenBalances: [balance(RECIPIENT, MINT, "")],
      },
    });
    await expect(
      validateTransfer(rpc, SIG, { recipient: RECIPIENT, splToken: MINT, amount: 1_000_000n })
    ).rejects.toThrow(/Invalid decimal amount/);
  });
});
