import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";

// --- Mocks (hoisted so the vi.mock factories can reference them) --------------

const { withdrawalRepo, instanceRepo, observationRepo, releaseScanRepo, mocks } = vi.hoisted(() => {
  const withdrawalRepo = {
    listNonTerminal: vi.fn(),
    updateWithdrawal: vi.fn(async (input: Record<string, unknown>) => ({ ...input })),
    patchContext: vi.fn(async () => undefined),
    countNonTerminalByInstanceAndMint: vi.fn(async (_instanceId: string, _mint: string) => 0),
  };
  const instanceRepo = {
    getById: vi.fn(),
  };
  const observationRepo = {
    claimSettlement: vi.fn(),
    findByIntent: vi.fn(),
  };
  const releaseScanRepo = {
    getScan: vi.fn(async (): Promise<unknown> => null),
    advanceScan: vi.fn(async () => undefined),
    deepenSweep: vi.fn(async () => undefined),
    clearSweep: vi.fn(async () => undefined),
  };
  return {
    withdrawalRepo,
    instanceRepo,
    observationRepo,
    releaseScanRepo,
    mocks: {
      createWithdrawalRepo: vi.fn(() => withdrawalRepo),
      createInstanceRepo: vi.fn(() => instanceRepo),
      createObservationRepo: vi.fn(() => observationRepo),
      createReleaseScanRepo: vi.fn(() => releaseScanRepo),
    },
  };
});
vi.mock("@/db/repositories", () => ({
  createPrivateChannelWithdrawalRepository: mocks.createWithdrawalRepo,
  createPrivateChannelInstanceRepository: mocks.createInstanceRepo,
  createPrivateChannelSettlementObservationRepository: mocks.createObservationRepo,
  createPrivateChannelReleaseScanRepository: mocks.createReleaseScanRepo,
}));

const { createRpc, getSignatureStatuses, getSignaturesForAddress, getTransaction } = vi.hoisted(
  () => ({
    createRpc: vi.fn(() => ({ __rpc: true })),
    getSignatureStatuses: vi.fn(),
    // Deliberately untyped: tests install paging and per-signature
    // implementations with different arities.
    getSignaturesForAddress: vi.fn(),
    getTransaction: vi.fn(),
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
  // Default: the batch holds every non-terminal withdrawal of the group —
  // the group count equals the fixture's rows for that (instance, mint).
  withdrawalRepo.countNonTerminalByInstanceAndMint.mockImplementation(
    async (instanceId: string, mint: string) => {
      const settled = withdrawalRepo.listNonTerminal.mock.settledResults[0];
      const rows = (settled?.type === "fulfilled" ? settled.value : []) as Array<
        Record<string, unknown>
      >;
      return rows.filter(
        (r) =>
          r.instance_id === instanceId &&
          r.mint === mint &&
          ["pending", "submitted", "confirmed"].includes(r.status as string)
      ).length;
    }
  );
  instanceRepo.getById.mockResolvedValue(instanceRow());
  getSignaturesForAddress.mockResolvedValue([]);
  getTransaction.mockResolvedValue(null);
  releaseScanRepo.getScan.mockResolvedValue(null);
  releaseScanRepo.advanceScan.mockResolvedValue(undefined);
  releaseScanRepo.deepenSweep.mockResolvedValue(undefined);
  releaseScanRepo.clearSweep.mockResolvedValue(undefined);
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

  it("batches submitted burns sharing a gateway into one getSignatureStatuses call", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "submitted", signature: "burnsig1" }),
      withdrawalRow({ id: "w2", status: "submitted", signature: "burnsig2" }),
    ]);
    getSignatureStatuses.mockResolvedValueOnce([
      { confirmationStatus: "confirmed" },
      { err: { InstructionError: [0, "Custom"] } },
    ]);

    await trackPendingWithdrawals({} as Env);

    // One batched read for the whole tick, not one RPC per row; one RPC client
    // per gateway.
    expect(createRpc).toHaveBeenCalledTimes(1);
    expect(getSignatureStatuses).toHaveBeenCalledTimes(1);
    expect(getSignatureStatuses).toHaveBeenCalledWith(expect.anything(), ["burnsig1", "burnsig2"], {
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
      withdrawalRow({ id: "w1", status: "submitted", signature: "burnsig1" }),
      withdrawalRow({
        id: "w2",
        instance_id: "inst-2",
        status: "submitted",
        signature: "burnsig2",
      }),
    ]);
    instanceRepo.getById
      .mockResolvedValueOnce(instanceRow({ gateway_url: "http://gw-a" }))
      .mockResolvedValueOnce(instanceRow({ id: "inst-2", gateway_url: "http://gw-b" }));
    getSignatureStatuses
      .mockResolvedValueOnce([{ confirmationStatus: "confirmed" }])
      .mockResolvedValueOnce([{ confirmationStatus: "confirmed" }]);

    await trackPendingWithdrawals({} as Env);

    expect(createRpc).toHaveBeenCalledTimes(2);
    expect(getSignatureStatuses).toHaveBeenCalledTimes(2);
    expect(getSignatureStatuses).toHaveBeenCalledWith(expect.anything(), ["burnsig1"], {
      searchTransactionHistory: true,
    });
    expect(getSignatureStatuses).toHaveBeenCalledWith(expect.anything(), ["burnsig2"], {
      searchTransactionHistory: true,
    });
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

  it("promotes a stale pending withdrawal that carries a burn signature and asks the gateway", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w7", status: "pending", signature: "sig7", updated_at: STALE_ISO }),
    ]);
    getSignatureStatuses.mockResolvedValueOnce([{ confirmationStatus: "confirmed" }]);

    await trackPendingWithdrawals({} as Env);

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

    await trackPendingWithdrawals({} as Env);

    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "w8", status: "failed", expectedSignatureAbsent: true })
    );
  });

  it("settles a confirmed withdrawal when a matching devnet transfer is found on the instance ATA", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed" }),
    ]);
    getSignaturesForAddress.mockResolvedValueOnce([
      {
        signature: "relSig",
        err: null,
        slot: 1n,
        blockTime: BigInt(Math.floor(Date.parse(NOW_ISO) / 1000) - 60),
      },
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

    // Scanned the CURRENT instance's escrow ATA on devnet, one full page at a
    // time.
    expect(getSignaturesForAddress).toHaveBeenCalledWith(
      expect.anything(),
      `ata:${ESCROW_INSTANCE}`,
      expect.objectContaining({ limit: 1000 })
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
      { signature: "relSig", err: null, slot: 1n, blockTime: null },
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
      { signature: "relSig", err: null, slot: 1n, blockTime: null },
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

  // SOLA9-157: 1000 successful transactions that merely reference the escrow
  // ATA (system transfers listing it as a readonly account) fill the first
  // history page, and the real release sits one page older. The reconciler
  // must page back with `before` and settle the withdrawal anyway.
  it("settles a release buried under a full page of escrow-ATA history spam by paging back with before", async () => {
    const SPAM = 1000;
    const spamSigs = Array.from({ length: SPAM }, (_, i) => `spamSig${i}`); // newest first
    const releaseSig = "releaseSig";
    const sec = Math.floor(Date.parse(NOW_ISO) / 1000);
    getSignaturesForAddress.mockImplementation(
      async (_rpc: unknown, _addr: unknown, options: { limit?: number; before?: string } = {}) => {
        if (!options.before) {
          return spamSigs.slice(0, options.limit ?? 100).map((signature, i) => ({
            signature,
            err: null,
            slot: BigInt(5000 - i),
            blockTime: BigInt(sec - 10 - i),
          }));
        }
        if (options.before === spamSigs[SPAM - 1]) {
          return [
            {
              signature: releaseSig,
              err: null,
              slot: 1n,
              blockTime: BigInt(sec - 2000),
            },
          ];
        }
        return [];
      }
    );
    getTransaction.mockImplementation(async (_rpc: unknown, signature: string) => {
      if (signature === releaseSig) {
        return {
          slot: 1n,
          err: null,
          instructions: [
            {
              programId: "tok",
              parsedType: "transfer",
              info: { destination: `ata:${DESTINATION}`, amount: "10000000" },
            },
          ],
        };
      }
      // Spam transactions parse to no SPL token transfer.
      return { slot: 1n, err: null, instructions: [] };
    });
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed" }),
    ]);

    await trackPendingWithdrawals({} as Env);

    // Paged past the full newest page to recover the buried release.
    expect(getSignaturesForAddress).toHaveBeenCalledTimes(2);
    expect(getSignaturesForAddress).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      `ata:${ESCROW_INSTANCE}`,
      expect.objectContaining({ before: spamSigs[SPAM - 1] })
    );
    expect(observationRepo.claimSettlement).toHaveBeenCalledWith(
      expect.objectContaining({
        signature: releaseSig,
        intentKind: "withdrawal",
        intentId: "w1",
      })
    );
    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "w1",
        status: "settled",
        settlementRef: releaseSig,
        expectedStatus: "confirmed",
      })
    );
  });

  it("walks past a signature-side PK conflict to the next matching release", async () => {
    // Simulates a same-content sibling settled in a previous tick: the deepest
    // (oldest) release in the walk — parsed first, matched first — is already
    // claimed by a different intent, so this tick's withdrawal must fall
    // through to the next matching sig.
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w2", status: "confirmed" }),
    ]);
    // Newest first on the wire: sigFree is the newest, sigTaken the oldest.
    getSignaturesForAddress.mockResolvedValueOnce([
      { signature: "sigFree", err: null, slot: 2n, blockTime: null },
      { signature: "sigTaken", err: null, slot: 1n, blockTime: null },
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
    // First claim (sigTaken, the deepest) fails PK; findByIntent returns null →
    // signature-side conflict. Second claim (sigFree) succeeds.
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

  it("persists the scan cursor over the parsed region after settling", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed" }),
    ]);
    getSignaturesForAddress.mockResolvedValueOnce([
      {
        signature: "relSig",
        err: null,
        slot: 7n,
        blockTime: BigInt(Math.floor(Date.parse(NOW_ISO) / 1000) - 60),
      },
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

    await trackPendingWithdrawals({} as Env);

    expect(releaseScanRepo.getScan).toHaveBeenCalledWith("inst-X", MINT, `ata:${ESCROW_INSTANCE}`);
    expect(releaseScanRepo.advanceScan).toHaveBeenCalledWith({
      instanceId: "inst-X",
      mint: MINT,
      vaultAta: `ata:${ESCROW_INSTANCE}`,
      cursor: { signature: "relSig", slot: "7" },
    });
  });

  it("skips history at or behind the persisted cursor without re-parsing it", async () => {
    releaseScanRepo.getScan.mockResolvedValue({
      cursor: { signature: "cursorSig", slot: "40" },
      sweep: null,
    });
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed" }),
    ]);
    // Newest first: a fresh release above the cursor, then the cursor itself.
    getSignaturesForAddress.mockResolvedValueOnce([
      {
        signature: "relNew",
        err: null,
        slot: 60n,
        blockTime: BigInt(Math.floor(Date.parse(NOW_ISO) / 1000) - 30),
      },
      { signature: "cursorSig", err: null, slot: 40n, blockTime: null },
    ]);
    getTransaction.mockImplementation(async (_rpc: unknown, signature: string) => {
      if (signature === "relNew") {
        return {
          slot: 1n,
          err: null,
          instructions: [
            {
              programId: "tok",
              parsedType: "transfer",
              info: { destination: `ata:${DESTINATION}`, amount: "10000000" },
            },
          ],
        };
      }
      return { slot: 1n, err: null, instructions: [] };
    });

    await trackPendingWithdrawals({} as Env);

    // The walk stopped at the cursor: nothing at or behind it was re-parsed.
    expect(getTransaction).not.toHaveBeenCalledWith(expect.anything(), "cursorSig");
    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "w1", status: "settled", settlementRef: "relNew" })
    );
    // The frontier moves up over the parsed region (never backward).
    expect(releaseScanRepo.advanceScan).toHaveBeenCalledWith({
      instanceId: "inst-X",
      mint: MINT,
      vaultAta: `ata:${ESCROW_INSTANCE}`,
      cursor: { signature: "relNew", slot: "60" },
    });
  });

  it("holds the cursor when a submitted withdrawal shares the group — its release may already be on chain", async () => {
    // The submitted withdrawal is not in the release group (only confirmed
    // rows match), but its release can already exist: if the cursor advanced
    // past a parsed-but-unmatched release, the submitted withdrawal could
    // never claim it once it confirms.
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed" }),
      withdrawalRow({ id: "w2", status: "submitted", signature: "burnsig" }),
    ]);
    getSignatureStatuses.mockResolvedValueOnce([]);
    getSignaturesForAddress.mockResolvedValueOnce([
      {
        signature: "relSig",
        err: null,
        slot: 7n,
        blockTime: BigInt(Math.floor(Date.parse(NOW_ISO) / 1000) - 60),
      },
    ]);
    getTransaction.mockResolvedValue({
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

    await trackPendingWithdrawals({} as Env);

    // The confirmed withdrawal still settles.
    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "w1", status: "settled", settlementRef: "relSig" })
    );
    expect(releaseScanRepo.advanceScan).not.toHaveBeenCalled();
  });

  it("advances the cursor when unrelated groups fill the global batch but this group is complete", async () => {
    // 100 non-terminal rows total (batch full), but the extra 99 belong to a
    // different instance: this group's own unsettled set is fully in the
    // batch, so unrelated volume must not hold its progress hostage.
    const other = Array.from({ length: 99 }, (_, i) =>
      withdrawalRow({ id: `wOther${i}`, instance_id: "inst-other", status: "confirmed" })
    );
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed" }),
      ...other,
    ]);
    instanceRepo.getById.mockImplementation(async (id: string) =>
      id === "inst-other"
        ? instanceRow({ id: "inst-other", escrow_instance_addr: DESTINATION })
        : instanceRow()
    );
    getSignaturesForAddress.mockImplementation(async (_rpc: unknown, vaultAta: string) =>
      vaultAta === `ata:${ESCROW_INSTANCE}`
        ? [
            {
              signature: "relSig",
              err: null,
              slot: 7n,
              blockTime: BigInt(Math.floor(Date.parse(NOW_ISO) / 1000) - 60),
            },
          ]
        : []
    );
    getTransaction.mockImplementation(async (_rpc: unknown, signature: string) => {
      if (signature === "relSig") {
        return {
          slot: 1n,
          err: null,
          instructions: [
            {
              programId: "tok",
              parsedType: "transfer",
              info: { destination: `ata:${DESTINATION}`, amount: "10000000" },
            },
          ],
        };
      }
      return { slot: 1n, err: null, instructions: [] };
    });

    await trackPendingWithdrawals({} as Env);

    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "w1", status: "settled", settlementRef: "relSig" })
    );
    expect(releaseScanRepo.advanceScan).toHaveBeenCalledWith({
      instanceId: "inst-X",
      mint: MINT,
      vaultAta: `ata:${ESCROW_INSTANCE}`,
      cursor: { signature: "relSig", slot: "7" },
    });
  });

  it("holds the cursor when the batch was truncated past this group's rows", async () => {
    // One confirmed row made it into the batch, but the group has another
    // non-terminal withdrawal beyond MAX_PER_RUN that could claim a parsed
    // release — the cursor must not move.
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed" }),
    ]);
    withdrawalRepo.countNonTerminalByInstanceAndMint.mockResolvedValueOnce(2);
    getSignaturesForAddress.mockResolvedValueOnce([
      {
        signature: "relSig",
        err: null,
        slot: 7n,
        blockTime: BigInt(Math.floor(Date.parse(NOW_ISO) / 1000) - 60),
      },
    ]);
    getTransaction.mockResolvedValue({
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

    await trackPendingWithdrawals({} as Env);

    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "w1", status: "settled", settlementRef: "relSig" })
    );
    expect(releaseScanRepo.advanceScan).not.toHaveBeenCalled();
  });

  it("holds the cursor when the group's unsettled set exceeds the confirmed rows in the batch", async () => {
    // One confirmed withdrawal plus enough submitted rows (same instance and
    // mint) to fill the batch: the release is found and settled, but those
    // submitted withdrawals could still claim a parsed-but-unmatched release,
    // so the cursor must not move.
    const submitted = Array.from({ length: 99 }, (_, i) =>
      withdrawalRow({ id: `wSub${i}`, status: "submitted", signature: `burnsig${i}` })
    );
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed" }),
      ...submitted,
    ]);
    getSignatureStatuses.mockResolvedValueOnce(
      Array.from({ length: 99 }, () => ({ confirmationStatus: "confirmed" }))
    );
    getSignaturesForAddress.mockResolvedValueOnce([
      {
        signature: "relSig",
        err: null,
        slot: 1n,
        blockTime: BigInt(Math.floor(Date.parse(NOW_ISO) / 1000) - 60),
      },
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

    await trackPendingWithdrawals({} as Env);

    expect(withdrawalRepo.updateWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "w1", status: "settled", settlementRef: "relSig" })
    );
    expect(releaseScanRepo.advanceScan).not.toHaveBeenCalled();
  });

  it("caps getTransaction parsing at the per-group budget and advances the cursor to the parsed frontier", async () => {
    const COUNT = 350; // > RELEASE_PARSE_BUDGET (300)
    const spam = Array.from({ length: COUNT }, (_, i) => ({
      signature: `spam${i}`, // newest first
      err: null,
      slot: BigInt(COUNT - i),
      blockTime: BigInt(Math.floor(Date.parse(NOW_ISO) / 1000) - 10 - i),
    }));
    getSignaturesForAddress.mockResolvedValueOnce(spam);
    getTransaction.mockResolvedValue({ slot: 1n, err: null, instructions: [] });
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed" }),
    ]);

    await trackPendingWithdrawals({} as Env);

    expect(getTransaction).toHaveBeenCalledTimes(300);
    // Parsing walked oldest first: the frontier sits 300 signatures deep, and
    // the 50 newest were left unparsed above it.
    expect(releaseScanRepo.advanceScan).toHaveBeenCalledWith({
      instanceId: "inst-X",
      mint: MINT,
      vaultAta: `ata:${ESCROW_INSTANCE}`,
      cursor: { signature: "spam50", slot: (350 - 50).toString() },
    });
  });

  it("parses nothing and holds the cursor when a lookup fails", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed" }),
    ]);
    getSignaturesForAddress.mockResolvedValueOnce([
      {
        signature: "relSig",
        err: null,
        slot: 1n,
        blockTime: BigInt(Math.floor(Date.parse(NOW_ISO) / 1000) - 60),
      },
    ]);
    getTransaction.mockRejectedValueOnce(new Error("rpc unavailable"));

    await trackPendingWithdrawals({} as Env);

    expect(withdrawalRepo.updateWithdrawal).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "settled" })
    );
    // A failed lookup must not be skipped for good: the cursor stays put.
    expect(releaseScanRepo.advanceScan).not.toHaveBeenCalled();
  });

  it("never walks below the created_at lower bound on a first scan", async () => {
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed" }),
    ]);
    // Newest first: a recent non-matching entry, then an entry older than the
    // intent's creation minus the skew margin. Even a content-matching release
    // down there predates the withdrawal and must not be consumed.
    getSignaturesForAddress.mockResolvedValueOnce([
      {
        signature: "recentSig",
        err: null,
        slot: 2n,
        blockTime: BigInt(Math.floor(Date.parse(NOW_ISO) / 1000) - 30),
      },
      {
        signature: "ancientSig",
        err: null,
        slot: 1n,
        blockTime: BigInt(Math.floor(Date.parse(NOW_ISO) / 1000) - 3 * 60 * 60),
      },
    ]);
    getTransaction.mockImplementation(async (_rpc: unknown, signature: string) => {
      if (signature === "ancientSig") {
        return {
          slot: 1n,
          err: null,
          instructions: [
            {
              programId: "tok",
              parsedType: "transfer",
              info: { destination: `ata:${DESTINATION}`, amount: "10000000" },
            },
          ],
        };
      }
      return { slot: 1n, err: null, instructions: [] };
    });

    await trackPendingWithdrawals({} as Env);

    expect(getTransaction).not.toHaveBeenCalledWith(expect.anything(), "ancientSig");
    expect(withdrawalRepo.updateWithdrawal).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "settled" })
    );
    // The walk reached its bound, so the parsed region above it is contiguous
    // and the cursor still advances over it.
    expect(releaseScanRepo.advanceScan).toHaveBeenCalledWith({
      instanceId: "inst-X",
      mint: MINT,
      vaultAta: `ata:${ESCROW_INSTANCE}`,
      cursor: { signature: "recentSig", slot: "2" },
    });
  });

  it("parses only the newest band and holds the cursor when history exceeds the page cap", async () => {
    const PAGES = 21; // > RELEASE_SCAN_MAX_PAGES (20)
    const history = Array.from({ length: PAGES * 1000 }, (_, i) => ({
      signature: `t${i}`, // newest first
      err: null,
      slot: BigInt(PAGES * 1000 - i),
      // All inside the created_at lower bound, so the page cap — not the time
      // bound — is what stops the walk.
      blockTime: BigInt(Math.floor(Date.parse(NOW_ISO) / 1000) - 10 - Math.floor(i / 1000)),
    }));
    getSignaturesForAddress.mockImplementation(
      async (_rpc: unknown, _addr: unknown, options: { limit?: number; before?: string } = {}) => {
        const start = options.before
          ? history.findIndex((entry) => entry.signature === options.before) + 1
          : 0;
        return history.slice(start, start + (options.limit ?? 100));
      }
    );
    getTransaction.mockResolvedValue({ slot: 1n, err: null, instructions: [] });
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed" }),
    ]);

    await trackPendingWithdrawals({} as Env);

    expect(getSignaturesForAddress).toHaveBeenCalledTimes(20);
    // Budget-capped parse of the newest band, but no cursor movement: the
    // region below the walked window is unexplored and stays due.
    expect(getTransaction).toHaveBeenCalledTimes(300);
    expect(releaseScanRepo.advanceScan).not.toHaveBeenCalled();
    // The walk's deepest listed point is persisted so the next tick can
    // resume listing below it instead of re-reading the same band forever.
    expect(releaseScanRepo.deepenSweep).toHaveBeenCalledWith({
      instanceId: "inst-X",
      mint: MINT,
      vaultAta: `ata:${ESCROW_INSTANCE}`,
      sweep: { signature: "t19999", slot: "1001" },
    });
    expect(withdrawalRepo.updateWithdrawal).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "settled" })
    );
  });

  it("resumes listing below the persisted sweep on the next tick and advances the frontier", async () => {
    const PAGES = 21; // > RELEASE_SCAN_MAX_PAGES (20)
    const history = Array.from({ length: PAGES * 1000 }, (_, i) => ({
      signature: `t${i}`, // newest first
      err: null,
      slot: BigInt(PAGES * 1000 - i),
      // All inside the created_at lower bound, so the page cap — not the time
      // bound — is what stops the walk.
      blockTime: BigInt(Math.floor(Date.parse(NOW_ISO) / 1000) - 10 - Math.floor(i / 1000)),
    }));
    getSignaturesForAddress.mockImplementation(
      async (_rpc: unknown, _addr: unknown, options: { limit?: number; before?: string } = {}) => {
        const start = options.before
          ? history.findIndex((entry) => entry.signature === options.before) + 1
          : 0;
        return history.slice(start, start + (options.limit ?? 100));
      }
    );
    getTransaction.mockResolvedValue({ slot: 1n, err: null, instructions: [] });
    withdrawalRepo.listNonTerminal.mockResolvedValue([
      withdrawalRow({ id: "w1", status: "confirmed" }),
    ]);
    // The previous tick capped out here and persisted its deepest listed point.
    releaseScanRepo.getScan.mockResolvedValue({
      cursor: null,
      sweep: { signature: "t19999", slot: "1001" },
    });

    await trackPendingWithdrawals({} as Env);

    // Phase 1 listed the fresh tip band, then phase 2 resumed below the sweep
    // position — the backlog is not re-read from the tip forever.
    expect(getSignaturesForAddress).toHaveBeenCalledWith(
      expect.anything(),
      `ata:${ESCROW_INSTANCE}`,
      expect.objectContaining({ before: "t19999" })
    );
    // The resumed walk reached history's end, so the listed region is
    // contiguous down to a provable stopping point and the frontier advances
    // over the parsed prefix (oldest first, budget-capped at 300).
    expect(releaseScanRepo.advanceScan).toHaveBeenCalledWith({
      instanceId: "inst-X",
      mint: MINT,
      vaultAta: `ata:${ESCROW_INSTANCE}`,
      cursor: { signature: "t20700", slot: "300" },
    });
  });

  it("clears the sweep once the frontier consumes the listed backlog", async () => {
    releaseScanRepo.getScan.mockResolvedValue({
      cursor: { signature: "cursorSig", slot: "500" },
      sweep: { signature: "sweepSig", slot: "400" },
    });
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed" }),
    ]);
    getSignaturesForAddress.mockResolvedValueOnce([
      { signature: "relNew", err: null, slot: 600n, blockTime: null },
      { signature: "cursorSig", err: null, slot: 500n, blockTime: null },
    ]);
    getTransaction.mockImplementation(async (_rpc: unknown, signature: string) => {
      if (signature === "relNew") {
        return {
          slot: 1n,
          err: null,
          instructions: [
            {
              programId: "tok",
              parsedType: "transfer",
              info: { destination: `ata:${DESTINATION}`, amount: "10000000" },
            },
          ],
        };
      }
      return { slot: 1n, err: null, instructions: [] };
    });

    await trackPendingWithdrawals({} as Env);

    // The frontier (slot 600) moved past the sweep position (slot 400):
    // nothing is left to resume below it.
    expect(releaseScanRepo.advanceScan).toHaveBeenCalledWith({
      instanceId: "inst-X",
      mint: MINT,
      vaultAta: `ata:${ESCROW_INSTANCE}`,
      cursor: { signature: "relNew", slot: "600" },
    });
    expect(releaseScanRepo.clearSweep).toHaveBeenCalledWith({
      instanceId: "inst-X",
      mint: MINT,
      vaultAta: `ata:${ESCROW_INSTANCE}`,
    });
  });

  it("never advances the frontier across the unlisted gap above a resumed band", async () => {
    // Sweep mode: the tip band covers the newest 2000 entries and the resumed
    // band lists down to the cursor, but the region between them is not
    // relisted this tick. Even with the whole band parsed, the frontier must
    // stop at its top — a release sitting in the gap was never examined.
    const tipPage = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) => {
        const slot = start - i;
        return { signature: `tip${slot}`, err: null, slot: BigInt(slot), blockTime: null };
      });
    const band = Array.from({ length: 100 }, (_, i) => {
      const slot = 150 - i; // newest first: 150 down to 51
      return { signature: `b${slot}`, err: null, slot: BigInt(slot), blockTime: null };
    });
    releaseScanRepo.getScan.mockResolvedValue({
      cursor: { signature: "c50", slot: "50" },
      sweep: { signature: "anchor151", slot: "151" },
    });
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed" }),
    ]);
    getSignaturesForAddress.mockImplementation(
      async (_rpc: unknown, _addr: unknown, options: { before?: string } = {}) => {
        if (!options.before) return tipPage(2300, 1000);
        if (options.before === "tip1301") return tipPage(1300, 1000);
        if (options.before === "anchor151") return band;
        return [];
      }
    );
    getTransaction.mockResolvedValue({ slot: 1n, err: null, instructions: [] });

    await trackPendingWithdrawals({} as Env);

    // The frontier stops at the band's top (just below the sweep position).
    expect(releaseScanRepo.advanceScan).toHaveBeenCalledWith({
      instanceId: "inst-X",
      mint: MINT,
      vaultAta: `ata:${ESCROW_INSTANCE}`,
      cursor: { signature: "b150", slot: "150" },
    });
    // The band is fully parsed and consumed, so the sweep clears and the next
    // tick lists the gap contiguously from the tip.
    expect(releaseScanRepo.clearSweep).toHaveBeenCalledWith({
      instanceId: "inst-X",
      mint: MINT,
      vaultAta: `ata:${ESCROW_INSTANCE}`,
    });
  });

  it("advances the frontier through the former gap once the sweep cleared", async () => {
    // Follow-up tick to the scenario above: the sweep is gone, so the walk
    // lists the whole region from the tip contiguously and the frontier can
    // cross the formerly unlisted gap.
    const tipPage = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) => {
        const slot = start - i;
        return { signature: `tip${slot}`, err: null, slot: BigInt(slot), blockTime: null };
      });
    releaseScanRepo.getScan.mockResolvedValue({
      cursor: { signature: "b150", slot: "150" },
      sweep: null,
    });
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed" }),
    ]);
    getSignaturesForAddress.mockImplementation(
      async (_rpc: unknown, _addr: unknown, options: { before?: string } = {}) => {
        if (!options.before) return tipPage(2300, 1000);
        if (options.before === "tip1301") return tipPage(1300, 1000);
        if (options.before === "tip301") return tipPage(300, 150); // 300..151, then history ends
        return [];
      }
    );
    getTransaction.mockResolvedValue({ slot: 1n, err: null, instructions: [] });

    await trackPendingWithdrawals({} as Env);

    // Parsing walked oldest first, so the frontier sits 300 signatures above
    // the cursor — across the gap, which is now listed contiguously.
    expect(releaseScanRepo.advanceScan).toHaveBeenCalledWith({
      instanceId: "inst-X",
      mint: MINT,
      vaultAta: `ata:${ESCROW_INSTANCE}`,
      cursor: { signature: "tip450", slot: "450" },
    });
  });

  it("ignores a sweep position at or behind the parsed frontier", async () => {
    // A stale sweep (clear that lost a race) must not send the walk listing
    // already-consumed history.
    releaseScanRepo.getScan.mockResolvedValue({
      cursor: { signature: "cursorSig", slot: "500" },
      sweep: { signature: "staleSweepSig", slot: "500" },
    });
    withdrawalRepo.listNonTerminal.mockResolvedValueOnce([
      withdrawalRow({ id: "w1", status: "confirmed" }),
    ]);
    getSignaturesForAddress.mockResolvedValueOnce([
      { signature: "relNew", err: null, slot: 600n, blockTime: null },
      { signature: "cursorSig", err: null, slot: 500n, blockTime: null },
    ]);
    getTransaction.mockResolvedValue({ slot: 1n, err: null, instructions: [] });

    await trackPendingWithdrawals({} as Env);

    // Tip band only — no sweep phase below the frontier.
    expect(getSignaturesForAddress).toHaveBeenCalledTimes(1);
    expect(releaseScanRepo.advanceScan).toHaveBeenCalledWith({
      instanceId: "inst-X",
      mint: MINT,
      vaultAta: `ata:${ESCROW_INSTANCE}`,
      cursor: { signature: "relNew", slot: "600" },
    });
  });
});
