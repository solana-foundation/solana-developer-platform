/**
 * DvP test fixtures: one trade row builder, and the sponsor co-signing the
 * fund, reclaim and settle suites all stand in for Kora with.
 */

import {
  type Address,
  address,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  type Signature,
} from "@solana/kit";
import {
  generateKeyPairSigner,
  type KeyPairSigner,
  partiallySignTransactionWithSigners,
} from "@solana/signers";
import { vi } from "vitest";
import type { DvpTradeRow } from "@/db/repositories";
import type { OwnedSubmissionLifecycle } from "@/services/sponsorship.service";

export const DVP_TEST_T22: Address = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const DVP_TEST_USER_A: Address = address("5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn");
export const DVP_TEST_USER_B: Address = address("7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg");
export const DVP_TEST_AUTHORITY: Address = address("9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY");

/**
 * An open trade that has been created and never observed: nothing funded,
 * nothing read. Override what a test is about and nothing else.
 *
 * @param overrides - The fields the test cares about.
 * @returns A complete row, as the repository maps it.
 */
export function buildDvpTradeRow(overrides: Partial<DvpTradeRow> = {}): DvpTradeRow {
  const userA = overrides.userA ?? DVP_TEST_USER_A;
  const userB = overrides.userB ?? DVP_TEST_USER_B;
  return {
    id: "dvp_test",
    organizationId: "org_a",
    projectId: "prj_a",
    swapDvp: address("BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po"),
    settlementAuthority: DVP_TEST_AUTHORITY,
    userA,
    userB,
    mintA: address("ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1"),
    mintB: address("AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE"),
    nonce: "42",
    tokenProgramA: DVP_TEST_T22,
    tokenProgramB: DVP_TEST_T22,
    decimalsA: 6,
    decimalsB: 6,
    symbolA: "ATD",
    symbolB: "USDC",
    nameA: "Acme Treasury Debt",
    nameB: "USD Coin",
    amountA: "1000",
    amountB: "2000",
    expiryTimestamp: "1900000000",
    earliestSettlementTimestamp: null,
    userASettlementDestination: userA,
    userBSettlementDestination: userB,
    refString: null,
    escrowA: address("FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU"),
    escrowB: address("6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y"),
    counterpartyAccountIdA: null,
    counterpartyAccountIdB: null,
    status: "created",
    observedAt: null,
    observedClusterTimestamp: null,
    idempotencyKey: null,
    idempotencyFingerprint: null,
    createSignature: null,
    createLastValidBlockHeight: null,
    closeSignature: null,
    closeClaim: null,
    closeResolutionAttempts: 0,
    closeResolutionAfter: null,
    closedAt: null,
    escrowAAmount: null,
    escrowBAmount: null,
    escrowAPeakAmount: null,
    escrowBPeakAmount: null,
    escrowAFrozen: null,
    escrowBFrozen: null,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

/** Both legs observed holding their target, inside the settlement window. */
export function buildFundedDvpTradeRow(overrides: Partial<DvpTradeRow> = {}): DvpTradeRow {
  return buildDvpTradeRow({
    status: "funded",
    observedAt: "2026-09-03T00:05:00.000Z",
    observedClusterTimestamp: "1800000000",
    escrowAAmount: "1000",
    escrowBAmount: "2000",
    escrowAPeakAmount: "1000",
    escrowBPeakAmount: "2000",
    escrowAFrozen: false,
    escrowBFrozen: false,
    ...overrides,
  });
}

/** Settled: the trade account and both escrows are gone. */
export function buildClosedDvpTradeRow(overrides: Partial<DvpTradeRow> = {}): DvpTradeRow {
  return buildFundedDvpTradeRow({
    status: "settled",
    closedAt: "2026-09-03T00:10:00.000Z",
    ...overrides,
  });
}

/**
 * Kora, as far as an owned sponsored submission goes: co-signs the transaction
 * with a real keypair and walks the lifecycle the service hands it, so the
 * service's own persist and lock hooks run exactly as they would.
 */
export interface TestSponsor {
  address: Address;
  signer: KeyPairSigner;
  prepareOwnedSubmission: (
    transaction: Uint8Array,
    lifecycle: OwnedSubmissionLifecycle
  ) => Promise<{
    signature: Signature;
    signedTransaction: Uint8Array;
    releaseDefinitelyUnbroadcast: () => Promise<void>;
  }>;
}

export async function createTestSponsor(): Promise<TestSponsor> {
  const signer = await generateKeyPairSigner();
  async function prepareOwnedSubmission(
    transaction: Uint8Array,
    lifecycle: OwnedSubmissionLifecycle
  ) {
    const decoded = getTransactionDecoder().decode(transaction);
    const signed = await partiallySignTransactionWithSigners([signer], decoded);
    const signature = getSignatureFromTransaction(signed);
    const signedTransaction = new Uint8Array(getTransactionEncoder().encode(signed));
    const submission = {
      signature,
      signedTransaction,
      releaseDefinitelyUnbroadcast: vi.fn(async () => {}),
    };
    await lifecycle.persistSigned(submission);
    await lifecycle.markStarted();
    return submission;
  }
  return {
    address: signer.address,
    signer,
    prepareOwnedSubmission,
  };
}

/** A `sendTransaction` stand-in that accepts the bytes and returns their signature. */
export async function acceptTransaction(_rpc: unknown, bytes: Uint8Array) {
  return getSignatureFromTransaction(getTransactionDecoder().decode(bytes));
}
