import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import { resolveVaultBalanceReadContext } from "./vault-balance-read-context";

const mocks = vi.hoisted(() => ({ movement: vi.fn(), statuses: vi.fn(), prove: vi.fn() }));
vi.mock("@/db", () => ({ getDb: vi.fn() }));
vi.mock("@/db/repositories/earn-movements.repository", () => ({
  createPostgresEarnMovementsRepository: () => ({ getMovementById: mocks.movement }),
}));
vi.mock("@sdp/rpc/solana", () => ({ createRpc: vi.fn(), getSignatureStatuses: mocks.statuses }));
vi.mock("./execution-registry", () => ({
  assertClusterEndpoint: mocks.prove,
  earnClusterFor: () => "devnet",
  resolveClusterRpcUrl: () => "https://rpc.invalid",
}));
const input = {
  movementIds: ["one", "two", "three"],
  organizationId: "org",
  projectId: "project",
  environment: "sandbox" as const,
  custodyWalletIds: ["wallet"],
};
const movement = {
  execution_model: "vault_direct",
  environment: "sandbox",
  project_id: "project",
  custody_wallet_id: "wallet",
  signature: "signature",
};
const status = (slot: bigint) => ({ slot, confirmationStatus: "confirmed", err: null });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.movement.mockResolvedValue(movement);
  mocks.statuses.mockResolvedValue([status(100n), status(103n), status(102n)]);
  mocks.prove.mockResolvedValue(undefined);
});

describe("vault balance confirmation context", () => {
  it("uses the highest confirmed slot across repeated or offsetting movements", async () => {
    await expect(resolveVaultBalanceReadContext({} as Env, input)).resolves.toEqual({
      afterMovementIds: input.movementIds,
      minimumSlot: 103,
    });
    expect(mocks.movement).toHaveBeenCalledWith({ movementId: "one", organizationId: "org" });
    expect(mocks.prove).toHaveBeenCalledWith({}, "devnet", "https://rpc.invalid");
  });

  it.each([
    null,
    { ...movement, project_id: "foreign" },
    { ...movement, environment: "production" },
    { ...movement, custody_wallet_id: "unbound" },
    { ...movement, execution_model: "custodial" },
  ])("refuses a foreign or unreadable movement before any RPC call", async (row) => {
    mocks.movement.mockResolvedValueOnce(row);
    await expect(resolveVaultBalanceReadContext({} as Env, input)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(mocks.prove).not.toHaveBeenCalled();
    expect(mocks.statuses).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { ...status(101n), err: { InstructionError: [0, "Custom"] } },
    { ...status(101n), confirmationStatus: "processed" },
    { ...status(101n), slot: undefined },
  ])("does not acknowledge missing or nonconfirmed chain evidence", async (unknown) => {
    mocks.statuses.mockResolvedValue([status(100n), unknown, status(102n)]);
    await expect(resolveVaultBalanceReadContext({} as Env, input)).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it("preserves ordinary position reads without a confirmation constraint", async () => {
    await expect(
      resolveVaultBalanceReadContext({} as Env, { ...input, movementIds: [] })
    ).resolves.toBeUndefined();
    expect(mocks.movement).not.toHaveBeenCalled();
    expect(mocks.statuses).not.toHaveBeenCalled();
  });
});
