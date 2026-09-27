/**
 * A DvP settlement authority must be held by a custody provider that can sign.
 *
 * Anchorage is lifecycle-only (`supportsSigning: false`): its adapter is a
 * `LifecycleOnlyAdapter`, never a `FullSigningPort`. A settlement wallet
 * provisioned under an Anchorage Config passes liveness and entitlement
 * admission, so DvP create used to succeed — and every trade created under it
 * was born uncloseable, because settle and cancel both need the authority's
 * signature and the provider can never produce one (SOLA9-606 / APE-823).
 *
 * The guards under test:
 *
 * 1. Provisioning refuses a lifecycle-only effective custody target BEFORE a
 *    provider wallet is minted or the `dvp_settlement_wallets` mapping is
 *    persisted.
 * 2. Runtime admission refuses a retained settlement wallet whose provider
 *    cannot sign, so a mapping that predates the guard still fails every
 *    create closed instead of minting funded, uncloseable trades.
 *
 * Anchorage's supported non-signing workflows (wallet lifecycle, compliance)
 * keep working: wallet creation, deletion and listing never call
 * `admitRuntimeExecution`.
 */

import { canProviderSign } from "@sdp/custody";
import type { SigningError } from "@sdp/custody/signing";
import { Context } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { createSigningService } from "@/services/domain/signing.service";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";

const provisionApiKeyWallet = vi.hoisted(() => vi.fn());
vi.mock("@/services/api-key-wallet-provisioning.service", () => ({ provisionApiKeyWallet }));

const { getOrCreateDvpSettlementWallet } = await import("./settlement-wallet");

const ORGANIZATION_ID = "org_dvp_signing_capability";
const PROJECT_ID = "prj_dvp_signing_capability";
const USER_ID = "usr_dvp_signing_capability";
const CONFIG_ID = "cust_dvp_signing_capability";
const WALLET_ID = "cwlt_dvp_signing_capability";
const PROVIDER_WALLET_ID = "anchorage_dvp_signing_wallet";
const WALLET_ADDRESS = "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC";

const PRIVY_ORGANIZATION_ID = "org_dvp_signing_compatible";
const PRIVY_PROJECT_ID = "prj_dvp_signing_compatible";
const PRIVY_USER_ID = "usr_dvp_signing_compatible";
const PRIVY_CONFIG_ID = "cust_dvp_signing_compatible";
const PRIVY_WALLET_ID = "cwlt_dvp_signing_compatible";

const auditContext = new Context<{ Bindings: Env }>(new Request("http://localhost/dvp"), { env });
const scope = { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID };

/** An entitled organization whose effective custody default is lifecycle-only Anchorage. */
async function seedAnchorageDefault(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status, settings)
         VALUES (?, 'DvP signing capability', 'dvp-signing-capability', 'individual', 'active', ?)`
      )
      .bind(
        ORGANIZATION_ID,
        JSON.stringify({ providerOverrides: { custody: { anchorage: true } } })
      ),
    db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, 'dvp-signing-capability@example.com', 1, 'active')`
      )
      .bind(USER_ID),
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [],
    ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
  });
  await db.batch([
    db
      .prepare(
        `INSERT INTO custody_configs (
           id, organization_id, project_id, provider, config_encrypted,
           encryption_version, status
         ) VALUES (?, ?, ?, 'anchorage', ?, 'test', 'active')`
      )
      .bind(
        CONFIG_ID,
        ORGANIZATION_ID,
        PROJECT_ID,
        JSON.stringify({ provider: "anchorage", walletId: PROVIDER_WALLET_ID })
      ),
    db
      .prepare(
        `INSERT INTO custody_scope_defaults (
           id, organization_id, project_id, default_custody_config_id
         ) VALUES (?, ?, ?, ?)`
      )
      .bind(`csd_${CONFIG_ID}`, ORGANIZATION_ID, PROJECT_ID, CONFIG_ID),
  ]);
}

/** Seeds an active Anchorage custody wallet without a settlement mapping yet. */
async function seedAnchorageCustodyWallet(): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO custody_wallets (
         id, custody_config_id, wallet_id, public_key, purpose, status
       ) VALUES (?, ?, ?, ?, 'dvp_settlement_authority', 'active')`
    )
    .bind(WALLET_ID, CONFIG_ID, PROVIDER_WALLET_ID, WALLET_ADDRESS)
    .run();
}

/** Seeds the retained (pre-guard) settlement mapping under the Anchorage wallet. */
async function seedSettlementMapping(): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO dvp_settlement_wallets (project_id, organization_id, custody_wallet_id)
       VALUES (?, ?, ?)`
    )
    .bind(PROJECT_ID, ORGANIZATION_ID, WALLET_ID)
    .run();
}

function runtimeTargets(): CustodyRuntimeTargets {
  return new CustodyRuntimeTargets(getDb(env), env, new Map());
}

describe("DvP settlement authority signing capability", () => {
  const originalApiKey = env.ANCHORAGE_API_KEY;
  const originalBaseUrl = env.ANCHORAGE_API_BASE_URL;

  beforeEach(async () => {
    provisionApiKeyWallet.mockReset();
    await seedTestDatabase(env);
    // The availability check behind signer resolution requires the deployment
    // to hold the provider's credentials; synthetic values satisfy it without
    // reaching the provider (no test below performs a provider request).
    env.ANCHORAGE_API_KEY = "synthetic-anchorage-key";
    env.ANCHORAGE_API_BASE_URL = "https://anchorage.signing-capability.test.invalid";
    await seedAnchorageDefault();
  });

  afterEach(() => {
    env.ANCHORAGE_API_KEY = originalApiKey;
    env.ANCHORAGE_API_BASE_URL = originalBaseUrl;
  });

  it("refuses to provision a settlement wallet from a lifecycle-only custody default", async () => {
    expect(canProviderSign("anchorage")).toBe(false);
    await seedAnchorageCustodyWallet();
    provisionApiKeyWallet.mockResolvedValue({ id: WALLET_ID, walletId: PROVIDER_WALLET_ID });

    await expect(getOrCreateDvpSettlementWallet(env, auditContext, scope)).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "provider_cannot_sign" },
    });

    // Failed closed BEFORE minting a provider wallet or persisting the mapping.
    expect(provisionApiKeyWallet).not.toHaveBeenCalled();
    expect(await getDb(env).queryMany("SELECT 1 FROM dvp_settlement_wallets")).toEqual([]);
  });

  it("rejects runtime admission of a retained non-signing settlement wallet", async () => {
    await seedAnchorageCustodyWallet();
    await seedSettlementMapping();

    // The read path still reports the retained authority (settle/cancel need it
    // to name the reason); create must refuse to admit it for execution.
    await expect(getOrCreateDvpSettlementWallet(env, auditContext, scope)).resolves.toMatchObject({
      custodyWalletId: WALLET_ID,
      address: WALLET_ADDRESS,
    });
    await expect(
      runtimeTargets().admitRuntimeExecution({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        custodyWalletId: WALLET_ID,
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "provider_cannot_sign" },
    });
  });

  it("still resolves the close-path signer refusal for a lifecycle-only provider", async () => {
    // Documents the original failure mode the guards prevent at create time:
    // an Anchorage settlement wallet can never sign a settle or cancel.
    await seedAnchorageCustodyWallet();
    await seedSettlementMapping();
    await expect(
      createSigningService(env).getTransactionSignerForWalletRecord(
        ORGANIZATION_ID,
        PROJECT_ID,
        WALLET_ID
      )
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: "Provider does not support transaction signing: anchorage",
    } satisfies Partial<SigningError>);
  });

  it("keeps ordinary liveness refusals ahead of the signing-capability refusal", async () => {
    await seedAnchorageCustodyWallet();
    await seedSettlementMapping();
    await getDb(env)
      .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?")
      .bind(WALLET_ID)
      .run();

    await expect(
      runtimeTargets().admitRuntimeExecution({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        custodyWalletId: WALLET_ID,
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "runtime_execution_unavailable" },
    });
  });

  it("keeps provisioning and admitting settlement wallets under signing-capable providers", async () => {
    const db = getDb(env);
    await db.batch([
      db
        .prepare(
          `INSERT INTO organizations (id, name, slug, tier, status)
           VALUES (?, 'DvP signing compatible', 'dvp-signing-compatible', 'individual', 'active')`
        )
        .bind(PRIVY_ORGANIZATION_ID),
      db
        .prepare(
          `INSERT INTO users (id, email, email_verified, status)
           VALUES (?, 'dvp-signing-compatible@example.com', 1, 'active')`
        )
        .bind(PRIVY_USER_ID),
    ]);
    await seedDefaultProjects(db, {
      organizationId: PRIVY_ORGANIZATION_ID,
      createdBy: USER_ID,
      members: [],
      ids: { sandbox: PRIVY_PROJECT_ID, production: `${PRIVY_PROJECT_ID}_production` },
    });
    await db.batch([
      db
        .prepare(
          `INSERT INTO custody_configs (
             id, organization_id, project_id, provider, config_encrypted,
             encryption_version, status
           ) VALUES (?, ?, ?, 'privy', ?, 'test', 'active')`
        )
        .bind(
          PRIVY_CONFIG_ID,
          PRIVY_ORGANIZATION_ID,
          PRIVY_PROJECT_ID,
          JSON.stringify({ provider: "privy", walletId: "privy_signing_wallet" })
        ),
      db
        .prepare(
          `INSERT INTO custody_wallets (
             id, custody_config_id, wallet_id, public_key, purpose, status
           ) VALUES (?, ?, ?, ?, 'dvp_settlement_authority', 'active')`
        )
        .bind(PRIVY_WALLET_ID, PRIVY_CONFIG_ID, "privy_signing_wallet", WALLET_ADDRESS),
      db
        .prepare(
          `INSERT INTO custody_scope_defaults (
             id, organization_id, project_id, default_custody_config_id
           ) VALUES (?, ?, ?, ?)`
        )
        .bind(`csd_${PRIVY_CONFIG_ID}`, PRIVY_ORGANIZATION_ID, PRIVY_PROJECT_ID, PRIVY_CONFIG_ID),
    ]);
    provisionApiKeyWallet.mockResolvedValue({
      id: PRIVY_WALLET_ID,
      walletId: "privy_signing_wallet",
    });

    const settlement = await getOrCreateDvpSettlementWallet(env, auditContext, {
      organizationId: PRIVY_ORGANIZATION_ID,
      projectId: PRIVY_PROJECT_ID,
    });
    expect(provisionApiKeyWallet).toHaveBeenCalledTimes(1);
    expect(settlement).toMatchObject({ custodyWalletId: PRIVY_WALLET_ID });
    await expect(
      runtimeTargets().admitRuntimeExecution({
        organizationId: PRIVY_ORGANIZATION_ID,
        projectId: PRIVY_PROJECT_ID,
        custodyWalletId: settlement.custodyWalletId,
      })
    ).resolves.toBeUndefined();
  });
});
