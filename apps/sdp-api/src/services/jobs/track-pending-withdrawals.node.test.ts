import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";

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

const { createRpc, getSignatureStatuses, getSignaturesForAddress, getTransaction } = vi.hoisted(
  () => ({
    createRpc: vi.fn(() => ({ __rpc: true })),
    getSignatureStatuses: vi.fn(),
    getSignaturesForAddress: vi.fn(async (): Promise<unknown[]> => []),
    getTransaction: vi.fn(async (): Promise<unknown> => null),
  })
);
vi.mock("@sdp/rpc/solana", () => ({
  createRpc,
  getSignatureStatuses,
  getSignaturesForAddress,
  getTransaction,
}));

const { loadProjectRpcClient } = vi.hoisted(() => {
  const PROJECT_RPC = { __projectRpc: true };
  return {
    loadProjectRpcClient: vi.fn(async () => ({
      cluster: "devnet",
      rpc: PROJECT_RPC,
      target: { endpoint: "https://project-rpc.example" },
    })),
  };
});
vi.mock("@/services/private-channels/project-rpc", () => ({ loadProjectRpcClient }));

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

// Valid base58 addresses (the reconciler runs `address()` on these fixtures).
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const ESCROW_INSTANCE = "7C1Pu8mbHaDDTFnGH8YTqemNDofqXP3XEotzSo6TbwHz";
const DESTINATION = "J231K9UEpS4y4KAPwGc4gsMNCjKFRMYcQBcjVW7vBhVi";
const NOW_ISO = "2026-07-17T00:00:00.000Z";
const RELEASE_STALE_ISO = "2026-07-16T20:00:00.000Z"; // > 30 min before NOW
const STALE_ISO = "2026-07-16T23:00:00.000Z"; // > 5 min before NOW

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
    signature: "burnsig",
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
  vi.useFakeTimers();
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
  it("does nothing when there are no non-terminal withdrawals", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([]);
    await trackPendingWithdrawals({} as Env);
    expect(withdrawalRepo.updateWithdrawal).not.toHaveBeenCalled();
  });

  it("confirms a submitted burn against the CURRENT instance gateway", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "submitted" }),
    ]);
    instanceRepo.getById.mockResolvedValueOnce(instanceRow({ gateway_url: "http://gw-live" }));
    getSignatureStatuses.mockResolvedValueOnce([{ confirmationStatus: "confirmed" }]);

    await trackPendingWithdrawals({} as Env);

    expect(createRpc).toHaveBeenCalledWith(expect.anything(), { rpcUrl: "http://gw-live" });
    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "w1", status: "confirmed", expectedStatus: "submitted" })
    );
  });

  it("fails a submitted burn that errored on-chain (pre-confirmation failure allowed)", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "submitted" }),
    ]);
    getSignatureStatuses.mockResolvedValueOnce([{ err: { InstructionError: [0, "Custom"] } }]);

    await trackPendingWithdrawals({} as Env);

    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "w1", status: "failed", expectedStatus: "submitted" })
    );
  });

  it("fails a signature-less pending withdrawal past the stale window", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "pending", signature: null, updated_at: STALE_ISO }),
    ]);

    await trackPendingWithdrawals({} as Env);

    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "w1", status: "failed", expectedStatus: "pending" })
    );
  });

  it("settles a confirmed withdrawal when a matching devnet transfer is found on the instance ATA", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed" }),
    ]);
    getSignaturesForAddress.mockResolvedValueOnce([
      { signature: "relSig", err: null, blockTime: 1_700_000_000n },
    ]);
    getTransaction.mockResolvedValueOnce({
      slot: 1n,
      err: null,
      instructions: [
        // amount "10" @ 6 decimals = 10_000_000 base units; destination = ata:<DESTINATION>
        {
          programId: "tok",
          parsedType: "transfer",
          info: { destination: `ata:${DESTINATION}`, amount: "10000000" },
        },
      ],
    });

    await trackPendingWithdrawals({} as Env);

    // Scanned the CURRENT instance's escrow ATA on devnet.
    expect(getSignaturesForAddress).toHaveBeenCalledWith(
      expect.anything(),
      `ata:${ESCROW_INSTANCE}`,
      expect.objectContaining({ limit: 100 })
    );
    // Attribution recorded in settlement_observations.
    expect(observationRepo.claimSettlement).toHaveBeenCalledWith(
      expect.objectContaining({
        signature: "relSig",
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
        settlementRef: "relSig",
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
    getSignaturesForAddress.mockResolvedValueOnce([
      { signature: "relSig", err: null, blockTime: null },
    ]);
    getTransaction.mockResolvedValueOnce({
      slot: 1n,
      err: null,
      instructions: [
        {
          programId: "tok",
          parsedType: "transfer",
          info: { destination: `ata:${DESTINATION}`, amount: "9999999" },
        },
      ],
    });

    await trackPendingWithdrawals({} as Env);

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

    await trackPendingWithdrawals({} as Env);

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

    await trackPendingWithdrawals({} as Env);

    expect(withdrawalRepo.patchContext).not.toHaveBeenCalled();
    expect(emitWithdrawalEvent).not.toHaveBeenCalled();
  });

  it("gracefully handles a claim conflict — reads the winning observation and still advances the intent", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed" }),
    ]);
    getSignaturesForAddress.mockResolvedValueOnce([
      { signature: "relSig", err: null, blockTime: null },
    ]);
    getTransaction.mockResolvedValueOnce({
      slot: 1n,
      err: null,
      instructions: [
        {
          programId: "tok",
          parsedType: "transfer",
          info: { destination: `ata:${DESTINATION}`, amount: "10000000" },
        },
      ],
    });
    // Racing poller won the claim.
    observationRepo.claimSettlement.mockResolvedValueOnce(null);
    observationRepo.findByIntent.mockResolvedValueOnce({
      signature: "otherSig",
      instruction_index: 0,
      intent_kind: "withdrawal",
      intent_id: "w1",
      destination: `ata:${DESTINATION}`,
      mint: MINT,
      amount: "10",
      block_time: null,
      observed_at: NOW_ISO,
    });

    await trackPendingWithdrawals({} as Env);

    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "w1",
        status: "settled",
        settlementRef: "otherSig",
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
      { signature: "sigTaken", err: null, blockTime: null },
      { signature: "sigFree", err: null, blockTime: null },
    ]);
    getTransaction
      .mockResolvedValueOnce({
        slot: 1n,
        err: null,
        instructions: [
          {
            programId: "tok",
            parsedType: "transfer",
            info: { destination: `ata:${DESTINATION}`, amount: "10000000" },
          },
        ],
      })
      .mockResolvedValueOnce({
        slot: 2n,
        err: null,
        instructions: [
          {
            programId: "tok",
            parsedType: "transfer",
            info: { destination: `ata:${DESTINATION}`, amount: "10000000" },
          },
        ],
      });
    // First claim (sigTaken) fails PK; findByIntent returns null → signature-
    // side conflict. Second claim (sigFree) succeeds.
    observationRepo.claimSettlement
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(async (input: Record<string, unknown>) => ({
        ...input,
        observed_at: NOW_ISO,
      }));
    observationRepo.findByIntent.mockResolvedValueOnce(null);

    await trackPendingWithdrawals({} as Env);

    expect(observationRepo.claimSettlement).toHaveBeenCalledTimes(2);
    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "w2",
        status: "settled",
        settlementRef: "sigFree",
        expectedStatus: "confirmed",
      })
    );
    // Not stuck — sibling walk found a fresh sig.
    expect(withdrawalRepo.patchContext).not.toHaveBeenCalled();
  });
});
