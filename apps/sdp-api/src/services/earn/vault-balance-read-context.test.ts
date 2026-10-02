import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import {
  FINALIZED_SIGNATURE_STATUS_TTL_MS,
  resetFinalizedSignatureStatuses,
  resolveVaultBalanceReadContext,
} from "./vault-balance-read-context";

const mocks = vi.hoisted(() => ({ movement: vi.fn(), statuses: vi.fn(), prove: vi.fn() }));
vi.mock("@/db", () => ({ getDb: vi.fn() }));
vi.mock("@/db/repositories/earn-movements.repository", () => ({
  createPostgresEarnMovementsRepository: () => ({ getMovementById: mocks.movement }),
}));
vi.mock("@sdp/rpc/solana", () => ({ createRpc: vi.fn(), getSignatureStatuses: mocks.statuses }));
vi.mock("./execution-registry", () => ({
  assertClusterEndpoint: mocks.prove,
  earnClusterFor: (environment: string) =>
    environment === "production" ? "mainnet-beta" : "devnet",
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
  position_id: "position",
  signature: "signature",
};
const status = (slot: bigint) => ({ slot, confirmationStatus: "confirmed", err: null });

beforeEach(() => {
  vi.clearAllMocks();
  resetFinalizedSignatureStatuses();
  mocks.movement.mockResolvedValue(movement);
  mocks.statuses.mockResolvedValue([status(100n), status(103n), status(102n)]);
  mocks.prove.mockResolvedValue(undefined);
});

describe("vault balance confirmation context", () => {
  it("uses the highest confirmed slot across repeated or offsetting movements", async () => {
    await expect(resolveVaultBalanceReadContext({} as Env, input)).resolves.toEqual({
      afterMovementIds: input.movementIds,
      minimumSlot: 103,
      minimumSlotByPositionId: new Map([["position", 103]]),
    });
    expect(mocks.movement).toHaveBeenCalledWith({ movementId: "one", organizationId: "org" });
    expect(mocks.prove).toHaveBeenCalledWith({}, "devnet", "https://rpc.invalid");
  });

  it("keeps each position's bound separate while retaining the overall wallet bound", async () => {
    mocks.movement.mockResolvedValueOnce({ ...movement, position_id: "other" });
    await expect(resolveVaultBalanceReadContext({} as Env, input)).resolves.toEqual({
      afterMovementIds: input.movementIds,
      minimumSlot: 103,
      minimumSlotByPositionId: new Map([
        ["other", 100],
        ["position", 103],
      ]),
    });
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

describe("finalized signature statuses are read once", () => {
  /** What the chain reports per signature; each movement id signs its own transaction. */
  const chain = new Map<string, unknown>();
  const finalized = (slot: bigint) => ({
    slot,
    confirmations: null,
    confirmationStatus: "finalized",
    err: null,
  });
  const expected = {
    afterMovementIds: ["one", "two", "three"],
    minimumSlot: 103,
    minimumSlotByPositionId: new Map([
      ["position-one", 100],
      ["position-two", 103],
      ["position-three", 102],
    ]),
  };

  beforeEach(() => {
    chain.clear();
    mocks.movement.mockImplementation(async ({ movementId }: { movementId: string }) => ({
      ...movement,
      signature: `sig-${movementId}`,
      position_id: `position-${movementId}`,
    }));
    mocks.statuses.mockImplementation(async (_rpc: unknown, signatures: string[]) =>
      signatures.map((signature) => chain.get(signature) ?? null)
    );
  });

  it("skips getSignatureStatuses on later polls once every movement is finalized", async () => {
    chain.set("sig-one", finalized(100n));
    chain.set("sig-two", finalized(103n));
    chain.set("sig-three", finalized(102n));

    for (let poll = 0; poll < 3; poll += 1) {
      await expect(resolveVaultBalanceReadContext({} as Env, input)).resolves.toEqual(expected);
    }

    expect(mocks.statuses).toHaveBeenCalledTimes(1);
    expect(mocks.statuses.mock.calls[0]?.[1]).toEqual(["sig-one", "sig-two", "sig-three"]);
    expect(mocks.prove).toHaveBeenCalledTimes(3);
  });

  it("keeps reading a confirmed-only movement, and only that one", async () => {
    chain.set("sig-one", finalized(100n));
    chain.set("sig-two", status(103n));
    chain.set("sig-three", finalized(102n));

    await expect(resolveVaultBalanceReadContext({} as Env, input)).resolves.toEqual(expected);
    await expect(resolveVaultBalanceReadContext({} as Env, input)).resolves.toEqual(expected);
    chain.set("sig-two", finalized(103n));
    await expect(resolveVaultBalanceReadContext({} as Env, input)).resolves.toEqual(expected);
    await expect(resolveVaultBalanceReadContext({} as Env, input)).resolves.toEqual(expected);

    expect(mocks.statuses.mock.calls.map(([, signatures]) => signatures)).toEqual([
      ["sig-one", "sig-two", "sig-three"],
      ["sig-two"],
      ["sig-two"],
    ]);
  });

  it("never remembers a failed read or a status the checks refuse", async () => {
    const single = { ...input, movementIds: ["one"] };
    mocks.statuses.mockRejectedValueOnce(new Error("RPC request timed out after 3000ms"));
    await expect(resolveVaultBalanceReadContext({} as Env, single)).rejects.toThrow("timed out");

    chain.set("sig-one", { ...finalized(100n), err: { InstructionError: [0, "Custom"] } });
    for (let poll = 0; poll < 2; poll += 1) {
      await expect(resolveVaultBalanceReadContext({} as Env, single)).rejects.toMatchObject({
        statusCode: 503,
      });
    }

    expect(mocks.statuses).toHaveBeenCalledTimes(3);
  });

  it("reads a finalized status again after its window, and on another cluster", async () => {
    const single = { ...input, movementIds: ["one"] };
    chain.set("sig-one", finalized(100n));
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await resolveVaultBalanceReadContext({} as Env, single);
      await resolveVaultBalanceReadContext({} as Env, single);
      expect(mocks.statuses).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(now + FINALIZED_SIGNATURE_STATUS_TTL_MS + 1);
      await resolveVaultBalanceReadContext({} as Env, single);
      expect(mocks.statuses).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }

    mocks.movement.mockResolvedValueOnce({
      ...movement,
      environment: "production",
      signature: "sig-one",
    });
    await resolveVaultBalanceReadContext({} as Env, { ...single, environment: "production" });
    expect(mocks.statuses).toHaveBeenCalledTimes(3);
  });

  it("holds a bounded number of statuses, dropping the oldest", async () => {
    const movementIds = Array.from({ length: 1_025 }, (_, index) => `m${index}`);
    for (const id of movementIds) chain.set(`sig-${id}`, finalized(100n));
    await resolveVaultBalanceReadContext({} as Env, { ...input, movementIds });

    await resolveVaultBalanceReadContext({} as Env, { ...input, movementIds: ["m1024"] });
    expect(mocks.statuses).toHaveBeenCalledTimes(1);
    await resolveVaultBalanceReadContext({} as Env, { ...input, movementIds: ["m0"] });
    expect(mocks.statuses).toHaveBeenCalledTimes(2);
    expect(mocks.statuses.mock.calls[1]?.[1]).toEqual(["sig-m0"]);
  });
});
