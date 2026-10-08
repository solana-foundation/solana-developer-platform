import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  type EarnMovementRow,
  generateEarnPositionId,
} from "@/db/repositories/earn-movements.repository";
import app from "@/index";
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

const PRODUCTION_NOT_ENABLED = "Production is not enabled for this organization";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "So11111111111111111111111111111111111111112";
const VAULT = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
const WALLET_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const CUSTODY_WALLET_ID = "cwlt_earn_prod_entitlement";

let tenant: EarnAuthzTenant;
let apiKeyRaw: string;
let originalMarketsEnabled: string | undefined;
let originalEarnEnabled: string | undefined;

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

async function errorMessage(res: Response): Promise<string | undefined> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message;
}

async function expectProductionNotEnabled(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({
    error: { code: "FORBIDDEN", message: PRODUCTION_NOT_ENABLED },
  });
}

async function expectNotEntitlementRefusal(res: Response): Promise<void> {
  const message = await errorMessage(res);
  expect(message, `HTTP ${res.status}`).not.toBe(PRODUCTION_NOT_ENABLED);
}

async function seedProductionPosition(): Promise<string> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES ('cfg_earn_prod_entitlement', ?, ?, 'privy', 'encrypted', 'active')`
      )
      .bind(tenant.org.id, tenant.project.id),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, 'cfg_earn_prod_entitlement', 'privy_earn_prod_entitlement', ?, 'active')`
      )
      .bind(CUSTODY_WALLET_ID, WALLET_ADDRESS),
  ]);
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
  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";
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
  vi.restoreAllMocks();
});

describe.each([
  ["a production API key", "api_key"],
  ["a Clerk member on the production project", "clerk"],
] as const)("Earn without the production entitlement, as %s (APE-351)", (_label, actor) => {
  it.each(["/v1/earn/vault-positions", "/v1/earn/movements"])(
    "still answers GET %s",
    async (path) => {
      const res = await request(actor, "GET", path);
      expect(res.status).toBe(200);
    }
  );

  it("does not refuse a withdrawal preview with the entitlement 403", async () => {
    const res = await request(actor, "POST", "/v1/earn/vault-withdrawal-previews", {
      positionId: generateEarnPositionId(),
      shares: "10",
    });
    expect(res.status).not.toBe(200);
    await expectNotEntitlementRefusal(res);
  });

  it("does not refuse a withdrawal of a missing position with the entitlement 403", async () => {
    const res = await request(actor, "POST", "/v1/earn/vault-withdrawals", {
      positionId: generateEarnPositionId(),
      shares: "10",
    });
    expect(res.status).toBe(404);
    await expectNotEntitlementRefusal(res);
    expect(withdrawFromVault).not.toHaveBeenCalled();
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

  it.each(["/v1/earn/vault-deposits", "/v1/earn/vault-deposit-previews", "/v1/earn/programs"])(
    "refuses POST %s with the entitlement 403",
    async (path) => {
      await expectProductionNotEnabled(await request(actor, "POST", path, {}));
    }
  );

  it.each(["/v1/earn/vault-deposits", "/v1/earn/programs"])(
    "lets POST %s past the entitlement once the organization is entitled",
    async (path) => {
      await setProductionEntitled(true);
      await expectNotEntitlementRefusal(await request(actor, "POST", path, {}));
    }
  );
});
