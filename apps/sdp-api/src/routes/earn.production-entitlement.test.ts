import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  type EarnMovementRow,
  generateEarnPositionId,
} from "@/db/repositories/earn-movements.repository";
import app from "@/index";
import {
  seedTestPrivyConnection,
  writeTestPrivyCredentialSecret,
} from "@/test/helpers/custody-connections";
import { type EarnAuthzTenant, seedEarnApiKey, seedEarnAuthzTenant } from "@/test/helpers/earn";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const withdrawFromVault = vi.hoisted(() => vi.fn());

vi.mock("@/services/earn/vault-withdraw.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/earn/vault-withdraw.service")>()),
  withdrawFromVault,
}));
vi.mock("@sdp/types/provider-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdp/types/provider-access")>()),
  isEarnProviderSurfaced: () => true,
}));

/**
 * APE-351 x ADR 0002: a production organization that loses
 * `enableProductionProject` keeps every Earn read and every way out of a
 * position, and is refused anything that opens new exposure.
 */

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "So11111111111111111111111111111111111111112";
const VAULT = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
const WALLET_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const CUSTODY_WALLET_ID = "cwlt_earn_prod_entitlement";

let tenant: EarnAuthzTenant;
let apiKeyRaw: string;
let originalMarketsEnabled: string | undefined;
let originalEarnEnabled: string | undefined;
let originalEncryptionKey: string | undefined;

type Actor = "api_key" | "clerk";

function authHeaders(actor: Actor): Record<string, string> {
  return actor === "api_key"
    ? { Authorization: `Bearer ${apiKeyRaw}` }
    : { Authorization: `Bearer ${tenant.token}`, "x-project-id": tenant.project.id };
}

function request(
  actor: Actor,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>
): Response | Promise<Response> {
  return app.request(
    path,
    {
      method,
      headers: {
        ...authHeaders(actor),
        ...(method === "POST"
          ? { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env
  );
}

async function setProductionEntitled(entitled: boolean): Promise<void> {
  await getDb(env)
    .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
    .bind(JSON.stringify({ enableProductionProject: entitled }), tenant.org.id)
    .run();
}

async function seedProductionPosition(): Promise<string> {
  const db = getDb(env);
  await seedTestPrivyConnection(db, {
    organizationId: tenant.org.id,
    projectId: tenant.project.id,
    connectionId: "cconn_earn_prod_entitlement",
    credentialId: "pcred_earn_prod_entitlement",
    createdBy: tenant.user.id,
    stored: await writeTestPrivyCredentialSecret(env, {
      organizationId: tenant.org.id,
      credentialId: "pcred_earn_prod_entitlement",
      appId: "earn-prod-entitlement-app",
      appSecret: "earn-prod-entitlement-secret",
    }),
    providerAccountFingerprint: "sha256:earn-prod-entitlement",
    wallets: [
      {
        id: CUSTODY_WALLET_ID,
        walletId: "privy_earn_prod_entitlement",
        publicKey: WALLET_ADDRESS,
        label: null,
        purpose: null,
        status: "active",
      },
    ],
    lastCheckStatus: "success",
    defaultCustodyWalletId: CUSTODY_WALLET_ID,
  });
  const id = generateEarnPositionId();
  await db
    .prepare(
      `INSERT INTO earn_positions (
         id, organization_id, project_id, environment, provider, kind,
         custody_wallet_id, vault_address, share_mint, token_mint,
         provider_wallet_id, label, activated_at
       ) VALUES (?, ?, ?, 'production', 'kamino', 'vault_direct', ?, ?, ?, ?, NULL,
                 'Exit Vault', sdp_iso_now())`
    )
    .bind(id, tenant.org.id, tenant.project.id, CUSTODY_WALLET_ID, VAULT, SHARE_MINT, USDC_MINT)
    .run();
  return id;
}

function movementRow(positionId: string, requestId: string): EarnMovementRow {
  const now = new Date().toISOString();
  return {
    id: `earn_movement_${crypto.randomUUID()}`,
    organization_id: tenant.org.id,
    project_id: tenant.project.id,
    environment: "production",
    provider: "kamino",
    execution_model: "vault_direct",
    direction: "withdrawal",
    position_id: positionId,
    status: "submitted",
    failure_reason: null,
    confirmed_at: null,
    chain_finalized_at: null,
    settled_at: null,
    denomination: SHARE_MINT,
    amount_requested: "10",
    amount_settled: null,
    fee_amount: null,
    token_amount_settled: null,
    min_shares_out: null,
    shares_out: null,
    payout_token: null,
    custody_wallet_id: CUSTODY_WALLET_ID,
    owner_address: null,
    vault_address: VAULT,
    source_address: VAULT,
    destination_address: WALLET_ADDRESS,
    provider_reference: null,
    signature: `sig_${crypto.randomUUID()}`,
    signed_transaction: "AQ==",
    last_valid_block_height: "12345",
    request_id: requestId,
    idempotency_fingerprint: "{}",
    provider_data: {},
    created_by: null,
    initiated_by_key_id: null,
    created_at: now,
    updated_at: now,
    creates_share_account: false,
    share_ata_rent_funder: null,
    unknown_signature_observed_at: null,
  };
}

beforeEach(async () => {
  originalMarketsEnabled = env.MARKETS_ENABLED;
  originalEarnEnabled = env.EARN_ENABLED;
  originalEncryptionKey = env.CUSTODY_ENCRYPTION_KEY;
  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";
  env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 41).toString("base64");
  await seedTestDatabase(env);
  await clearKVStores(env);
  vi.clearAllMocks();
  withdrawFromVault.mockImplementation(async (_env, input) => ({
    position: { id: input.positionId },
    movement: movementRow(input.positionId, input.requestId),
    replayed: false,
  }));

  tenant = await seedEarnAuthzTenant(env, "earn_prod_entitlement", {
    environment: "production",
  });
  apiKeyRaw = (
    await seedEarnApiKey(env, tenant, {
      id: "key_earn_prod_entitlement",
      permissions: ["*"],
      environment: "production",
    })
  ).raw;
  await setProductionEntitled(false);
});

afterEach(() => {
  env.MARKETS_ENABLED = originalMarketsEnabled;
  env.EARN_ENABLED = originalEarnEnabled;
  env.CUSTODY_ENCRYPTION_KEY = originalEncryptionKey;
  vi.restoreAllMocks();
});

describe.each([
  ["a production API key", "api_key"],
  ["a Clerk member on the production project", "clerk"],
] as const)("Earn without the production entitlement, as %s (APE-351)", (_label, actor) => {
  it("still answers GET /v1/earn/vault-positions", async () => {
    const res = await request(actor, "GET", "/v1/earn/vault-positions");
    expect(res.status).toBe(200);
  });

  it("withdraws an existing production position", async () => {
    const positionId = await seedProductionPosition();

    const res = await request(actor, "POST", "/v1/earn/vault-withdrawals", {
      positionId,
      shares: "10",
    });

    expect(res.status).toBe(200);
    expect(withdrawFromVault).toHaveBeenCalledTimes(1);
    expect(withdrawFromVault.mock.calls[0]?.[1]).toMatchObject({
      positionId,
      environment: "production",
    });
  });
});
