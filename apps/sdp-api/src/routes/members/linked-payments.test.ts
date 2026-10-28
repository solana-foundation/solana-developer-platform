import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { clerkHeadersWithoutProject } from "@/test/helpers/clerk";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { env } from "@/test/helpers/env";
import {
  organizationMember,
  type SeededOrganizationMember,
  seedOrganizationMembers,
} from "@/test/helpers/organization-members";
import { seedPaymentRequest } from "@/test/helpers/payment-requests";
import { DEFAULT_PROJECT_NAME } from "@/test/helpers/projects";
import {
  seedActiveRecurringPayment,
  seedRecurringDatabaseTenant,
} from "@/test/helpers/recurring-payments";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const ORGANIZATION = { id: "org_linked_payments", slug: "linked-payments" };
const FOREIGN_ORGANIZATION = { id: "org_linked_payments_foreign", slug: "linked-payments-foreign" };
const ADMIN = organizationMember("linked_payments_admin", "admin");
const MEMBER = organizationMember("linked_payments_member", "member");
const FOREIGN_MEMBER = organizationMember("linked_payments_foreign", "member");
const SANDBOX_PROJECT_ID = "prj_linked_payments";
const PRODUCTION_PROJECT_ID = `${SANDBOX_PROJECT_ID}_production`;
const WALLET = {
  custodyWalletId: "cwlt_linked_payments",
  walletId: "wlt_linked_payments",
  address: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
};

async function linkedPayments(
  caller: SeededOrganizationMember,
  memberId: string
): Promise<Response> {
  const token = await signSeededClerkMember(env, getDb(env), caller.userId, ORGANIZATION.id);
  return app.request(
    `/v1/members/${memberId}/linked-payments`,
    { headers: clerkHeadersWithoutProject(token) },
    env
  );
}

function seedOpenRequest(projectId: string, createdBy: string) {
  return seedPaymentRequest(env, {
    organizationId: ORGANIZATION.id,
    projectId,
    custodyWalletId: WALLET.custodyWalletId,
    walletId: WALLET.walletId,
    destinationAddress: WALLET.address,
    token: SOL_MINT,
    amount: "1",
    expiresAt: null,
    createdBy,
    createdByApiKeyId: null,
  });
}

describe("GET /v1/members/:memberId/linked-payments", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await seedOrganizationMembers(db, { organization: ORGANIZATION, members: [ADMIN, MEMBER] });
    await seedOrganizationMembers(db, {
      organization: FOREIGN_ORGANIZATION,
      members: [FOREIGN_MEMBER],
    });
    await seedRecurringDatabaseTenant({
      organizationId: ORGANIZATION.id,
      organizationName: ORGANIZATION.slug,
      organizationSlug: ORGANIZATION.slug,
      userId: ADMIN.userId,
      userEmail: ADMIN.email,
      projectId: SANDBOX_PROJECT_ID,
      custodyConfigId: "cfg_linked_payments",
      custodyWalletId: WALLET.custodyWalletId,
      providerWalletId: WALLET.walletId,
      publicKey: WALLET.address,
    });
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  it("counts what the member set up directly, project by project, ordered by name", async () => {
    await seedActiveRecurringPayment({
      id: "recpay_linked_payments_member",
      organizationId: ORGANIZATION.id,
      projectId: SANDBOX_PROJECT_ID,
      createdBy: MEMBER.userId,
      source: WALLET,
      activatedBy: { kind: "member", userId: MEMBER.userId },
    });
    await seedOpenRequest(SANDBOX_PROJECT_ID, MEMBER.userId);
    await seedOpenRequest(SANDBOX_PROJECT_ID, ADMIN.userId);
    await seedOpenRequest(PRODUCTION_PROJECT_ID, MEMBER.userId);
    await seedOpenRequest(PRODUCTION_PROJECT_ID, MEMBER.userId);

    const response = await linkedPayments(ADMIN, MEMBER.memberId);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        userId: MEMBER.userId,
        projects: [
          {
            projectId: PRODUCTION_PROJECT_ID,
            projectName: DEFAULT_PROJECT_NAME.production,
            activeRecurringPayments: 0,
            openPaymentRequests: 2,
          },
          {
            projectId: SANDBOX_PROJECT_ID,
            projectName: DEFAULT_PROJECT_NAME.sandbox,
            activeRecurringPayments: 1,
            openPaymentRequests: 1,
          },
        ],
      },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
  });

  it("answers 404 for a member of another organization", async () => {
    const response = await linkedPayments(ADMIN, FOREIGN_MEMBER.memberId);

    expect(response.status).toBe(404);
  });

  it("refuses a caller without members.manage", async () => {
    const response = await linkedPayments(MEMBER, ADMIN.memberId);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { details: { action: "members.manage" } },
    });
  });
});
