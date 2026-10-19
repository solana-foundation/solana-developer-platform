import { SigningError } from "@sdp/custody/signing";
import { hashString } from "@sdp/payments/hash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { deriveCustodyWalletCreateRequestId } from "@/routes/custody/handlers/wallets";
import * as custodyProvisioning from "@/services/custody/provisioning";
import { privyWalletExternalId } from "@/services/domain/signing/provider-wallet-lifecycle";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import {
  seedTestPrivyConnection,
  writeTestPrivyCredentialSecret,
} from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { type SeededApiKey, seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const provisionPrivyWalletMock = vi.spyOn(custodyProvisioning, "provisionPrivyWallet");

const ORGANIZATION_ID = "org_custody_wallet_owner";
const PROJECT_ID = "prj_custody_wallet_owner";
const USER_ID = "usr_custody_wallet_owner";
const CONFIG_ID = "cust_cfg_wallet_owner_privy";
const CONFIG_WALLET_RECORD_ID = "cwlt_wallet_owner_config";
const CREDENTIAL_ID = "pcred_wallet_owner";
const CONNECTION_ID = "cconn_wallet_owner";
const CONNECTION_WALLET_RECORD_ID = "cwlt_wallet_owner_connection";
const CONNECTION_WALLET_ID = "privy_wallet_owner_connection";
const CONNECTION_WALLET_PUBLIC_KEY = "So11111111111111111111111111111111111111112";
const CREATED_PUBLIC_KEY = "Vote111111111111111111111111111111111111111";
const API_KEY = {
  id: "key_custody_wallet_owner",
  raw: "sk_test_custody_wallet_owner",
  prefix: "sk_test_cwo",
};
const CACHED_API_KEY: SeededApiKey = {
  id: API_KEY.id,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  grants: ALL_API_KEY_GRANTS,
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

const originalEncryptionKey = env.CUSTODY_ENCRYPTION_KEY;
const originalPrivyAppId = env.PRIVY_APP_ID;
const originalPrivyAppSecret = env.PRIVY_APP_SECRET;

async function seedFixture(): Promise<void> {
  const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
  await seedApiKeyRow(env, keyHash, CACHED_API_KEY);
  await getDb(env).batch([
    getDb(env)
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'enterprise', 'active')"
      )
      .bind(ORGANIZATION_ID, "Wallet owner", "wallet-owner"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER_ID, "wallet-owner@example.com"),
  ]);
  await seedDefaultProjects(getDb(env), {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [],
    ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
  });
  await getDb(env).execute(
    `INSERT INTO api_keys (
       id, organization_id, project_id, created_by, name, key_prefix,
       key_hash, grants, status
     ) VALUES (?, ?, ?, ?, 'Test', ?, ?, ?, 'active')`,
    [API_KEY.id, ORGANIZATION_ID, PROJECT_ID, USER_ID, API_KEY.prefix, keyHash, ALL_API_KEY_GRANTS]
  );
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: CONFIG_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "privy",
        configEncrypted: JSON.stringify({ provider: "privy" }),
        status: "active",
      },
    ],
    wallets: [
      {
        id: CONFIG_WALLET_RECORD_ID,
        owner: { kind: "config", custodyConfigId: CONFIG_ID },
        walletId: "privy_wallet_owner_config",
        publicKey: "11111111111111111111111111111111",
        label: "Managed",
        purpose: "root",
        status: "active",
      },
    ],
  });
  const stored = await writeTestPrivyCredentialSecret(env, {
    organizationId: ORGANIZATION_ID,
    credentialId: CREDENTIAL_ID,
    appId: "wallet-owner-app",
    appSecret: "wallet-owner-secret",
  });
  await getDb(env).transaction((tx) =>
    seedTestPrivyConnection(tx, {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      connectionId: CONNECTION_ID,
      credentialId: CREDENTIAL_ID,
      createdBy: USER_ID,
      stored,
      providerAccountFingerprint: `sha256:${CREDENTIAL_ID}`,
      lastCheckStatus: "success",
      wallets: [
        {
          id: CONNECTION_WALLET_RECORD_ID,
          walletId: CONNECTION_WALLET_ID,
          publicKey: CONNECTION_WALLET_PUBLIC_KEY,
          label: "Connection",
          purpose: null,
          status: "active",
        },
      ],
      defaultCustodyWalletId: CONNECTION_WALLET_RECORD_ID,
    })
  );
}

async function createWallet(
  body: Record<string, unknown>,
  idempotencyKey?: string
): Promise<Response> {
  const headers = new Headers({
    Authorization: `Bearer ${API_KEY.raw}`,
    "Content-Type": "application/json",
  });
  if (idempotencyKey) {
    headers.set("Idempotency-Key", idempotencyKey);
  }
  return app.request("/v1/wallets", { method: "POST", headers, body: JSON.stringify(body) }, env);
}

/**
 * The process died before the key's response was stored (after the provider
 * call, or after the wallet row): the key is left `in_progress` with an ended
 * lease, so the next request with it takes the key over and runs again.
 */
async function crashBeforeKeyStored(idempotencyKey: string): Promise<number> {
  return getDb(env).execute(
    `UPDATE idempotency_keys
     SET status = 'in_progress', claim_token = 'crashed', locked_until = now() - interval '1 second',
         -- Past the renewal cap plus the lease too, so the claim counts as dead.
         claimed_at = now() - interval '1 hour',
         response_status = NULL, response_headers = NULL, response_body = NULL
     WHERE idempotency_key = ?`,
    [idempotencyKey]
  );
}

async function readPublicKey(query: string): Promise<Response> {
  return app.request(
    `/v1/wallets/public-key${query}`,
    { method: "GET", headers: { Authorization: `Bearer ${API_KEY.raw}` } },
    env
  );
}

async function readWalletRows() {
  return getDb(env).queryMany<{
    id: string;
    custody_config_id: string | null;
    custody_connection_id: string | null;
    wallet_id: string;
  }>(
    "SELECT id, custody_config_id, custody_connection_id, wallet_id FROM custody_wallets ORDER BY id"
  );
}

describe("Custody wallet owner contract", () => {
  beforeEach(async () => {
    provisionPrivyWalletMock.mockReset();
    env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString("base64");
    env.PRIVY_APP_ID = "managed-wallet-owner-app";
    env.PRIVY_APP_SECRET = "managed-wallet-owner-secret";
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedFixture();
  });

  afterEach(async () => {
    env.CUSTODY_ENCRYPTION_KEY = originalEncryptionKey;
    env.PRIVY_APP_ID = originalPrivyAppId;
    env.PRIVY_APP_SECRET = originalPrivyAppSecret;
    await clearKVStores(env);
  });

  it.each([
    ["neither provider nor connectionId", { label: "Ownerless" }],
    ["both provider and connectionId", { provider: "privy", connectionId: CONNECTION_ID }],
  ])("rejects a wallet body naming %s before any provider call", async (_case, body) => {
    const before = await readWalletRows();

    const response = await createWallet(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: expect.stringContaining(
          "Name exactly one of provider (Managed) or connectionId (BYOK)"
        ),
      },
    });
    expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
    expect(await readWalletRows()).toEqual(before);
  });

  it("creates a Managed wallet under the named provider's config", async () => {
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "managed_created",
      address: CREATED_PUBLIC_KEY,
    });

    const response = await createWallet({
      provider: "privy",
      label: "Treasury",
      purpose: "transfer",
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { wallet: { id: string } } };
    expect(body.data).toEqual({
      wallet: {
        id: expect.any(String),
        custodyConfigId: CONFIG_ID,
        isRuntimeExecutionAllowed: true,
        walletId: "privy_managed_created",
        publicKey: CREATED_PUBLIC_KEY,
        label: "Treasury",
        purpose: "transfer",
        status: "active",
        createdAt: expect.any(String),
      },
    });
    expect(provisionPrivyWalletMock).toHaveBeenCalledOnce();
    expect(
      await getDb(env).queryOne(
        "SELECT custody_config_id, custody_connection_id, wallet_id, public_key FROM custody_wallets WHERE id = ?",
        [body.data.wallet.id]
      )
    ).toEqual({
      custody_config_id: CONFIG_ID,
      custody_connection_id: null,
      wallet_id: "privy_managed_created",
      public_key: CREATED_PUBLIC_KEY,
    });
  });

  it("creates a BYOK wallet under the named connection", async () => {
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "connection_created",
      address: CREATED_PUBLIC_KEY,
    });

    const response = await createWallet({
      connectionId: CONNECTION_ID,
      label: "Settlement",
      purpose: "transfer",
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { wallet: { id: string } } };
    expect(body.data).toEqual({
      wallet: {
        id: expect.any(String),
        custodyConnectionId: CONNECTION_ID,
        isRuntimeExecutionAllowed: true,
        walletId: "privy_connection_created",
        publicKey: CREATED_PUBLIC_KEY,
        label: "Settlement",
        purpose: "transfer",
        status: "active",
        createdAt: expect.any(String),
      },
    });
    expect(provisionPrivyWalletMock).toHaveBeenCalledOnce();
    expect(
      await getDb(env).queryOne(
        "SELECT custody_config_id, custody_connection_id, wallet_id, public_key FROM custody_wallets WHERE id = ?",
        [body.data.wallet.id]
      )
    ).toEqual({
      custody_config_id: null,
      custody_connection_id: CONNECTION_ID,
      wallet_id: "privy_connection_created",
      public_key: CREATED_PUBLIC_KEY,
    });
  });

  it("requires walletId to read a public key", async () => {
    const response = await readPublicKey("");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "walletId is required" },
      meta: { requestId: expect.any(String) },
    });
  });

  it("reads the public key of the named wallet", async () => {
    const response = await readPublicKey(`?walletId=${CONNECTION_WALLET_ID}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { publicKey: CONNECTION_WALLET_PUBLIC_KEY },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
  });

  describe("under an Idempotency-Key", () => {
    const KEY = "custody-create-key-1";
    const requestId = (key: string) =>
      deriveCustodyWalletCreateRequestId(
        { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID, principal: API_KEY.id },
        key
      );

    it.each([
      ["Managed", { provider: "privy", label: "Treasury" }, {}],
      ["BYOK", { connectionId: CONNECTION_ID, label: "Settlement" }, { credentialRequest: true }],
    ])("sends Privy the same request id on a retry of a %s create", async (_kind, body, extra) => {
      // The first attempt's outcome is unknown: Privy may have made the wallet.
      provisionPrivyWalletMock
        .mockRejectedValueOnce(new SigningError("Privy timed out", "NETWORK_ERROR"))
        .mockResolvedValueOnce({ walletId: "keyed_created", address: CREATED_PUBLIC_KEY });

      expect((await createWallet(body, KEY)).status).toBeGreaterThanOrEqual(400);
      await crashBeforeKeyStored(KEY);
      expect((await createWallet(body, KEY)).status).toBe(201);

      const expected = {
        ...extra,
        externalId: privyWalletExternalId(requestId(KEY)),
        idempotencyKey: requestId(KEY),
      };
      expect(provisionPrivyWalletMock).toHaveBeenCalledTimes(2);
      expect(provisionPrivyWalletMock.mock.calls[0]?.[1]).toEqual(expected);
      expect(provisionPrivyWalletMock.mock.calls[1]?.[1]).toEqual(expected);
    });

    it.each([
      ["Managed", { provider: "privy", label: "Treasury" }],
      ["BYOK", { connectionId: CONNECTION_ID, label: "Settlement" }],
    ])(
      "takes over a crashed create and answers it from the %s wallet row, not the terminal 409, without calling the provider",
      async (_kind, body) => {
        provisionPrivyWalletMock.mockResolvedValueOnce({
          walletId: "keyed_created",
          address: CREATED_PUBLIC_KEY,
        });
        const first = await createWallet(body, KEY);
        expect(first.status).toBe(201);
        const created = (await first.json()) as { data: unknown };
        expect(await crashBeforeKeyStored(KEY)).toBe(1);
        provisionPrivyWalletMock.mockClear();
        const rowsBefore = await readWalletRows();

        const retry = await createWallet(body, KEY);

        // recovery: "record" lets the lapsed claim be taken over; without it a
        // store route answers 409 IDEMPOTENCY_KEY_OUTCOME_UNKNOWN.
        expect(retry.status).toBe(201);
        expect(retry.headers.get("Idempotent-Replayed")).toBe("true");
        expect(((await retry.json()) as { data: unknown }).data).toEqual(created.data);
        expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
        expect(await readWalletRows()).toEqual(rowsBefore);
        expect(
          await getDb(env).queryOne(
            "SELECT idempotency_request_id FROM custody_wallets WHERE wallet_id = ?",
            ["privy_keyed_created"]
          )
        ).toEqual({ idempotency_request_id: requestId(KEY) });
      }
    );

    it("refuses a retry whose body differs from the request that made the wallet row", async () => {
      provisionPrivyWalletMock.mockResolvedValueOnce({
        walletId: "keyed_created",
        address: CREATED_PUBLIC_KEY,
      });
      expect((await createWallet({ provider: "privy", label: "Treasury" }, KEY)).status).toBe(201);
      // Past the key's 24 hours: only the wallet row remembers the request.
      await getDb(env).execute("DELETE FROM idempotency_keys WHERE idempotency_key = ?", [KEY]);
      provisionPrivyWalletMock.mockClear();

      const retry = await createWallet({ provider: "privy", label: "Other" }, KEY);

      expect(retry.status).toBe(422);
      expect(await retry.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });
      expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
    });

    it("derives a different request id for a different key, tenant or credential", () => {
      const scope = {
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        principal: API_KEY.id,
      };
      const ids = [
        deriveCustodyWalletCreateRequestId(scope, KEY),
        deriveCustodyWalletCreateRequestId(scope, "custody-create-key-2"),
        deriveCustodyWalletCreateRequestId({ ...scope, organizationId: "org_other" }, KEY),
        deriveCustodyWalletCreateRequestId({ ...scope, projectId: "prj_other" }, KEY),
        deriveCustodyWalletCreateRequestId({ ...scope, principal: "key_other" }, KEY),
      ];

      expect(deriveCustodyWalletCreateRequestId(scope, KEY)).toBe(ids[0]);
      expect(new Set(ids).size).toBe(ids.length);
      // The raw client key never reaches a provider.
      for (const id of ids) {
        expect(id).not.toContain(KEY);
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      }
    });

    it("answers a Managed provider failure with a stored 503, not a 400", async () => {
      provisionPrivyWalletMock.mockRejectedValueOnce(
        new SigningError("Privy API error: 500 - upstream", "NETWORK_ERROR")
      );

      const response = await createWallet({ provider: "privy", label: "Treasury" }, KEY);

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "PROVIDER_UNAVAILABLE" } });
      expect(
        await getDb(env).queryOne(
          "SELECT status, response_status FROM idempotency_keys WHERE idempotency_key = ?",
          [KEY]
        )
      ).toEqual({ status: "completed", response_status: 503 });
    });

    // Privy dedupes on the request id, so the loser usually gets the winner's
    // own wallet back, and its insert can fail on the owner-and-wallet unique
    // constraint rather than the request id's.
    it.each([
      [
        "Managed",
        "another",
        { provider: "privy", label: "Treasury" },
        { custodyConfigId: CONFIG_ID },
      ],
      [
        "Managed",
        "the same",
        { provider: "privy", label: "Treasury" },
        { custodyConfigId: CONFIG_ID },
      ],
      [
        "BYOK",
        "another",
        { connectionId: CONNECTION_ID, label: "Settlement" },
        { custodyConnectionId: CONNECTION_ID },
      ],
      [
        "BYOK",
        "the same",
        { connectionId: CONNECTION_ID, label: "Settlement" },
        { custodyConnectionId: CONNECTION_ID },
      ],
    ])(
      "answers a %s create that loses the race for its request id, holding %s provider wallet, from the row that won",
      async (_kind, loserWallet, body, owner) => {
        provisionPrivyWalletMock.mockImplementationOnce(async () => {
          // A concurrent attempt under the same key recorded its wallet first.
          const claim = await getDb(env).queryOne<{ fingerprint: string }>(
            "SELECT fingerprint FROM idempotency_keys WHERE idempotency_key = ?",
            [KEY]
          );
          await seedTestCustodyRows(env, {
            configs: [],
            wallets: [
              {
                id: "cwlt_raced_winner",
                owner:
                  "custodyConfigId" in owner
                    ? { kind: "config", custodyConfigId: owner.custodyConfigId }
                    : { kind: "connection", custodyConnectionId: owner.custodyConnectionId },
                walletId: "privy_raced_winner",
                publicKey: CREATED_PUBLIC_KEY,
                label: body.label,
                purpose: null,
                status: "active",
              },
            ],
          });
          await getDb(env).execute(
            `UPDATE custody_wallets SET idempotency_request_id = ?, idempotency_fingerprint = ?
              WHERE id = 'cwlt_raced_winner'`,
            [requestId(KEY), claim?.fingerprint ?? null]
          );
          return {
            walletId: loserWallet === "the same" ? "raced_winner" : "raced_loser",
            address: CREATED_PUBLIC_KEY,
          };
        });

        const response = await createWallet(body, KEY);

        expect(response.status).toBe(201);
        expect(await response.json()).toMatchObject({
          data: { wallet: { id: "cwlt_raced_winner", walletId: "privy_raced_winner", ...owner } },
        });
        expect(
          (await readWalletRows()).filter((row) => row.wallet_id === "privy_raced_loser")
        ).toEqual([]);
        // Every audit intent the losing attempt opened has its outcome: none is
        // left for reconciliation.
        expect(
          await getDb(env).queryOne(
            `SELECT COUNT(*)::integer AS count FROM audit_logs i
              WHERE i.metadata::jsonb->>'auditPhase' = 'intent'
                AND NOT EXISTS (
                  SELECT 1 FROM audit_logs o
                   WHERE o.metadata::jsonb->>'auditIntentId' = i.resource_id
                )`
          )
        ).toEqual({ count: 0 });
        if ("custodyConnectionId" in owner) {
          // The BYOK outcome names the wallet that won, not the loser's unsaved id.
          expect(
            await getDb(env).queryOne(
              `SELECT resource_id FROM audit_logs
                WHERE resource_type = 'custody_wallet'
                  AND metadata::jsonb->>'result' = 'already_recorded'`
            )
          ).toEqual({ resource_id: "cwlt_raced_winner" });
        }
      }
    );
  });
});
