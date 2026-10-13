import * as privateChannels from "@sdp/private-channels";
import { runInClusterScope } from "@sdp/rpc/scope";
import type { ParsedTransaction, SignatureInfo, SignatureStatusInfo } from "@sdp/rpc/solana";
import * as solanaRpc from "@sdp/rpc/solana";
import type { Signature } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import { testSignature } from "@/test/helpers/signatures";

// --- Mocks (hoisted so the vi.mock factories can reference them) --------------

const { withdrawalRepo, instanceRepo, observationRepo, mocks } = vi.hoisted(() => {
  const withdrawalRepo = {
    listNonTerminal: vi.fn(),
    updateWithdrawal: vi.fn(async (input: Record<string, unknown>) => ({ ...input })),
    patchContext: vi.fn(async () => undefined),
  };
  const instanceRepo = {
    getById: vi.fn(),
  };
  const observationRepo = {
    claimSettlement: vi.fn(),
    findByIntent: vi.fn(),
  };
  return {
    withdrawalRepo,
    instanceRepo,
    observationRepo,
    mocks: {
      createWithdrawalRepo: vi.fn(() => withdrawalRepo),
      createInstanceRepo: vi.fn(() => instanceRepo),
      createObservationRepo: vi.fn(() => observationRepo),
    },
  };
});
vi.mock("@/db/repositories", () => ({
  createPrivateChannelWithdrawalRepository: mocks.createWithdrawalRepo,
  createPrivateChannelInstanceRepository: mocks.createInstanceRepo,
  createPrivateChannelSettlementObservationRepository: mocks.createObservationRepo,
}));

// Deterministic ATA derivation: an owner's ATA is `ata:<owner>`.
const { findAssociatedTokenPda } = vi.hoisted(() => ({
  findAssociatedTokenPda: vi.fn(async ({ owner }: { owner: string }) => [`ata:${owner}`, 255]),
}));
vi.mock("@solana-program/token", () => ({
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
}));

const { emitWithdrawalEvent } = vi.hoisted(() => ({ emitWithdrawalEvent: vi.fn() }));
vi.mock("@/services/private-channels/withdraw-events", () => ({ emitWithdrawalEvent }));

import { trackPendingWithdrawals } from "./track-pending-withdrawals";

const createChannelGatewayRpc = vi.spyOn(privateChannels, "createChannelGatewayRpc");
const getSignatureStatuses = vi.spyOn(solanaRpc, "getSignatureStatuses");
const getSignaturesForAddress = vi.spyOn(solanaRpc, "getSignaturesForAddress");
const getTransaction = vi.spyOn(solanaRpc, "getTransaction");

// Valid base58 addresses (the reconciler runs `address()` on these fixtures).
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const ESCROW_INSTANCE = "7C1Pu8mbHaDDTFnGH8YTqemNDofqXP3XEotzSo6TbwHz";
const DESTINATION = "J231K9UEpS4y4KAPwGc4gsMNCjKFRMYcQBcjVW7vBhVi";
const NOW_ISO = "2026-07-17T00:00:00.000Z";
const RELEASE_STALE_ISO = "2026-07-16T20:00:00.000Z"; // > 30 min before NOW
const STALE_ISO = "2026-07-16T23:00:00.000Z"; // > 5 min before NOW

const BURN_SIG = testSignature(11);
const BURN_SIG_1 = testSignature(12);
const BURN_SIG_2 = testSignature(13);
const PENDING_BURN_SIG = testSignature(17);
const RELEASE_SIG = testSignature(21);
const OTHER_RELEASE_SIG = testSignature(22);
const TAKEN_RELEASE_SIG = testSignature(23);
const FREE_RELEASE_SIG = testSignature(24);

const CONFIRMED_STATUS: SignatureStatusInfo = {
  slot: 1n,
  confirmations: 1n,
  confirmationStatus: "confirmed",
  err: null,
};
const ERRORED_STATUS: SignatureStatusInfo = {
  ...CONFIRMED_STATUS,
  err: { InstructionError: [0, "InvalidAccountData"] },
};

function releaseSignature(signature: Signature, blockTime: bigint | null): SignatureInfo {
  return { signature, slot: 1n, blockTime, err: null };
}

function releaseTransfer(slot: bigint, amount: string): ParsedTransaction {
  return {
    slot,
    executionResultKnown: true,
    err: null,
    instructions: [
      {
        programId: "tok",
        accounts: [],
        parsedType: "transfer",
        info: { destination: `ata:${DESTINATION}`, amount },
      },
    ],
  };
}

function withdrawalRow(overrides: Record<string, unknown>) {
  return {
    id: "wd",
    organization_id: "org",
    project_id: "proj",
    instance_id: "inst-X",
    wallet_id: "wal-1",
    owner: ESCROW_INSTANCE,
    destination: DESTINATION,
    mint: MINT,
    amount: "10",
    status: "confirmed",
    signature: BURN_SIG,
    settlement_ref: null,
    failure_reason: null,
    context: {},
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...overrides,
  };
}

function instanceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "inst-X",
    organization_id: "org",
    project_id: "proj",
    gateway_url: "http://gw",
    escrow_program_id: "esc",
    withdraw_program_id: "wdp",
    escrow_instance_addr: ESCROW_INSTANCE,
    auth_url: "http://auth",
    is_active: true,
    created_by: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW_ISO));
  withdrawalRepo.updateWithdrawal.mockImplementation(async (input: Record<string, unknown>) => ({
    ...withdrawalRow({}),
    ...input,
  }));
  instanceRepo.getById.mockResolvedValue(instanceRow());
  getSignaturesForAddress.mockResolvedValue([]);
  getTransaction.mockResolvedValue(null);
  // Default: claim succeeds and returns a stub observation.
  observationRepo.claimSettlement.mockImplementation(async (input: Record<string, unknown>) => ({
    ...input,
    observed_at: NOW_ISO,
  }));
});

describe("trackPendingWithdrawals", () => {
  installClusterRpcStub();

  function track() {
    return runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      trackPendingWithdrawals(env)
    );
  }

  it("does nothing when there are no non-terminal withdrawals", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([]);
    await track();
    expect(withdrawalRepo.updateWithdrawal).not.toHaveBeenCalled();
  });

  it("confirms a submitted burn against the CURRENT instance gateway", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "submitted" }),
    ]);
    instanceRepo.getById.mockResolvedValueOnce(instanceRow({ gateway_url: "http://gw-live" }));
    getSignatureStatuses.mockResolvedValueOnce([CONFIRMED_STATUS]);

    await track();

    expect(createChannelGatewayRpc).toHaveBeenCalledWith("http://gw-live");
    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "w1", status: "confirmed", expectedStatus: "submitted" })
    );
  });

  it("batches submitted burns sharing a gateway into one getSignatureStatuses call", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "submitted", signature: BURN_SIG_1 }),
      withdrawalRow({ id: "w2", status: "submitted", signature: BURN_SIG_2 }),
    ]);
    getSignatureStatuses.mockResolvedValueOnce([CONFIRMED_STATUS, ERRORED_STATUS]);

    await track();

    // One batched read for the whole tick, not one RPC per row; one RPC client
    // per gateway.
    expect(createChannelGatewayRpc).toHaveBeenCalledTimes(1);
    expect(getSignatureStatuses).toHaveBeenCalledTimes(1);
    expect(getSignatureStatuses).toHaveBeenCalledWith(expect.anything(), [BURN_SIG_1, BURN_SIG_2], {
      searchTransactionHistory: true,
    });
    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "w1", status: "confirmed", expectedStatus: "submitted" })
    );
    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "w2", status: "failed", expectedStatus: "submitted" })
    );
  });

  it("uses one batched read per distinct gateway", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "submitted", signature: BURN_SIG_1 }),
      withdrawalRow({
        id: "w2",
        instance_id: "inst-2",
        status: "submitted",
        signature: BURN_SIG_2,
      }),
    ]);
    instanceRepo.getById
      .mockResolvedValueOnce(instanceRow({ gateway_url: "http://gw-a" }))
      .mockResolvedValueOnce(instanceRow({ id: "inst-2", gateway_url: "http://gw-b" }));
    getSignatureStatuses
      .mockResolvedValueOnce([CONFIRMED_STATUS])
      .mockResolvedValueOnce([CONFIRMED_STATUS]);

    await track();

    expect(createChannelGatewayRpc).toHaveBeenCalledTimes(2);
    expect(getSignatureStatuses).toHaveBeenCalledTimes(2);
    expect(getSignatureStatuses).toHaveBeenCalledWith(expect.anything(), [BURN_SIG_1], {
      searchTransactionHistory: true,
    });
    expect(getSignatureStatuses).toHaveBeenCalledWith(expect.anything(), [BURN_SIG_2], {
      searchTransactionHistory: true,
    });
  });

  it("keeps a malformed burn signature to its own row and batches the rest of its gateway", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "submitted", signature: "not-a-signature" }),
      withdrawalRow({ id: "w2", status: "submitted", signature: BURN_SIG_2 }),
    ]);
    getSignatureStatuses.mockResolvedValueOnce([CONFIRMED_STATUS]);

    await track();

    expect(getSignatureStatuses).toHaveBeenCalledExactlyOnceWith(expect.anything(), [BURN_SIG_2], {
      searchTransactionHistory: true,
    });
    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "w2", status: "confirmed", expectedStatus: "submitted" })
    );
  });

  it("fails a submitted burn that errored on-chain (pre-confirmation failure allowed)", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "submitted" }),
    ]);
    getSignatureStatuses.mockResolvedValueOnce([ERRORED_STATUS]);

    await track();

    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "w1", status: "failed", expectedStatus: "submitted" })
    );
  });

  it("fails a signature-less pending withdrawal past the stale window", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "pending", signature: null, updated_at: STALE_ISO }),
    ]);

    await track();

    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "w1", status: "failed", expectedStatus: "pending" })
    );
  });

  it("promotes a stale pending withdrawal that carries a burn signature and asks the gateway", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({
        id: "w7",
        status: "pending",
        signature: PENDING_BURN_SIG,
        updated_at: STALE_ISO,
      }),
    ]);
    getSignatureStatuses.mockResolvedValueOnce([CONFIRMED_STATUS]);

    await track();

    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "w7", status: "submitted", expectedStatus: "pending" })
    );
    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "w7", status: "confirmed", expectedStatus: "submitted" })
    );
  });

  it("guards the never-broadcast fail on an absent signature", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w8", status: "pending", signature: null, updated_at: STALE_ISO }),
    ]);

    await track();

    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "w8", status: "failed", expectedSignatureAbsent: true })
    );
  });

  it("settles a confirmed withdrawal when a matching devnet transfer is found on the instance ATA", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed" }),
    ]);
    getSignaturesForAddress.mockResolvedValueOnce([releaseSignature(RELEASE_SIG, 1_700_000_000n)]);
    getTransaction.mockResolvedValueOnce(releaseTransfer(1n, "10000000"));

    await track();

    // Scanned the CURRENT instance's escrow ATA on devnet.
    expect(getSignaturesForAddress).toHaveBeenCalledWith(
      expect.anything(),
      `ata:${ESCROW_INSTANCE}`,
      expect.objectContaining({ limit: 100 })
    );
    // Attribution recorded in settlement_observations.
    expect(observationRepo.claimSettlement).toHaveBeenCalledWith(
      expect.objectContaining({
        signature: RELEASE_SIG,
        instructionIndex: 0,
        intentKind: "withdrawal",
        intentId: "w1",
      })
    );
    // Intent CAS-advanced to settled.
    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "w1",
        status: "settled",
        settlementRef: RELEASE_SIG,
        expectedStatus: "confirmed",
      })
    );
    expect(emitWithdrawalEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Object),
      "transfer.withdrawal.settled",
      "confirmed",
      expect.any(Object)
    );
  });

  it("does not settle when the transfer amount doesn't match", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed" }),
    ]);
    getSignaturesForAddress.mockResolvedValueOnce([releaseSignature(RELEASE_SIG, null)]);
    getTransaction.mockResolvedValueOnce(releaseTransfer(1n, "9999999"));

    await track();

    const settled = withdrawalRepo.updateWithdrawal.mock.calls.some(
      ([c]) => (c as { status?: string }).status === "settled"
    );
    expect(settled).toBe(false);
    expect(observationRepo.claimSettlement).not.toHaveBeenCalled();
  });

  it("emits a stuck-warning (not a failure) when a confirmed withdrawal has been unmatched past the threshold", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed", updated_at: RELEASE_STALE_ISO }),
    ]);
    // No matching release found.

    await track();

    // Never failed after confirmed.
    const failed = withdrawalRepo.updateWithdrawal.mock.calls.some(
      ([c]) => (c as { status?: string }).status === "failed"
    );
    expect(failed).toBe(false);

    // Stuck-warning debounce marker written.
    expect(withdrawalRepo.patchContext).toHaveBeenCalledWith(
      "w1",
      expect.objectContaining({ lastStuckWarningAt: expect.any(String) })
    );
    expect(emitWithdrawalEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Object),
      "transfer.stuck_warning",
      "stale",
      expect.any(Object)
    );
  });

  it("does not re-emit the stuck-warning within the debounce interval", async () => {
    const recentWarn = new Date(Date.parse(NOW_ISO) - 5 * 60 * 1000).toISOString();
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({
        id: "w1",
        status: "confirmed",
        updated_at: RELEASE_STALE_ISO,
        context: { lastStuckWarningAt: recentWarn },
      }),
    ]);

    await track();

    expect(withdrawalRepo.patchContext).not.toHaveBeenCalled();
    expect(emitWithdrawalEvent).not.toHaveBeenCalled();
  });

  it("gracefully handles a claim conflict — reads the winning observation and still advances the intent", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed" }),
    ]);
    getSignaturesForAddress.mockResolvedValueOnce([releaseSignature(RELEASE_SIG, null)]);
    getTransaction.mockResolvedValueOnce(releaseTransfer(1n, "10000000"));
    // Racing poller won the claim.
    observationRepo.claimSettlement.mockResolvedValueOnce(null);
    observationRepo.findByIntent.mockResolvedValueOnce({
      signature: OTHER_RELEASE_SIG,
      instruction_index: 0,
      intent_kind: "withdrawal",
      intent_id: "w1",
      destination: `ata:${DESTINATION}`,
      mint: MINT,
      amount: "10",
      block_time: null,
      observed_at: NOW_ISO,
    });

    await track();

    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "w1",
        status: "settled",
        settlementRef: OTHER_RELEASE_SIG,
        expectedStatus: "confirmed",
      })
    );
  });

  it("walks past a signature-side PK conflict to the next matching release", async () => {
    // Simulates a same-content sibling settled in a previous tick: the first
    // release in the scan window is already claimed by a different intent, so
    // this tick's withdrawal must fall through to the second matching sig.
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w2", status: "confirmed" }),
    ]);
    getSignaturesForAddress.mockResolvedValueOnce([
      releaseSignature(TAKEN_RELEASE_SIG, null),
      releaseSignature(FREE_RELEASE_SIG, null),
    ]);
    getTransaction
      .mockResolvedValueOnce(releaseTransfer(1n, "10000000"))
      .mockResolvedValueOnce(releaseTransfer(2n, "10000000"));
    // First claim (sigTaken) fails PK; findByIntent returns null → signature-
    // side conflict. Second claim (sigFree) succeeds.
    observationRepo.claimSettlement
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(async (input: Record<string, unknown>) => ({
        ...input,
        observed_at: NOW_ISO,
      }));
    observationRepo.findByIntent.mockResolvedValueOnce(null);

    await track();

    expect(observationRepo.claimSettlement).toHaveBeenCalledTimes(2);
    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "w2",
        status: "settled",
        settlementRef: FREE_RELEASE_SIG,
        expectedStatus: "confirmed",
      })
    );
    // Not stuck — sibling walk found a fresh sig.
    expect(withdrawalRepo.patchContext).not.toHaveBeenCalled();
  });
});
