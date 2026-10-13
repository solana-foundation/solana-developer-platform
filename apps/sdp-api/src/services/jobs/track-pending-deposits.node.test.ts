import { runInClusterScope } from "@sdp/rpc/scope";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installClusterRpcResponder,
  type StubSignatureStatus,
  signatureStatusesRead,
} from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import { testSignature } from "@/test/helpers/signatures";

// --- Mocks (hoisted so the vi.mock factories can reference them) --------------

const { depositRepo, instanceRepo, createDepositRepo, createInstanceRepo } = vi.hoisted(() => {
  const depositRepo = {
    listNonTerminal: vi.fn(),
    updateDeposit: vi.fn(async (input: Record<string, unknown>) => ({ ...input })),
  };
  const instanceRepo = {
    getById: vi.fn(),
  };
  return {
    depositRepo,
    instanceRepo,
    createDepositRepo: vi.fn(() => depositRepo),
    createInstanceRepo: vi.fn(() => instanceRepo),
  };
});
vi.mock("@/db/repositories", () => ({
  createPrivateChannelDepositRepository: createDepositRepo,
  createPrivateChannelInstanceRepository: createInstanceRepo,
}));

// Runtime event service; we assert emitDepositEvent is called with the right type.
const { emitDepositEvent } = vi.hoisted(() => ({ emitDepositEvent: vi.fn() }));
vi.mock("@/services/private-channels/deposit-events", () => ({ emitDepositEvent }));

import { trackPendingDeposits } from "./track-pending-deposits";

const NOW_ISO = "2026-07-17T00:00:00.000Z";
const STALE_ISO = "2026-07-16T23:00:00.000Z"; // > 5 min in the past

const SIG_1 = testSignature(1);
const SIG_2 = testSignature(2);
const SIG_3 = testSignature(3);
const SIG_4 = testSignature(4);
const SIG_6 = testSignature(6);
const SIG_7 = testSignature(7);
const SIG_8 = testSignature(8);

const CONFIRMED: StubSignatureStatus = {
  slot: 1,
  confirmations: 1,
  confirmationStatus: "confirmed",
  err: null,
};
const FINALIZED: StubSignatureStatus = {
  slot: 1,
  confirmations: null,
  confirmationStatus: "finalized",
  err: null,
};
const ERRORED: StubSignatureStatus = {
  slot: 1,
  confirmations: 1,
  confirmationStatus: "confirmed",
  err: { InstructionError: [0, "InvalidAccountData"] },
};

function depositRow(overrides: Record<string, unknown>) {
  return {
    id: "dep",
    organization_id: "org",
    project_id: "proj",
    instance_id: "inst-X",
    wallet_id: "w-1",
    depositor: "depositor-1",
    recipient: "recipient-1",
    mint: "mint-1",
    amount: "10",
    status: "submitted",
    signature: SIG_1,
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
    escrow_instance_addr: "instAddr",
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
  depositRepo.updateDeposit.mockImplementation(async (input: Record<string, unknown>) => ({
    ...depositRow({}),
    ...input,
  }));
  instanceRepo.getById.mockResolvedValue(instanceRow());
});

describe("trackPendingDeposits", () => {
  const rpc = installClusterRpcResponder();

  function answerStatuses(statuses: ReadonlyMap<string, StubSignatureStatus>): void {
    rpc.respondSignatureStatuses((signature) => {
      const status = statuses.get(signature);
      return status === undefined ? null : status;
    });
  }

  function statusReads() {
    return rpc.requests
      .filter((request) => request.method === "getSignatureStatuses")
      .map(signatureStatusesRead);
  }

  function track() {
    return runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      trackPendingDeposits(env)
    );
  }

  it("does nothing when there are no non-terminal deposits", async () => {
    depositRepo.listNonTerminal.mockResolvedValueOnce([]);
    await track();
    expect(depositRepo.updateDeposit).not.toHaveBeenCalled();
    expect(rpc.calls).toEqual([]);
  });

  it("advances submitted → confirmed via the scope's cluster RPC", async () => {
    depositRepo.listNonTerminal.mockResolvedValueOnce([
      depositRow({ id: "d1", status: "submitted", signature: SIG_1 }),
    ]);
    answerStatuses(new Map([[SIG_1, CONFIRMED]]));

    await track();

    expect(statusReads()).toEqual([
      { cluster: "devnet", signatures: [SIG_1], searchTransactionHistory: true },
    ]);
    expect(depositRepo.updateDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d1", status: "confirmed", expectedStatus: "submitted" })
    );
    expect(emitDepositEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "d1" }),
      "transfer.deposit.confirmed",
      "confirmed",
      expect.any(Object)
    );
  });

  it("fails a submitted deposit whose signature returns an on-chain error", async () => {
    depositRepo.listNonTerminal.mockResolvedValueOnce([
      depositRow({ id: "d2", status: "submitted", signature: SIG_2 }),
    ]);
    answerStatuses(new Map([[SIG_2, ERRORED]]));

    await track();

    expect(depositRepo.updateDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d2", status: "failed", expectedStatus: "submitted" })
    );
    expect(emitDepositEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Object),
      "transfer.deposit.failed",
      "failed",
      expect.any(Object)
    );
  });

  it("does not fail a submitted deposit whose signature is briefly missing on-chain", async () => {
    depositRepo.listNonTerminal.mockResolvedValueOnce([
      depositRow({ id: "d3", status: "submitted", signature: SIG_3, updated_at: NOW_ISO }),
    ]);
    answerStatuses(new Map());

    await track();

    expect(depositRepo.updateDeposit).not.toHaveBeenCalled();
  });

  it("fails a submitted deposit whose signature has stayed missing past the stale window", async () => {
    depositRepo.listNonTerminal.mockResolvedValueOnce([
      depositRow({ id: "d4", status: "submitted", signature: SIG_4, updated_at: STALE_ISO }),
    ]);
    answerStatuses(new Map());

    await track();

    expect(depositRepo.updateDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d4", status: "failed", expectedStatus: "submitted" })
    );
  });

  it("fails a pending deposit that never got broadcast past the stale window", async () => {
    depositRepo.listNonTerminal.mockResolvedValueOnce([
      depositRow({ id: "d5", status: "pending", signature: null, updated_at: STALE_ISO }),
    ]);

    await track();

    expect(depositRepo.updateDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d5", status: "failed", expectedStatus: "pending" })
    );
  });

  it("promotes a stale pending deposit that carries a signature and asks the chain", async () => {
    depositRepo.listNonTerminal.mockResolvedValueOnce([
      depositRow({ id: "d7", status: "pending", signature: SIG_7, updated_at: STALE_ISO }),
    ]);
    answerStatuses(new Map([[SIG_7, FINALIZED]]));

    await track();

    expect(depositRepo.updateDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d7", status: "submitted", expectedStatus: "pending" })
    );
    expect(depositRepo.updateDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d7", status: "confirmed", expectedStatus: "submitted" })
    );
  });

  /**
   * The promotion only fires once the row is already older than the stale
   * window, which is well past the node's short recent-status cache. Polling
   * without searchTransactionHistory would read null for a deposit that DID
   * execute, fail it, and let the dashboard hand out a fresh idempotency key —
   * a second deposit of the same funds.
   */
  it("asks the chain's history when promoting, so an executed deposit is not failed", async () => {
    depositRepo.listNonTerminal.mockResolvedValueOnce([
      depositRow({ id: "d7b", status: "pending", signature: SIG_7, updated_at: STALE_ISO }),
    ]);
    answerStatuses(new Map([[SIG_7, FINALIZED]]));

    await track();

    expect(statusReads()).toEqual([
      { cluster: "devnet", signatures: [SIG_7], searchTransactionHistory: true },
    ]);
    expect(depositRepo.updateDeposit).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "d7b", status: "failed" })
    );
  });

  it("keeps a fresh pending deposit with a signature untouched for its live request", async () => {
    depositRepo.listNonTerminal.mockResolvedValueOnce([
      depositRow({ id: "d8", status: "pending", signature: SIG_8, updated_at: NOW_ISO }),
    ]);

    await track();

    expect(depositRepo.updateDeposit).not.toHaveBeenCalled();
  });

  it("leaves confirmed deposits alone — settled is unreachable under the chain oracle", async () => {
    depositRepo.listNonTerminal.mockResolvedValueOnce([
      depositRow({ id: "d6", status: "confirmed", signature: SIG_6 }),
    ]);

    await track();

    expect(depositRepo.updateDeposit).not.toHaveBeenCalled();
    expect(rpc.calls).toEqual([]);
  });

  it("stalls a submitted deposit whose instance was deleted, then fails it past the stale window", async () => {
    depositRepo.listNonTerminal.mockResolvedValueOnce([
      depositRow({ id: "d7", status: "submitted", signature: SIG_7, updated_at: STALE_ISO }),
    ]);
    instanceRepo.getById.mockResolvedValueOnce(null);

    await track();

    expect(depositRepo.updateDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d7", status: "failed", expectedStatus: "submitted" })
    );
  });

  it("batches every submitted deposit in the tick into one getSignatureStatuses call", async () => {
    depositRepo.listNonTerminal.mockResolvedValueOnce([
      depositRow({ id: "d1", status: "submitted", signature: SIG_1 }),
      depositRow({ id: "d2", status: "submitted", signature: SIG_2 }),
      depositRow({ id: "d3", status: "submitted", signature: SIG_3 }),
    ]);
    answerStatuses(
      new Map([
        [SIG_1, CONFIRMED],
        [SIG_2, ERRORED],
      ])
    );

    await track();

    expect(statusReads()).toEqual([
      { cluster: "devnet", signatures: [SIG_1, SIG_2, SIG_3], searchTransactionHistory: true },
    ]);
    expect(depositRepo.updateDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d1", status: "confirmed", expectedStatus: "submitted" })
    );
    expect(depositRepo.updateDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d2", status: "failed", expectedStatus: "submitted" })
    );
    expect(depositRepo.updateDeposit).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "d3", status: "failed" })
    );
  });

  it("batches the promoted signed-pending deposit alongside already-submitted rows", async () => {
    const rows = [
      depositRow({ id: "d1", status: "submitted", signature: SIG_1 }),
      depositRow({ id: "d2", status: "pending", signature: SIG_2, updated_at: STALE_ISO }),
    ];
    depositRepo.listNonTerminal.mockResolvedValueOnce(rows);
    // A real CAS update returns the full row, signature included.
    depositRepo.updateDeposit.mockImplementation(async (input: Record<string, unknown>) => {
      const original = rows.find((row) => row.id === input.id);
      return { ...(original ?? depositRow({})), ...input };
    });
    answerStatuses(
      new Map([
        [SIG_1, FINALIZED],
        [SIG_2, CONFIRMED],
      ])
    );

    await track();

    expect(statusReads()).toEqual([
      { cluster: "devnet", signatures: [SIG_1, SIG_2], searchTransactionHistory: true },
    ]);
    expect(depositRepo.updateDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d2", status: "submitted", expectedStatus: "pending" })
    );
    expect(depositRepo.updateDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d2", status: "confirmed", expectedStatus: "submitted" })
    );
  });

  it("leaves a malformed stored signature out of the batch and reconciles the rest", async () => {
    depositRepo.listNonTerminal.mockResolvedValueOnce([
      depositRow({ id: "d1", status: "submitted", signature: "not-a-signature" }),
      depositRow({ id: "d2", status: "submitted", signature: SIG_2 }),
    ]);
    answerStatuses(new Map([[SIG_2, CONFIRMED]]));

    await track();

    expect(statusReads()).toEqual([
      { cluster: "devnet", signatures: [SIG_2], searchTransactionHistory: true },
    ]);
    expect(depositRepo.updateDeposit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "d2", status: "confirmed", expectedStatus: "submitted" })
    );
  });

  it("skips no rows when the batched status read fails — the next tick rescans", async () => {
    depositRepo.listNonTerminal.mockResolvedValueOnce([
      depositRow({ id: "d1", status: "submitted", signature: SIG_1 }),
    ]);

    await track();

    expect(depositRepo.updateDeposit).not.toHaveBeenCalled();
    expect(emitDepositEvent).not.toHaveBeenCalled();
  });
});
