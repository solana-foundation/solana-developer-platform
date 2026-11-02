import { runInClusterScope } from "@sdp/rpc/scope";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EarnProviderActionClaim,
  EarnProviderActionRow,
} from "@/db/repositories/earn-provider-actions.repository";
import type { Env } from "@/types/env";
import { createProviderAction } from "./provider-actions.service";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  advance: vi.fn(),
  release: vi.fn(),
  build: vi.fn(),
  resolve: vi.fn(),
  admit: vi.fn(),
  signer: vi.fn(),
}));
vi.mock("@/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/db/repositories/earn-provider-actions.repository", () => ({
  createEarnProviderActionsRepository: () => ({
    claim: mocks.claim,
    advance: mocks.advance,
    releasePreparation: mocks.release,
  }),
}));
vi.mock("@/services/earn/execution-registry", () => ({
  resolveEarnExecutionClient: mocks.resolve,
}));
vi.mock("@/lib/money-admission", () => ({ assertMoneyStartAdmitted: mocks.admit }));
vi.mock("@/services/solana/signer", () => ({ createOrgSignerForCustodyWallet: mocks.signer }));
vi.mock("./vault-sponsorship", () => ({
  resolveVaultSponsorship: async () => ({ kind: "wallet-pays" }),
}));
const input: EarnProviderActionClaim = {
  organization_id: "org",
  project_id: "project",
  environment: "production",
  provider: "plume",
  action: "preparation",
  parent_movement_id: null,
  custody_wallet_id: "wallet",
  owner_address: "owner",
  vault_address: "vault",
  token_mint: "token",
  share_mint: "share",
  fee_payer: null,
  request_id: "key",
  fingerprint: "fingerprint",
  created_by: null,
  initiated_by_key_id: null,
};
const row: EarnProviderActionRow = {
  ...input,
  id: "action",
  status: "preparing",
  unsigned_transaction: null,
  signed_transaction: null,
  signature: null,
  last_valid_block_height: null,
  delivery_signature: null,
  error: null,
  unknown_signature_observed_at: null,
  lease_until: "lease",
  next_check_at: "next",
  created_at: "created",
  updated_at: "updated",
};
const env = {} as Env;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.claim.mockResolvedValue({ row, owned: true });
  mocks.resolve.mockReturnValue({ buildVaultPreparation: mocks.build });
  mocks.build.mockResolvedValue({
    instructions: [],
    lookupTables: [],
    assetIdentity: { depositTokenMint: "token", shareMint: "share" },
    cluster: "mainnet-beta",
  });
  mocks.advance.mockResolvedValue({ ...row, status: "not_required" });
});
describe("provider action claim before spend", () => {
  it("replays recorded actions without a provider, signer or current money-in admission", async () => {
    const recorded = { ...row, status: "finalized" as const };
    mocks.claim.mockResolvedValue({ row: recorded, owned: false });
    mocks.resolve.mockImplementation(() => {
      throw new Error("provider down");
    });
    expect(await createProviderAction(env, input)).toBe(recorded);
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.signer).not.toHaveBeenCalled();
  });
  it("does not build or sign when another request owns preparation", async () => {
    mocks.claim.mockResolvedValue({ row, owned: false });
    await expect(createProviderAction(env, input)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.signer).not.toHaveBeenCalled();
  });
  it("skips signatures and fees when the live share account already exists", async () => {
    expect(
      (
        await runInClusterScope({ environment: "production", projectId: "project" }, () =>
          createProviderAction(env, input)
        )
      ).status
    ).toBe("not_required");
    expect(mocks.advance).toHaveBeenCalledWith(
      expect.objectContaining({ preparationLeaseUntil: "lease" }),
      "preparing",
      "not_required"
    );
    expect(mocks.signer).not.toHaveBeenCalled();
  });
  it("releases only its preparation lease after an admission refusal", async () => {
    const refusal = new Error("closed");
    await expect(
      createProviderAction(env, input, async () => {
        throw refusal;
      })
    ).rejects.toBe(refusal);
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith(
      expect.objectContaining({ preparationLeaseUntil: "lease" })
    );
  });
});
