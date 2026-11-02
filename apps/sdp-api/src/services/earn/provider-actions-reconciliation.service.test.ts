import { runInClusterScope } from "@sdp/rpc/scope";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EarnProviderActionRow } from "@/db/repositories/earn-provider-actions.repository";
import type { Env } from "@/types/env";
import { reconcileEarnProviderActions } from "./provider-actions-reconciliation.service";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  advance: vi.fn(),
  observe: vi.fn(),
  statuses: vi.fn(),
  height: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@/services/earn/execution-registry", () => ({ resolveEarnExecutionClient: () => null }));
vi.mock("@/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/db/repositories/earn-provider-actions.repository", () => ({
  createEarnProviderActionsRepository: () => ({
    claimDue: mocks.claim,
    advance: mocks.advance,
    observeUnknownSignature: mocks.observe,
  }),
}));
vi.mock("@/db/repositories/earn-movements.repository", () => ({
  createPostgresEarnMovementsRepository: () => ({}),
}));
vi.mock("@sdp/rpc/factory", () => ({
  createClusterRpc: () => ({ getBlockHeight: () => ({ send: mocks.height }) }),
}));
vi.mock("@sdp/rpc/solana", async (original) => ({
  ...(await original<typeof import("@sdp/rpc/solana")>()),
  getSignatureStatuses: mocks.statuses,
  sendTransaction: mocks.send,
}));
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
    reconcileEarnProviderActions({} as Env)
  );
function claim(overrides: Partial<EarnProviderActionRow> = {}) {
  mocks.claim.mockResolvedValueOnce({ ...row, ...overrides }).mockResolvedValueOnce(null);
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.statuses.mockResolvedValue([null]);
  mocks.height.mockResolvedValue(200n);
});
describe("provider action source recovery", () => {
  it("finalizes account setup only at finalized source success", async () => {
    claim();
    mocks.statuses.mockResolvedValue([{ confirmationStatus: "finalized", err: null }]);
    await run();
    expect(mocks.advance).toHaveBeenCalledWith(expect.anything(), "submitted", "finalized");
  });
  it("leaves cancellation awaiting its economic share return", async () => {
    claim({ action: "cancellation", parent_movement_id: "parent" });
    mocks.statuses.mockResolvedValue([{ confirmationStatus: "finalized", err: null }]);
    await run();
    expect(mocks.advance).toHaveBeenCalledWith(expect.anything(), "submitted", "awaiting_delivery");
  });
  it("never expires an already confirmed action on missing history", async () => {
    claim({ status: "confirmed" });
    await run();
    expect(mocks.advance).not.toHaveBeenCalled();
    expect(mocks.height).not.toHaveBeenCalled();
  });
  it("requires a second expired unknown-history observation before failure", async () => {
    claim();
    await run();
    expect(mocks.observe).toHaveBeenCalledOnce();
    expect(mocks.advance).not.toHaveBeenCalled();
    claim({ unknown_signature_observed_at: "2000-01-01T00:00:00.000Z" });
    await run();
    expect(mocks.advance).toHaveBeenCalledWith(
      expect.anything(),
      "submitted",
      "failed",
      expect.objectContaining({ error: expect.any(String) })
    );
  });
  it("rebroadcasts only the recorded bytes while the blockhash is valid", async () => {
    claim({ last_valid_block_height: "300" });
    await run();
    expect(mocks.send).toHaveBeenCalledWith(expect.anything(), Uint8Array.of(1));
  });
});
