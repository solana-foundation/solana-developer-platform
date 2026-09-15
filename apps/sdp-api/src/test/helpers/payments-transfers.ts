import type { Permission, PolicyDefaultAction, PolicyRule } from "@sdp/types";
import type { z } from "zod";
import { getDb } from "@/db";
import { createPostgresPolicyRepository } from "@/db/repositories";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import app from "@/index";
import { createTenantScope } from "@/lib/tenant-scope";
import { transferResponse } from "@/openapi/paths/responses";
import { errorResponseSchema } from "@/openapi/schemas/base";
import type { createTransferSchema } from "@/routes/payments/schemas";
import { replaceApiKeyWalletBindings } from "@/services/api-key-wallets.service";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  seedCachedKey,
  TEST_API_KEY,
  TEST_CONFIG_ID,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";

export interface PostTransferOptions {
  idempotencyKey?: string;
  auth?: { kind: "api_key"; raw: string } | { kind: "session"; cookie: string };
  dryRun?: boolean;
}

export async function postTransfer(
  body: z.input<typeof createTransferSchema>,
  options: PostTransferOptions
): Promise<Response> {
  return postRawTransfer(body, options);
}

export async function postRawTransfer(
  body: Record<string, unknown>,
  options: PostTransferOptions
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.auth?.kind === "session") {
    headers.Cookie = options.auth.cookie;
    headers["x-project-id"] = TEST_PROJECT.id;
  } else if (options.auth?.kind === "api_key") {
    headers.Authorization = `Bearer ${options.auth.raw}`;
  } else {
    headers.Authorization = `Bearer ${TEST_API_KEY.raw}`;
  }
  if (options.idempotencyKey !== undefined) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }
  if (options.dryRun === true) {
    headers["Dry-Run"] = "true";
  }
  return app.request(
    "/v1/payments/transfers",
    { method: "POST", headers, body: JSON.stringify(body) },
    env
  );
}

export async function readTransferResponse(
  response: Response
): Promise<z.output<typeof transferResponse>> {
  return transferResponse.parse(await response.json());
}

export async function readErrorResponse(
  response: Response
): Promise<z.output<typeof errorResponseSchema>> {
  return errorResponseSchema.parse(await response.json());
}

function paymentsRepository() {
  const db = getDb(env);
  const scope = createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id });
  return createPostgresPaymentsRepository(db, scope);
}

export async function findTransferRow(id: string): Promise<PaymentTransferRow | null> {
  return paymentsRepository().getTransferById({
    transferId: id,
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
  });
}

export async function readTransferRow(id: string): Promise<PaymentTransferRow> {
  const row = await findTransferRow(id);
  if (row === null) {
    throw new Error(`Transfer ${id} was not found`);
  }
  return row;
}

export async function countTransferRows(): Promise<number> {
  return (await listTransferRows()).length;
}

export async function listTransferRows(): Promise<PaymentTransferRow[]> {
  const result = await paymentsRepository().listTransfers({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    sortBy: "createdAt",
    sortDirection: "desc",
    limit: 100,
    offset: 0,
  });
  return result.rows;
}

export async function seedWalletControlProfile(params: {
  rules: PolicyRule[];
  defaultAction?: PolicyDefaultAction;
  custodyWalletId?: string;
}): Promise<void> {
  const repo = createPostgresPolicyRepository(
    getDb(env),
    createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
  );
  const custodyWalletId =
    params.custodyWalletId === undefined ? TEST_CUSTODY_WALLET_ID : params.custodyWalletId;
  const profile = await repo.createWalletControlProfile({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    custodyWalletId,
    name: "Payment controls",
    createdBy: TEST_USER.id,
  });
  if (profile === null) {
    throw new Error("Failed to create wallet control profile");
  }
  const revision = await repo.createWalletControlProfileRevision({
    profileId: profile.id,
    rules: params.rules,
    defaultAction: params.defaultAction,
    createdBy: TEST_USER.id,
  });
  if (revision === null) {
    throw new Error("Failed to create wallet control profile revision");
  }
  await repo.activateWalletControlProfileRevision({
    profileId: profile.id,
    revisionId: revision.id,
  });
}

export async function seedCustodyWalletFixture(params: {
  id: string;
  walletId: string;
  publicKey: string;
  label: string;
}): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO custody_wallets
         (id, custody_config_id, wallet_id, public_key, label, purpose, status)
       VALUES (?, ?, ?, ?, ?, 'transfer', 'active')`
    )
    .bind(params.id, TEST_CONFIG_ID, params.walletId, params.publicKey, params.label)
    .run();
}

export async function seedConfigOwnedDuplicateProviderWallet(): Promise<void> {
  const configId = "cust_cfg_payments_exact_duplicate_test";
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted,
            encryption_version, default_wallet_id, status)
         VALUES (?, ?, ?, 'local', 'test-config', 'sdp-custody-encryption-v1', ?, 'active')`
      )
      .bind(configId, TEST_ORG.id, TEST_PROJECT.id, TEST_WALLET_ID),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES ('cwlt_payments_duplicate_test', ?, ?, ?, 'Config duplicate', 'transfer', 'active')`
      )
      .bind(configId, TEST_WALLET_ID, TEST_SOLANA_ADDRESSES.wallet3),
  ]);
}

export async function seedConnectionOwnedDuplicateProviderWallet(): Promise<void> {
  const credentialId = "pcred_payments_exact_duplicate_test";
  const connectionId = "cconn_payments_exact_duplicate_test";
  await getDb(env).batch([
    getDb(env)
      .prepare(`INSERT INTO provider_credentials (
      id, organization_id, project_id, provider, label, scope, source, storage_backend,
      encrypted_secret_payload, status, credential_version, created_by
    ) VALUES (?, ?, ?, 'local', 'Duplicate provider wallet', 'project', 'stored',
      'encrypted_db', 'not-read', 'active', 1, ?)`)
      .bind(credentialId, TEST_ORG.id, TEST_PROJECT.id, TEST_USER.id),
    getDb(env)
      .prepare(`INSERT INTO custody_connections (
      id, organization_id, project_id, provider, scope, provider_credential_id,
      provider_credential_scope_key, status, created_by
    ) VALUES (?, ?, ?, 'local', 'project', ?, ?, 'pending', ?)`)
      .bind(
        connectionId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        credentialId,
        TEST_PROJECT.id,
        TEST_USER.id
      ),
    getDb(env)
      .prepare(`INSERT INTO custody_wallets
      (id, custody_connection_id, wallet_id, public_key, label, purpose, status)
      VALUES ('cwlt_payments_duplicate_test', ?, ?, ?, 'Connection duplicate', 'transfer', 'active')`)
      .bind(connectionId, TEST_WALLET_ID, TEST_SOLANA_ADDRESSES.wallet3),
    getDb(env)
      .prepare(`UPDATE custody_connections SET default_custody_wallet_id =
      'cwlt_payments_duplicate_test', provider_account_fingerprint =
      'sha256:payments-exact-duplicate', status = 'active', last_check_status = 'success',
      last_check_at = sdp_iso_now(), activated_at = sdp_iso_now(), updated_at = sdp_iso_now()
      WHERE id = ?`)
      .bind(connectionId),
  ]);
}

export async function seedSelectedApiKeyWalletBindings(
  bindings: Array<{ walletId: string; custodyWalletId: string; permissions: Permission[] }>
): Promise<void> {
  await replaceApiKeyWalletBindings(
    getDb(env),
    TEST_API_KEY.id,
    bindings.map(({ walletId, permissions }) => ({ walletId, permissions }))
  );
  await seedCachedKey({
    walletScope: "selected",
    signingWalletId: bindings[0] === undefined ? null : bindings[0].walletId,
    signingWalletIds: bindings.map(({ walletId }) => walletId),
    walletBindings: bindings,
  });
}
