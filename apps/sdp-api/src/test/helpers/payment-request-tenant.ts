import { getDb } from "@/db/client";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import { createPostgresPaymentRequestsRepository } from "@/db/repositories/payment-requests.repository.postgres";
import { TEST_CUSTODY_PUBLIC_KEY } from "@/test/fixtures/custody";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { seedPaymentRequest } from "@/test/helpers/payment-requests";
import { type SeededDefaultProjects, seedDefaultProjects } from "@/test/helpers/projects";
import { required } from "@/test/helpers/required";
import type { Env } from "@/types/env";

/** The tenant a payment-request suite seeds: its Projects and the sandbox receiving wallet. */
export interface PaymentRequestTenant {
  organizationId: string;
  projectId: string;
  custodyWalletId: string;
  walletId: string;
  projects: SeededDefaultProjects;
}

/**
 * Clear payment requests, transfers and Projects, then seed the test org and user, its default
 * Projects, and one active custody wallet at `TEST_CUSTODY_PUBLIC_KEY` in the sandbox Project.
 *
 * @param env - Test bindings.
 * @param name - The suite's suffix: ids are `prj_<name>`, `cust_cfg_<name>`, `cwlt_<name>` and
 *   `wal_<name>`.
 * @returns The seeded tenant.
 */
export async function resetPaymentRequestTenant(
  env: Env,
  name: string
): Promise<PaymentRequestTenant> {
  const db = getDb(env);
  await db.prepare("DELETE FROM payment_requests").run();
  await db.prepare("DELETE FROM payment_transfers").run();
  await db.prepare("DELETE FROM projects").run();
  await db
    .prepare(
      "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
    )
    .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
    .run();
  await db
    .prepare(
      "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
    )
    .bind(TEST_USER.id, TEST_USER.email)
    .run();

  const projectId = `prj_${name}`;
  const custodyConfigId = `cust_cfg_${name}`;
  const custodyWalletId = `cwlt_${name}`;
  const walletId = `wal_${name}`;
  const projects = await seedDefaultProjects(db, {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [],
    ids: { sandbox: projectId, production: `${projectId}_production` },
  });
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: custodyConfigId,
        organizationId: TEST_ORG.id,
        projectId,
        provider: "local",
        configEncrypted: "test-config",
        status: "active",
      },
    ],
    wallets: [
      {
        id: custodyWalletId,
        owner: { kind: "config", custodyConfigId },
        walletId,
        publicKey: TEST_CUSTODY_PUBLIC_KEY,
        label: null,
        purpose: null,
        status: "active",
      },
    ],
  });
  return { organizationId: TEST_ORG.id, projectId, custodyWalletId, walletId, projects };
}

/**
 * Create an open payment request paying the tenant's receiving wallet, created by `TEST_USER`.
 *
 * @param env - Test bindings.
 * @param tenant - The seeded tenant.
 * @param terms - The request's token, amount and expiry.
 * @returns The stored request.
 */
export function seedTenantPaymentRequest(
  env: Env,
  tenant: PaymentRequestTenant,
  terms: { token: string; amount: string; expiresAt: string | null }
): Promise<PaymentRequestRow> {
  return seedPaymentRequest(env, {
    organizationId: tenant.organizationId,
    projectId: tenant.projectId,
    custodyWalletId: tenant.custodyWalletId,
    walletId: tenant.walletId,
    destinationAddress: TEST_CUSTODY_PUBLIC_KEY,
    token: terms.token,
    amount: terms.amount,
    expiresAt: terms.expiresAt,
    createdBy: TEST_USER.id,
  });
}

/**
 * Read a request of the tenant's sandbox Project as stored now.
 *
 * @param env - Test bindings.
 * @param tenant - The seeded tenant.
 * @param requestId - The request.
 * @returns The stored row.
 * @throws AssertionError when the request does not exist.
 */
export async function readTenantPaymentRequest(
  env: Env,
  tenant: PaymentRequestTenant,
  requestId: string
): Promise<PaymentRequestRow> {
  return required(
    await createPostgresPaymentRequestsRepository(getDb(env)).getPaymentRequestById({
      requestId,
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
    })
  );
}
