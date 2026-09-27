/**
 * Issuance mint policy gate — fee-payer-funded ATA rent (SOLA9-464).
 *
 * The pinned `@solana/mosaic-sdk` mint builder prepends a
 * create-associated-token-idempotent instruction whose payer is the resolved
 * fee payer, so a mint to a destination without an ATA carries a real
 * rent-exempt SOL outflow. The wallet-operation candidate must represent that
 * outflow as a native SOL leg so amount, approval and velocity rules can
 * constrain fresh-destination mints.
 */

import { MosaicService } from "@sdp/issuance/mosaic/service";
import { hashString } from "@sdp/payments/hash";
import * as SolanaRpc from "@sdp/rpc/solana";
import type { Address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { AppError } from "@/lib/errors";
import * as AuthorityResolution from "@/routes/issuance/handlers/authority-resolution";
import * as SolanaServices from "@/services/solana";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import {
  TEST_ACTIVE_TOKEN,
  TEST_PRODUCTION_PROJECT,
  TEST_PROJECT,
  TEST_PROJECT_API_KEY,
  TEST_PROJECT_CACHED_KEY,
  TEST_SOLANA_ADDRESSES,
} from "@/test/fixtures/tokens";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { seedCachedApiKey } from "@/test/mocks/kv";

const MINT_AUTHORITY = "9wVmMF2GpxZMsJLxCv2xXWjDWVv8HtqTmKqnZxNKkYTz";
const FRESH_DESTINATION = "Fsa9GHq3YcJnnZGuqCoKFYbBpS3fjEyDzxcVSGvNZxh6";
const RENT_LAMPORTS = 2_039_280n;

function custodyWalletIdFor(walletId: string): string {
  return `cwlt_mint_policy_${walletId}`;
}

async function seedMintPolicyWallet(walletId: string): Promise<{
  custodyWalletId: string;
  walletId: string;
}> {
  const custodyWalletId = custodyWalletIdFor(walletId);
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status)
         VALUES (?, ?, ?, 'local', 'test-config', 'sdp-custody-encryption-v1', ?, 'active')
         ON CONFLICT DO NOTHING`
      )
      .bind(`cust_cfg_${custodyWalletId}`, TEST_ORG.id, TEST_PROJECT.id, walletId),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, ?, 'transfer', 'active')
         ON CONFLICT DO NOTHING`
      )
      .bind(custodyWalletId, `cust_cfg_${custodyWalletId}`, walletId, MINT_AUTHORITY, walletId),
  ]);
  return { custodyWalletId, walletId };
}

async function seedMintPolicyToken(input: {
  id: string;
  signingWalletId: string;
}): Promise<typeof TEST_ACTIVE_TOKEN> {
  const token = {
    ...TEST_ACTIVE_TOKEN,
    id: input.id,
    mintAuthority: MINT_AUTHORITY,
    freezeAuthority: MINT_AUTHORITY,
    signingWalletId: input.signingWalletId,
  };

  await getDb(env)
    .prepare(
      `INSERT INTO issued_tokens (
        id, project_id, organization_id, signing_custody_wallet_id, signing_wallet_id,
        mint_address, mint_authority,
        metadata_authority, freeze_authority, abl_list_address, name, symbol, decimals,
        description, uri, image_url, template, total_supply_cached, total_supply_updated_at,
        max_supply, is_mintable, freeze_authority_enabled, allowlist_enabled, status,
        deployed_at, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, '0', ?, NULL, 1, 1, 0, 'active', ?, ?, ?, ?)`
    )
    .bind(
      token.id,
      token.projectId,
      token.organizationId,
      token.signingWalletId,
      token.mintAddress,
      token.mintAuthority,
      token.freezeAuthority,
      token.name,
      token.symbol,
      token.decimals,
      token.description,
      token.uri,
      token.imageUrl,
      token.template,
      token.updatedAt,
      token.deployedAt,
      token.createdBy,
      token.createdAt,
      token.updatedAt
    )
    .run();

  return token;
}

async function putWalletPolicy(walletId: string, rules: unknown[]): Promise<void> {
  const response = await app.request(
    `/v1/payments/wallets/${walletId}/policies`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
      },
      body: JSON.stringify({ defaultAction: "allow", rules }),
    },
    env
  );
  expect(response.status).toBe(200);
}

async function postMint(tokenId: string, destination: string, options: { dryRun?: boolean } = {}) {
  return app.request(
    `/v1/issuance/tokens/${tokenId}/mint`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
        ...(options.dryRun ? { "Dry-Run": "true" } : {}),
      },
      body: JSON.stringify({ mint: { destination, amount: "1" } }),
    },
    env
  );
}

interface DryRunBody {
  data: {
    decision: string;
    reason: string;
    criteria: {
      ruleId: string | null;
      kind: string;
      matched: boolean;
      action: string | null;
      leg: number | null;
    }[];
  };
}

describe("issuance mint policy gate — ATA rent leg", () => {
  let apiKeyHash: string;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
    apiKeyHash = await hashString(
      TEST_PROJECT_API_KEY.raw,
      (env as { API_KEY_PEPPER: string }).API_KEY_PEPPER
    );
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db
      .prepare("DELETE FROM policy_evaluations")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM approval_requests")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM wallet_operations")
      .run()
      .catch(() => {});
    await db.prepare("DELETE FROM issued_tokens WHERE id LIKE 'tok_mint_policy%'").run();
    await db
      .prepare("DELETE FROM custody_wallets WHERE id LIKE 'cwlt_mint_policy_%'")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM custody_configs WHERE id LIKE 'cust_cfg_cwlt_mint_policy_%'")
      .run()
      .catch(() => {});
    await db
      .prepare(
        `INSERT OR REPLACE INTO organizations (id, name, slug, tier, status, settings)
         VALUES (?, ?, ?, 'individual', 'active', '{"providerOverrides":{"custody":{"local":true}}}')`
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: TEST_PROJECT.id, production: TEST_PRODUCTION_PROJECT.id },
    });
    await seedProjectApiKey(db, env, {
      key: TEST_PROJECT_API_KEY,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      createdBy: TEST_USER.id,
      role: "api_admin",
      permissions: ["*"],
    });
    await seedCachedApiKey(env, apiKeyHash, TEST_PROJECT_CACHED_KEY);

    vi.spyOn(AuthorityResolution, "resolveCurrentAuthorityForRole").mockImplementation(
      async (_runtimeEnv, _tokenService, token, role, override) => {
        const currentAuthority = role === "freeze" ? token?.freezeAuthority : token?.mintAuthority;
        if (override !== undefined && override !== currentAuthority) {
          throw new AppError(
            "BAD_REQUEST",
            "Provided current authority does not match the on-chain authority"
          );
        }
        return currentAuthority ?? null;
      }
    );
    vi.spyOn(SolanaRpc, "getMinimumBalanceForRentExemption").mockResolvedValue(RENT_LAMPORTS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("denies a fresh-destination mint whose ATA rent the resolved fee payer funds", async () => {
    const wallet = await seedMintPolicyWallet("deny");
    const token = await seedMintPolicyToken({
      id: "tok_mint_policy_deny",
      signingWalletId: wallet.walletId,
    });
    await putWalletPolicy(wallet.walletId, [
      { id: "deny-sol-outflow", kind: "amount", asset: "SOL", max: "0", action: "deny" },
      {
        id: "allow-small-token-mint",
        kind: "amount",
        asset: token.symbol,
        max: "1",
        action: "allow",
      },
    ]);
    const accountExistsSpy = vi.spyOn(SolanaRpc, "accountExists").mockResolvedValue(false);

    const response = await postMint(token.id, FRESH_DESTINATION, { dryRun: true });
    const body = (await response.json()) as DryRunBody;

    expect(response.status).toBe(200);

    // SECURITY: the SOL rent leg lets the deny-sol-outflow amount rule bind
    // the mint. On the vulnerable baseline this decision was "allow".
    expect(body.data.decision).toBe("deny");
    // The preflight must check the exact ATA the mint builder would create.
    const [ata] = await findAssociatedTokenPda({
      owner: FRESH_DESTINATION as Address,
      mint: token.mintAddress as Address,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    expect(accountExistsSpy).toHaveBeenCalledTimes(1);
    expect(accountExistsSpy.mock.calls[0]?.[1]).toBe(ata);
    const legCriteria = body.data.criteria.filter(
      (criterion) => criterion.leg !== null && criterion.matched
    );
    expect(legCriteria).toHaveLength(1);
    expect(legCriteria[0]).toMatchObject({
      ruleId: "deny-sol-outflow",
      kind: "amount",
      matched: true,
      action: "deny",
      leg: 0,
    });
  });

  it("still denies the fresh-destination rent when the custody wallet pays it", async () => {
    const previousKoraRpcUrl = env.KORA_RPC_URL;
    (env as { KORA_RPC_URL?: string }).KORA_RPC_URL = undefined;
    try {
      const wallet = await seedMintPolicyWallet("custody");
      const token = await seedMintPolicyToken({
        id: "tok_mint_policy_custody",
        signingWalletId: wallet.walletId,
      });
      await putWalletPolicy(wallet.walletId, [
        { id: "deny-sol-outflow", kind: "amount", asset: "SOL", max: "0", action: "deny" },
        {
          id: "allow-small-token-mint",
          kind: "amount",
          asset: token.symbol,
          max: "1",
          action: "allow",
        },
      ]);
      vi.spyOn(SolanaRpc, "accountExists").mockResolvedValue(false);

      const response = await postMint(token.id, FRESH_DESTINATION, { dryRun: true });
      const body = (await response.json()) as DryRunBody;

      expect(response.status).toBe(200);
      expect(body.data.decision).toBe("deny");
    } finally {
      (env as { KORA_RPC_URL?: string }).KORA_RPC_URL = previousKoraRpcUrl;
    }
  });

  it("keeps minting to an existing destination ATA allowed under the same policy", async () => {
    const wallet = await seedMintPolicyWallet("existing");
    const token = await seedMintPolicyToken({
      id: "tok_mint_policy_existing",
      signingWalletId: wallet.walletId,
    });
    await putWalletPolicy(wallet.walletId, [
      { id: "deny-sol-outflow", kind: "amount", asset: "SOL", max: "0", action: "deny" },
      {
        id: "allow-small-token-mint",
        kind: "amount",
        asset: token.symbol,
        max: "1",
        action: "allow",
      },
    ]);
    vi.spyOn(SolanaRpc, "accountExists").mockResolvedValue(true);

    const response = await postMint(token.id, TEST_SOLANA_ADDRESSES.wallet2, { dryRun: true });
    const body = (await response.json()) as DryRunBody;

    expect(response.status).toBe(200);
    // No ATA would be created, so no SOL leg and no rent bound applies.
    expect(body.data.decision).toBe("allow");
    expect(body.data.criteria.filter((criterion) => criterion.leg !== null)).toHaveLength(0);
  });

  it("records the fee-payer ATA rent on the governed wallet operation", async () => {
    const previousKoraRpcUrl = env.KORA_RPC_URL;
    (env as { KORA_RPC_URL?: string }).KORA_RPC_URL = undefined;
    try {
      const wallet = await seedMintPolicyWallet("record");
      const token = await seedMintPolicyToken({
        id: "tok_mint_policy_record",
        signingWalletId: wallet.walletId,
      });
      // An approval rule on the SOL rent sends the mint to approval instead of
      // execution, so the wallet_operations row is observable without mocking
      // the on-chain mint submission.
      await putWalletPolicy(wallet.walletId, [
        {
          id: "approve-ata-rent",
          kind: "amount",
          asset: "SOL",
          max: "0.00203928",
          action: "approval_required",
        },
      ]);
      vi.spyOn(SolanaRpc, "accountExists").mockResolvedValue(false);

      const response = await postMint(token.id, FRESH_DESTINATION);
      expect(response.status).toBe(202);
      const body = (await response.json()) as {
        error: { details: { walletOperationId: string } };
      };

      const operation = await getDb(env)
        .prepare("SELECT raw_payload, asset, amount FROM wallet_operations WHERE id = ?")
        .bind(body.error.details.walletOperationId)
        .first<{
          raw_payload: Record<string, unknown>;
          asset: string | null;
          amount: string | null;
        }>();
      expect(operation?.asset).toBe(token.symbol);
      const [ata] = await findAssociatedTokenPda({
        owner: FRESH_DESTINATION as Address,
        mint: token.mintAddress as Address,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      });
      expect(operation?.raw_payload.ataRent).toEqual({
        tokenAccount: ata,
        rentLamports: RENT_LAMPORTS.toString(),
        solAmount: "0.00203928",
        payer: "custody_wallet",
      });
    } finally {
      (env as { KORA_RPC_URL?: string }).KORA_RPC_URL = previousKoraRpcUrl;
    }
  });

  it("still binds token-asset amount rules to the aggregate mint operation", async () => {
    const wallet = await seedMintPolicyWallet("token");
    const token = await seedMintPolicyToken({
      id: "tok_mint_policy_token",
      signingWalletId: wallet.walletId,
    });
    await putWalletPolicy(wallet.walletId, [
      {
        id: "deny-token-outflow",
        kind: "amount",
        asset: token.symbol,
        max: "0",
        action: "deny",
      },
    ]);
    vi.spyOn(SolanaRpc, "accountExists").mockResolvedValue(false);

    const response = await postMint(token.id, FRESH_DESTINATION, { dryRun: true });
    const body = (await response.json()) as DryRunBody;

    expect(response.status).toBe(200);
    expect(body.data.decision).toBe("deny");
    const aggregateDeny = body.data.criteria.find(
      (criterion) => criterion.leg === null && criterion.action === "deny"
    );
    expect(aggregateDeny).toMatchObject({ ruleId: "deny-token-outflow", kind: "amount" });
  });

  it("caps combined fresh-destination rent across successive mints with a SOL velocity rule", async () => {
    const wallet = await seedMintPolicyWallet("velocity");
    const token = await seedMintPolicyToken({
      id: "tok_mint_policy_velocity",
      signingWalletId: wallet.walletId,
    });
    await putWalletPolicy(wallet.walletId, [
      {
        id: "approve-ata-rent",
        kind: "amount",
        asset: "SOL",
        max: "0.00203928",
        action: "approval_required",
      },
      {
        id: "cap-combined-rent",
        kind: "velocity",
        asset: "SOL",
        window: "P1D",
        max: "0.00203928",
        action: "deny",
      },
    ]);
    vi.spyOn(SolanaRpc, "accountExists").mockResolvedValue(false);

    // The approval rule parks the first mint at the gate, so its wallet
    // operation — and the ATA rent it records — persists without execution.
    const first = await postMint(token.id, FRESH_DESTINATION);
    expect(first.status).toBe(202);

    // SECURITY: the second mint's SOL velocity window must observe the first
    // mint's persisted rent, so the combined outflow breaches the cap. On the
    // vulnerable baseline only token-asset rows were summed and this mint was
    // approved too.
    const second = await postMint(token.id, FRESH_DESTINATION);
    const body = (await second.json()) as {
      error: { code: string; details: { decision: string } };
    };

    expect(second.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.details.decision).toBe("deny");
  });

  it("fails closed when the destination ATA is closed between policy evaluation and submission", async () => {
    const wallet = await seedMintPolicyWallet("toctou");
    const token = await seedMintPolicyToken({
      id: "tok_mint_policy_toctou",
      signingWalletId: wallet.walletId,
    });
    await putWalletPolicy(wallet.walletId, [
      {
        id: "allow-small-token-mint",
        kind: "amount",
        asset: token.symbol,
        max: "1",
        action: "allow",
      },
    ]);
    // The gate's preflight sees an existing ATA (no rent leg to evaluate); by
    // the submission boundary the ATA is gone, so the mint's create-ATA would
    // charge rent the evaluated decision never saw.
    vi.spyOn(SolanaRpc, "accountExists").mockResolvedValueOnce(true).mockResolvedValue(false);
    vi.spyOn(SolanaServices, "createOrgSignerForCustodyWallet").mockResolvedValue({
      address: MINT_AUTHORITY,
    } as never);
    const mintToSpy = vi
      .spyOn(MosaicService.prototype, "mintTo")
      .mockResolvedValue({ signature: "sig_toctou", slot: 1n, tokenAccount: "ata" } as never);

    const response = await postMint(token.id, TEST_SOLANA_ADDRESSES.wallet2);
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toContain("changed after policy evaluation");
    expect(mintToSpy).not.toHaveBeenCalled();
  });
});
