import { runInClusterScope } from "@sdp/rpc/scope";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dbClient from "@/db/client";
import type {
  EarnProviderActionClaim,
  EarnProviderActionRow,
} from "@/db/repositories/earn-provider-actions.repository";
import * as repoModule from "@/db/repositories/earn-provider-actions.repository";
import * as moneyAdmission from "@/lib/money-admission";
import * as executionRegistry from "@/services/earn/execution-registry";
import * as solanaSigner from "@/services/solana/signer";
import type { Env } from "@/types/env";
import * as providerActions from "./provider-actions.service";
import * as vaultSponsorship from "./vault-sponsorship";

const claim = vi.fn(),
  advance = vi.fn(),
  release = vi.fn(),
  build = vi.fn(),
  resolve = vi.fn(),
  admit = vi.fn(),
  signer = vi.fn();

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
const repo = {
  get: vi.fn(),
  claim,
  advance,
  releasePreparation: release,
  observeUnknownSignature: vi.fn(),
  findActiveCancellation: vi.fn(),
  claimDue: vi.fn(),
};
vi.spyOn(dbClient, "getDb").mockReturnValue(dbClient.asTransactionalClient(unusedExecutor));
vi.spyOn(repoModule, "createEarnProviderActionsRepository").mockReturnValue(repo);
vi.spyOn(executionRegistry, "resolveEarnExecutionClient").mockImplementation(resolve);
vi.spyOn(moneyAdmission, "assertMoneyStartAdmitted").mockImplementation(admit);
vi.spyOn(solanaSigner, "createOrgSignerForCustodyWallet").mockImplementation(signer);
vi.spyOn(vaultSponsorship, "resolveVaultSponsorship").mockResolvedValue({ kind: "wallet-pays" });

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
  claim.mockResolvedValue({ row, owned: true });
  resolve.mockReturnValue({ buildVaultPreparation: build });
  build.mockResolvedValue({
    instructions: [],
    lookupTables: [],
    assetIdentity: { depositTokenMint: "token", shareMint: "share" },
    cluster: "mainnet-beta",
  });
  advance.mockResolvedValue({ ...row, status: "not_required" });
});
describe("provider action claim before spend", () => {
  it("replays recorded actions without a provider, signer or current money-in admission", async () => {
    const recorded = { ...row, status: "finalized" as const };
    claim.mockResolvedValue({ row: recorded, owned: false });
    resolve.mockImplementation(() => {
      throw new Error("provider down");
    });
    expect(await providerActions.createProviderAction(env, input)).toBe(recorded);
    expect(admit).not.toHaveBeenCalled();
    expect(signer).not.toHaveBeenCalled();
  });
  it("does not build or sign when another request owns preparation", async () => {
    claim.mockResolvedValue({ row, owned: false });
    await expect(providerActions.createProviderAction(env, input)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(signer).not.toHaveBeenCalled();
  });
  it("skips signatures and fees when the live share account already exists", async () => {
    expect(
      (
        await runInClusterScope({ environment: "production", projectId: "project" }, () =>
          providerActions.createProviderAction(env, input)
        )
      ).status
    ).toBe("not_required");
    expect(advance).toHaveBeenCalledWith(
      expect.objectContaining({ preparationLeaseUntil: "lease" }),
      "preparing",
      "not_required"
    );
    expect(signer).not.toHaveBeenCalled();
  });
  it("releases only its preparation lease after an admission refusal", async () => {
    const refusal = new Error("closed");
    await expect(
      providerActions.createProviderAction(env, input, async () => {
        throw refusal;
      })
    ).rejects.toBe(refusal);
    expect(build).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ preparationLeaseUntil: "lease" })
    );
  });
});
