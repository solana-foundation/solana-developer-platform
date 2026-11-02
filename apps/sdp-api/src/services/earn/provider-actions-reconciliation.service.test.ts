import * as rpcFactory from "@sdp/rpc/factory";
import { runInClusterScope } from "@sdp/rpc/scope";
import * as solana from "@sdp/rpc/solana";
import { createSolanaRpcFromTransport } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dbClient from "@/db/client";
import type { EarnProviderActionRow } from "@/db/repositories/earn-provider-actions.repository";
import * as repoModule from "@/db/repositories/earn-provider-actions.repository";
import * as executionRegistry from "@/services/earn/execution-registry";
import type { Env } from "@/types/env";
import * as reconciliation from "./provider-actions-reconciliation.service";

const claim = vi.fn(),
  advance = vi.fn(),
  observe = vi.fn(),
  statuses = vi.fn(),
  height = vi.fn(),
  reRead = vi.fn(),
  history = vi.fn(),
  send = vi.fn();

/** A client whose every statement throws: the dependencies under test are spied. */
const unusedExecutor: dbClient.DatabaseExecutor = {
  prepare: (query) => {
    throw new Error(`This test runs no SQL: ${query}`);
  },
  queryOne: async () => {
    throw new Error("This test runs no SQL");
  },
  queryMany: async () => {
    throw new Error("This test runs no SQL");
  },
  execute: async () => {
    throw new Error("This test runs no SQL");
  },
};
const unusedRpc = createSolanaRpcFromTransport(async () => {
  throw new Error("This test spies every chain read");
});
const repo = {
  get: vi.fn(),
  claim: vi.fn(),
  advance,
  releasePreparation: vi.fn(),
  observeUnknownSignature: observe,
  findActiveCancellation: vi.fn(),
  claimDue: claim,
};
function installSpies(): void {
  vi.spyOn(dbClient, "getDb").mockReturnValue(dbClient.asTransactionalClient(unusedExecutor));
  vi.spyOn(repoModule, "createEarnProviderActionsRepository").mockReturnValue(repo);
  vi.spyOn(executionRegistry, "resolveEarnExecutionClient").mockReturnValue(null);
  vi.spyOn(rpcFactory, "createClusterRpc").mockReturnValue(unusedRpc);
  vi.spyOn(solana, "getSignatureStatuses").mockImplementation(statuses);
  vi.spyOn(solana, "getChainHeight").mockImplementation(height);
  vi.spyOn(solana, "reReadExpiredStatuses").mockImplementation(reRead);
  vi.spyOn(solana, "getTransaction").mockImplementation(history);
  vi.spyOn(solana, "sendTransaction").mockImplementation(send);
}
const row: EarnProviderActionRow = {
  id: "action",
  organization_id: "org",
  project_id: "project",
  environment: "production",
  provider: "plume",
  action: "preparation",
  parent_movement_id: null,
  custody_wallet_id: "wallet",
  owner_address: "owner",
  vault_address: "vault",
  token_mint: "usdc",
  share_mint: "share",
  fee_payer: null,
  request_id: "key",
  fingerprint: "fingerprint",
  status: "submitted",
  unsigned_transaction: null,
  signed_transaction: "AQ==",
  signature:
    "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy",
  last_valid_block_height: "100",
  delivery_signature: null,
  error: null,
  unknown_signature_observed_at: null,
  lease_until: "lease",
  next_check_at: "next",
  created_by: null,
  initiated_by_key_id: null,
  created_at: "created",
  updated_at: "updated",
};
const run = () =>
  runInClusterScope({ environment: "production", projectId: null }, () =>
    reconciliation.reconcileEarnProviderActions({} as Env)
  );
function claimOne(overrides: Partial<EarnProviderActionRow> = {}) {
  claim.mockResolvedValueOnce({ ...row, ...overrides }).mockResolvedValueOnce(null);
}
beforeEach(() => {
  vi.resetAllMocks();
  installSpies();
  statuses.mockResolvedValue([null]);
  height.mockResolvedValue({ blockHeight: 200n, absoluteSlot: 200n });
  reRead.mockResolvedValue([null]);
  history.mockResolvedValue(null);
});
describe("provider action source recovery", () => {
  it("finalizes account setup only at finalized source success", async () => {
    claimOne();
    statuses.mockResolvedValue([{ confirmationStatus: "finalized", err: null }]);
    await run();
    expect(advance).toHaveBeenCalledWith(expect.anything(), "submitted", "finalized");
  });
  it("leaves cancellation awaiting its economic share return", async () => {
    claimOne({ action: "cancellation", parent_movement_id: "parent" });
    statuses.mockResolvedValue([{ confirmationStatus: "finalized", err: null }]);
    await run();
    expect(advance).toHaveBeenCalledWith(expect.anything(), "submitted", "awaiting_delivery");
  });
  it("never expires an already confirmed action on missing history", async () => {
    claimOne({ status: "confirmed" });
    await run();
    expect(advance).not.toHaveBeenCalled();
    expect(height).not.toHaveBeenCalled();
  });
  it("requires a second expired unknown-history observation before failure", async () => {
    claimOne();
    await run();
    expect(observe).toHaveBeenCalledOnce();
    expect(advance).not.toHaveBeenCalled();
    claimOne({ unknown_signature_observed_at: "2000-01-01T00:00:00.000Z" });
    await run();
    expect(advance).toHaveBeenCalledWith(
      expect.anything(),
      "submitted",
      "failed",
      expect.objectContaining({ error: expect.any(String) })
    );
  });
  it("re-reads an expired signature at the finalized height before judging absence", async () => {
    claimOne();
    reRead.mockResolvedValue([
      { slot: 200n, confirmations: null, confirmationStatus: "finalized", err: null },
    ]);
    await run();
    expect(reRead).toHaveBeenCalledWith(
      expect.anything(),
      [null],
      [{ index: 0, signature: row.signature }],
      200n
    );
    // The lagging node's null status did not vote the landed transaction dead.
    expect(advance).toHaveBeenCalledWith(expect.anything(), "submitted", "finalized");
    expect(observe).not.toHaveBeenCalled();
  });
  it("recovers a landed cancellation from finalized transaction history", async () => {
    claimOne({ action: "cancellation", parent_movement_id: "parent" });
    history.mockResolvedValue({
      slot: 200n,
      executionResultKnown: true,
      err: null,
    });
    await run();
    expect(history).toHaveBeenCalledWith(expect.anything(), row.signature, "finalized");
    expect(advance).toHaveBeenCalledWith(expect.anything(), "submitted", "awaiting_delivery");
    expect(observe).not.toHaveBeenCalled();
  });
  it("leaves the action open when the height-slot re-read cannot be served", async () => {
    claimOne();
    reRead.mockRejectedValue(new Error("minContextSlot not reached"));
    await expect(run()).rejects.toThrow();
    expect(advance).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });
  it("rebroadcasts only the recorded bytes while the blockhash is valid", async () => {
    claimOne({ last_valid_block_height: "300" });
    await run();
    expect(send).toHaveBeenCalledWith(expect.anything(), Uint8Array.of(1));
  });
});
