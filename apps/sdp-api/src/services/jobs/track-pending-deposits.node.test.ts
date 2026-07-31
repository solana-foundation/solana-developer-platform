import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";

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

const { createRpc, getSignatureStatuses } = vi.hoisted(() => ({
  createRpc: vi.fn(() => ({})),
  getSignatureStatuses: vi.fn(),
}));
vi.mock("@sdp/rpc/solana", () => ({ createRpc, getSignatureStatuses }));

import { trackPendingDeposits } from "./track-pending-deposits";

const NOW_ISO = "2026-07-17T00:00:00.000Z";
const STALE_ISO = "2026-07-16T23:00:00.000Z"; // > 5 min in the past

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
    signature: "sig",
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
    chain_rpc_url: "https://api.devnet.solana.com",
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
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
  depositRepo.updateDeposit.mockImplementation(async (input: Record<string, unknown>) => ({
    ...depositRow({}),
    ...input,
  }));
  instanceRepo.getById.mockResolvedValue(instanceRow());
});

describe("trackPendingDeposits", () => {
  it("does nothing when there are no non-terminal deposits", async () => {
    depositRepo.listNonTerminal.mockResolvedValueOnce([]);
    await trackPendingDeposits({} as Env);
    expect(depositRepo.updateDeposit).not.toHaveBeenCalled();
    expect(createRpc).not.toHaveBeenCalled();
  });

  it("advances submitted → confirmed via the CURRENT instance's chain RPC", async () => {
    depositRepo.listNonTerminal.mockResolvedValueOnce([
      depositRow({ id: "d1", status: "submitted", signature: "sig1" }),
    ]);
    // Instance may have been reconfigured; the reconciler reads the live row.
    instanceRepo.getById.mockResolvedValueOnce(
      instanceRow({ chain_rpc_url: "https://api.devnet.solana.com/new" })
    );
    getSignatureStatuses.mockResolvedValueOnce([{ confirmationStatus: "confirmed" }]);

    await trackPendingDeposits({} as Env);

    expect(createRpc).toHaveBeenCalledWith(expect.anything(), {
      rpcUrl: "https://api.devnet.solana.com/new",
    });
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
      depositRow({ id: "d2", status: "submitted", signature: "sig2" }),
    ]);
    getSignatureStatuses.mockResolvedValueOnce([{ err: { InstructionError: [0, "Custom"] } }]);

    await trackPendingDeposits({} as Env);

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
      depositRow({ id: "d3", status: "submitted", signature: "sig3", updated_at: NOW_ISO }),
    ]);
    getSignatureStatuses.mockResolvedValueOnce([undefined]);

    await trackPendingDeposits({} as Env);

    expect(depositRepo.updateDeposit).not.toHaveBeenCalled();
  });

  it("fails a submitted deposit whose signature has stayed missing past the stale window", async () => {
    depositRepo.listNonTerminal.mockResolvedValueOnce([
      depositRow({ id: "d4", status: "submitted", signature: "sig4", updated_at: STALE_ISO }),
    ]);
    getSignatureStatuses.mockResolvedValueOnce([undefined]);

    await trackPendingDeposits({} as Env);

    expect(depositRepo.updateDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d4", status: "failed", expectedStatus: "submitted" })
    );
  });

  it("fails a pending deposit that never got broadcast past the stale window", async () => {
    depositRepo.listNonTerminal.mockResolvedValueOnce([
      depositRow({ id: "d5", status: "pending", signature: null, updated_at: STALE_ISO }),
    ]);

    await trackPendingDeposits({} as Env);

    expect(depositRepo.updateDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d5", status: "failed", expectedStatus: "pending" })
    );
  });

  it("leaves confirmed deposits alone — settled is unreachable under the chain oracle", async () => {
    depositRepo.listNonTerminal.mockResolvedValueOnce([
      depositRow({ id: "d6", status: "confirmed", signature: "sig6" }),
    ]);

    await trackPendingDeposits({} as Env);

    expect(depositRepo.updateDeposit).not.toHaveBeenCalled();
    expect(createRpc).not.toHaveBeenCalled();
  });

  it("stalls a submitted deposit whose instance was deleted, then fails it past the stale window", async () => {
    depositRepo.listNonTerminal.mockResolvedValueOnce([
      depositRow({ id: "d7", status: "submitted", signature: "sig7", updated_at: STALE_ISO }),
    ]);
    instanceRepo.getById.mockResolvedValueOnce(null);

    await trackPendingDeposits({} as Env);

    expect(depositRepo.updateDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d7", status: "failed", expectedStatus: "submitted" })
    );
  });
});
