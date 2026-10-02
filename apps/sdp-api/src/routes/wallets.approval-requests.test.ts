import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import app from "@/index";
import { walletApprovalRequestsResponseSchema } from "@/openapi/schemas/custody";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  installPaymentsRouteTestHooks,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
} from "@/test/helpers/payments-routes";
import {
  postTransfer,
  readErrorResponse,
  seedWalletControlProfile,
} from "@/test/helpers/payments-transfers";

const listResponseSchema = z.object({ data: walletApprovalRequestsResponseSchema });
const approvalErrorDetailsSchema = z.object({ approvalRequestId: z.string() });

const LIST_PATH = "/v1/wallets/approval-requests";

const apiHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${TEST_API_KEY.raw}`,
};

const OTHER_ADMIN = {
  userId: "usr_approval_list_other_admin",
  sessionId: "ses_approval_list_other_admin",
  email: "approval-list-other-admin@example.com",
};

/**
 * Seeds a second organization admin with a dashboard session. A request this
 * admin raises is one the API-key caller (an admin through `*`) may decide;
 * a request the API key raises itself is one its caller never may.
 */
async function seedOtherAdminSession(): Promise<Record<string, string>> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(OTHER_ADMIN.userId, OTHER_ADMIN.email),
    db
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES (?, ?, ?, 'admin', 'active')`
      )
      .bind("om_approval_list_other_admin", TEST_ORG.id, OTHER_ADMIN.userId),
    db
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES (?, ?, ?, 'admin')`
      )
      .bind("pm_approval_list_other_admin", TEST_PROJECT.id, OTHER_ADMIN.userId),
    db
      .prepare(
        `INSERT INTO sessions (id, user_id, organization_id, auth_method, expires_at)
         VALUES (?, ?, ?, 'session', ?)`
      )
      .bind(OTHER_ADMIN.sessionId, OTHER_ADMIN.userId, TEST_ORG.id, "2099-01-01T00:00:00.000Z"),
  ]);
  return {
    "Content-Type": "application/json",
    Cookie: `sdp_session=${OTHER_ADMIN.sessionId}`,
    "x-project-id": TEST_PROJECT.id,
  };
}

/** Every payment execution on the test wallet needs an (ungrouped) approval. */
async function requireApprovalForPayments(): Promise<void> {
  await seedWalletControlProfile({
    rules: [
      {
        id: "approve-payment-execution",
        kind: "approval",
        operationTypes: ["payment_transfer_execute"],
      },
    ],
  });
}

/**
 * Raises a transfer that stops at the approval gate and pins its request's
 * `created_at`, so page order never depends on how fast the calls ran.
 */
async function raisePendingRequest(
  createdAt: string,
  auth?: { kind: "session"; cookie: string }
): Promise<string> {
  const response = await postTransfer(
    {
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "0.1",
    },
    auth ? { auth } : {}
  );
  expect(response.status).toBe(202);
  const body = await readErrorResponse(response);
  const { approvalRequestId } = approvalErrorDetailsSchema.parse(body.error.details);
  await getDb(env)
    .prepare("UPDATE approval_requests SET created_at = ? WHERE id = ?")
    .bind(createdAt, approvalRequestId)
    .run();
  return approvalRequestId;
}

async function list(query: string, headers: Record<string, string> = apiHeaders) {
  const response = await app.request(`${LIST_PATH}${query}`, { headers }, env);
  expect(response.status).toBe(200);
  return listResponseSchema.parse(await response.json()).data;
}

describe("GET /v1/wallets/approval-requests", () => {
  installPaymentsRouteTestHooks();

  it("filters by the caller's standing with viewerCanDecide", async () => {
    await requireApprovalForPayments();
    const otherAdminHeaders = await seedOtherAdminSession();
    const selfRaised = await raisePendingRequest("2026-03-01T10:00:00.000Z");
    const decidable = await raisePendingRequest("2026-03-01T11:00:00.000Z", {
      kind: "session",
      cookie: otherAdminHeaders.Cookie ?? "",
    });

    const unfiltered = await list("");
    expect(unfiltered.approvalRequests.map((item) => item.id)).toEqual([decidable, selfRaised]);
    expect(unfiltered.nextCursor).toBeNull();

    // The caller raised `selfRaised` through its own API key: a requester
    // never decides, so the request sits on the "cannot decide" side.
    const canDecide = await list("?viewerCanDecide=true");
    expect(canDecide.approvalRequests.map((item) => item.id)).toEqual([decidable]);
    expect(canDecide.approvalRequests[0]).toMatchObject({
      viewerIsRequester: false,
      viewerCanDecide: true,
    });
    expect(canDecide.nextCursor).toBeNull();

    const cannotDecide = await list("?viewerCanDecide=false");
    expect(cannotDecide.approvalRequests.map((item) => item.id)).toEqual([selfRaised]);
    expect(cannotDecide.approvalRequests[0]).toMatchObject({
      viewerIsRequester: true,
      viewerCanDecide: false,
    });
    expect(cannotDecide.nextCursor).toBeNull();

    // The filter composes with paging: the skipped row is not a page.
    const filteredPage = await list("?viewerCanDecide=true&limit=1");
    expect(filteredPage.approvalRequests.map((item) => item.id)).toEqual([decidable]);

    const invalid = await app.request(
      `${LIST_PATH}?viewerCanDecide=yes`,
      { headers: apiHeaders },
      env
    );
    expect(invalid.status).toBe(400);
  });

  it("pages newest first with an opaque cursor", async () => {
    await requireApprovalForPayments();
    const older = await raisePendingRequest("2026-03-01T10:00:00.000Z");
    const newer = await raisePendingRequest("2026-03-01T11:00:00.000Z");

    const firstPage = await list("?limit=1");
    expect(firstPage.approvalRequests.map((item) => item.id)).toEqual([newer]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await list(
      `?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`
    );
    expect(secondPage.approvalRequests.map((item) => item.id)).toEqual([older]);
    expect(secondPage.nextCursor).toBeNull();

    // Existing callers see the same rows plus the new field.
    const defaultPage = await list("");
    expect(defaultPage.approvalRequests.map((item) => item.id)).toEqual([newer, older]);
    expect(defaultPage.nextCursor).toBeNull();
  });

  it("rejects a cursor it did not issue", async () => {
    const response = await app.request(
      `${LIST_PATH}?cursor=not-a-cursor`,
      { headers: apiHeaders },
      env
    );
    expect(response.status).toBe(400);
    const body = await readErrorResponse(response);
    expect(body.error).toMatchObject({
      code: "BAD_REQUEST",
      message: "Invalid query parameters",
      details: { errors: { cursor: ["Invalid cursor"] } },
    });
  });
});
