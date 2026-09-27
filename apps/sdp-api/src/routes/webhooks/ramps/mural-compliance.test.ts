import { createSign, generateKeyPairSync } from "node:crypto";
import type { ExecutionContext } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import type { PaymentTransferRow } from "@/db/repositories";
import type { RampWebhookEventRow } from "@/db/repositories/ramp-webhook-event.repository";
import app from "@/index";
import {
  applyStoredRampWebhookEvent,
  RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
} from "@/services/jobs/replay-ramp-webhook-events";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { claimMuralAccountCredit, MuralWebhookProcessor } from "./mural";

/**
 * Regression for SOLA9-628 (APE-845): a signed Mural compliance-review or
 * business-verification rejection used to be parsed as `ignore`, acked,
 * persisted, and deleted without updating the cached KYC. The stale `approved`
 * cache then passed the on-ramp quote gate and a later signed
 * `account_credited` event completed settlement without any compliance check.
 *
 * The secure behavior asserted here:
 *  - every documented compliance event name parses to a kyc_status event whose
 *    normalized status reflects the provider decision (rejection/error clear
 *    approval, approval still verifies);
 *  - a signed compliance rejection mutates the cached Mural organization state
 *    and the mirrored kyc_wallets status;
 *  - a subsequent signed account_credited event must NOT settle a transfer for
 *    a rejected organization, while the approved control still settles.
 */
describe("Mural compliance-review webhooks update cached KYC and gate settlement", () => {
  const organizationId = "org_mural_compliance_regression";
  const projectId = "prj_mural_compliance_regression";
  const userId = "usr_mural_compliance_regression";
  const counterpartyId = "cp_mural_compliance_regression";
  const muralOrganizationId = "mural_org_compliance_regression";
  const accountId = "mural_account_compliance_regression";
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const processor = new MuralWebhookProcessor();

  async function sendMuralWebhook(payload: unknown): Promise<Response> {
    const rawBody = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const signature = createSign("SHA256")
      .update(`${timestamp}.${rawBody}`)
      .sign(privateKey)
      .toString("base64");
    const background: Promise<unknown>[] = [];
    const executionContext: ExecutionContext = {
      waitUntil(promise) {
        background.push(promise);
      },
      passThroughOnException() {},
      props: {},
    };
    const response = await app.request(
      "/webhooks/payments/ramps/sandbox/mural",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-mural-webhook-signature": signature,
          "x-mural-webhook-timestamp": timestamp,
        },
        body: rawBody,
      },
      env,
      executionContext
    );
    await Promise.all(background);
    return response;
  }

  async function seedAwaitingTransfer(id: string): Promise<void> {
    const now = new Date().toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id, organization_id, project_id, wallet_id, counterparty_id,
           source_address, destination_address, token, amount, memo, type,
           direction, status, provider, provider_reference, delivery_mode,
           fiat_currency, fiat_amount, provider_data, signature, serialized_tx,
           initiated_by_key_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        organizationId,
        projectId,
        "wallet_mural_compliance_regression",
        counterpartyId,
        null,
        "compliance-regression-destination",
        "USDC",
        null,
        null,
        "onramp",
        "inbound",
        "awaiting_payment",
        "mural",
        `quote_${id}`,
        "manual_instructions",
        "USD",
        "100",
        { mural: { accountId } },
        null,
        null,
        null,
        now,
        now
      )
      .run();
  }

  async function cachedKycStatus(): Promise<string | undefined> {
    const row = await getDb(env)
      .prepare(
        `SELECT provider_data->'mural'->'organization'->>'kycStatus' AS kyc_status
         FROM counterparties WHERE id = ?`
      )
      .bind(counterpartyId)
      .first<{ kyc_status: string | null }>();
    return row?.kyc_status ?? undefined;
  }

  async function inboxCount(): Promise<number> {
    const row = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS count FROM ramp_webhook_events")
      .first<{ count: number }>();
    return row?.count ?? -1;
  }

  async function inboxRow(): Promise<RampWebhookEventRow> {
    const row = await getDb(env)
      .prepare("SELECT * FROM ramp_webhook_events")
      .first<Record<string, unknown>>();
    if (!row) {
      throw new Error("expected a ramp_webhook_events row");
    }
    return row as unknown as RampWebhookEventRow;
  }

  async function transferStatus(id: string): Promise<string | undefined> {
    const row = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    return row?.status;
  }

  async function transferRow(id: string): Promise<PaymentTransferRow> {
    const row = await getDb(env)
      .prepare("SELECT * FROM payment_transfers WHERE id = ?")
      .bind(id)
      .first<Record<string, unknown>>();
    if (!row) {
      throw new Error(`transfer ${id} was not seeded`);
    }
    return row as unknown as PaymentTransferRow;
  }

  async function setCachedKycStatus(status: string): Promise<void> {
    await getDb(env)
      .prepare(
        `UPDATE counterparties
            SET provider_data = jsonb_set(
                  provider_data,
                  '{mural,organization,kycStatus}',
                  to_jsonb(?::text)
                )
          WHERE id = ?`
      )
      .bind(status, counterpartyId)
      .run();
  }

  beforeEach(async () => {
    await seedTestDatabase(env);
    env.MURAL_PAY_SANDBOX_WEBHOOK_PUBLIC_KEY = publicKey;
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(
          organizationId,
          "Mural Compliance Regression",
          "mural-compliance-regression",
          "enterprise",
          "active"
        ),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
        .bind(userId, "mural-compliance-regression@example.com", 1, "active"),
    ]);
    await seedDefaultProjects(getDb(env), {
      organizationId,
      createdBy: userId,
      members: [],
      ids: { sandbox: projectId, production: `${projectId}_production` },
    });
    await getDb(env)
      .prepare(
        `INSERT INTO counterparties (
           id, organization_id, project_id, entity_type, display_name,
           status, created_by, mural_organization_id, provider_data
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)`
      )
      .bind(
        counterpartyId,
        organizationId,
        projectId,
        "business",
        "Mural Compliance Regression Buyer",
        "active",
        userId,
        muralOrganizationId,
        {
          mural: {
            organization: {
              id: muralOrganizationId,
              type: "business",
              tosStatus: "ACCEPTED",
              kycStatus: "approved",
            },
          },
        }
      )
      .run();
  });

  afterEach(() => {
    env.MURAL_PAY_SANDBOX_WEBHOOK_PUBLIC_KEY = undefined;
  });

  it("parses every documented compliance event name into a normalized kyc status", () => {
    // The plain provider-documented names.
    expect(
      processor.parse({
        payload: {
          type: "compliance_review_status_changed",
          organizationId: muralOrganizationId,
          complianceReviewId: "review_1",
          currentStatus: { type: "rejected", rejectionDescription: "KYC rejected" },
        },
      })
    ).toEqual({
      kind: "kyc_status",
      organizationId: muralOrganizationId,
      kycStatus: "rejected",
      source: { kind: "compliance_review", id: "review_1" },
    });
    expect(
      processor.parse({
        payload: {
          type: "business_verification_status_changed",
          organizationId: muralOrganizationId,
          verificationId: "verification_1",
          currentStatus: { type: "rejected", reason: "KYC rejected" },
        },
      })
    ).toEqual({
      kind: "kyc_status",
      organizationId: muralOrganizationId,
      kycStatus: "rejected",
      source: { kind: "business_verification", id: "verification_1" },
    });

    // The category-qualified spellings Mural uses on some subscriptions.
    expect(
      processor.parse({
        payload: {
          type: "business.verification_status_changed",
          organizationId: muralOrganizationId,
          verificationId: "verification_2",
          currentStatus: { type: "inReview" },
        },
      })
    ).toEqual({
      kind: "kyc_status",
      organizationId: muralOrganizationId,
      kycStatus: "pending",
      source: { kind: "business_verification", id: "verification_2" },
    });
    expect(
      processor.parse({
        payload: {
          type: "BUSINESS_VERIFICATION_STATUS_CHANGED",
          organizationId: muralOrganizationId,
          currentStatus: { type: "approved" },
        },
      })
    ).toEqual({
      kind: "kyc_status",
      organizationId: muralOrganizationId,
      kycStatus: "approved",
    });

    // The compliance-review error state is a provider processing failure, not
    // a compliance decision: it must clear approval without reading as a
    // kyc_rejected decision.
    expect(
      processor.parse({
        payload: {
          type: "compliance_review_status_changed",
          organizationId: muralOrganizationId,
          complianceReviewId: "review_2",
          currentStatus: { type: "error", errorDescription: "review pipeline failed" },
        },
      })
    ).toEqual({
      kind: "kyc_status",
      organizationId: muralOrganizationId,
      kycStatus: "errored",
      source: { kind: "compliance_review", id: "review_2" },
    });

    // Unknown compliance statuses stay ignored, mirroring unknown KYC statuses.
    expect(
      processor.parse({
        payload: {
          type: "compliance_review_status_changed",
          organizationId: muralOrganizationId,
          currentStatus: { type: "weird" },
        },
      }).kind
    ).toBe("ignore");
  });

  it("applies a signed compliance rejection to the cached organization and kyc_wallets", async () => {
    await getDb(env)
      .prepare(
        `INSERT INTO kyc_wallets (
           id, organization_id, project_id, counterparty_id, wallet_address,
           kyc_provider, kyc_status
         ) VALUES (?, ?, ?, ?, ?, 'mural', 'verified')`
      )
      .bind(
        "kyw_mural_compliance_regression",
        organizationId,
        projectId,
        counterpartyId,
        "mural-compliance-regression-wallet"
      )
      .run();

    const rejectionResponse = await sendMuralWebhook({
      payload: {
        type: "compliance_review_status_changed",
        organizationId: muralOrganizationId,
        complianceReviewId: "review_regression_1",
        previousStatus: { type: "inReview" },
        currentStatus: { type: "rejected", rejectionDescription: "KYC rejected" },
        updatedAt: "2026-09-25T00:00:00.000Z",
      },
    });
    expect(rejectionResponse.status).toBe(200);

    // The rejection must overwrite the cached approved state, preserving the
    // organization identity it is keyed on.
    expect(await cachedKycStatus()).toBe("rejected");
    const organization = await getDb(env)
      .prepare(
        `SELECT provider_data->'mural'->'organization'->>'id' AS org_id,
                provider_data->'mural'->'organization'->>'tosStatus' AS tos_status
         FROM counterparties WHERE id = ?`
      )
      .bind(counterpartyId)
      .first<{ org_id: string; tos_status: string }>();
    expect(organization).toEqual({ org_id: muralOrganizationId, tos_status: "ACCEPTED" });

    // The mirror must follow so kyc_rejected rules see the decision.
    const kycWallet = await getDb(env)
      .prepare("SELECT kyc_status FROM kyc_wallets WHERE id = ?")
      .bind("kyw_mural_compliance_regression")
      .first<{ kyc_status: string }>();
    expect(kycWallet).toEqual({ kyc_status: "rejected" });

    // The authenticated row is discharged once the semantic transition applied.
    expect(await inboxCount()).toBe(0);
  });

  it("refuses to settle an account credit for a rejected organization", async () => {
    await seedAwaitingTransfer("xfr_mural_compliance_rejected");

    const rejectionResponse = await sendMuralWebhook({
      payload: {
        type: "compliance_review_status_changed",
        organizationId: muralOrganizationId,
        complianceReviewId: "review_regression_2",
        currentStatus: { type: "rejected", rejectionDescription: "KYC rejected" },
      },
    });
    expect(rejectionResponse.status).toBe(200);

    const creditResponse = await sendMuralWebhook({
      payload: {
        type: "account_credited",
        organizationId: muralOrganizationId,
        accountId,
        tokenAmount: { tokenAmount: 100, tokenSymbol: "USDC" },
      },
    });
    expect(creditResponse.status).toBe(200);

    expect(await transferStatus("xfr_mural_compliance_rejected")).toBe("awaiting_payment");
  });

  it("still settles an account credit while the organization stays approved", async () => {
    await seedAwaitingTransfer("xfr_mural_compliance_approved");

    const creditResponse = await sendMuralWebhook({
      payload: {
        type: "account_credited",
        organizationId: muralOrganizationId,
        accountId,
        tokenAmount: { tokenAmount: 100, tokenSymbol: "USDC" },
      },
    });
    expect(creditResponse.status).toBe(200);

    expect(await transferStatus("xfr_mural_compliance_approved")).toBe("completed");
  });

  it("does not let a replayed pre-decision review undo a recorded rejection", async () => {
    await seedAwaitingTransfer("xfr_mural_compliance_stale");

    const rejectionResponse = await sendMuralWebhook({
      payload: {
        type: "business_verification_status_changed",
        organizationId: muralOrganizationId,
        verificationId: "verification_regression_3",
        currentStatus: { type: "rejected", reason: "KYC rejected" },
      },
    });
    expect(rejectionResponse.status).toBe(200);
    expect(await cachedKycStatus()).toBe("rejected");

    await sendMuralWebhook({
      payload: {
        type: "compliance_review_status_changed",
        organizationId: muralOrganizationId,
        complianceReviewId: "review_regression_4",
        previousStatus: { type: "inReview" },
        currentStatus: { type: "inReview" },
      },
    });

    expect(await cachedKycStatus()).toBe("rejected");
  });

  it("clears a cached approval when a review error arrives and keeps the refused credit replayable", async () => {
    await getDb(env)
      .prepare(
        `INSERT INTO kyc_wallets (
           id, organization_id, project_id, counterparty_id, wallet_address,
           kyc_provider, kyc_status
         ) VALUES (?, ?, ?, ?, ?, 'mural', 'verified')`
      )
      .bind(
        "kyw_mural_compliance_errored",
        organizationId,
        projectId,
        counterpartyId,
        "mural-compliance-errored-wallet"
      )
      .run();
    await seedAwaitingTransfer("xfr_mural_compliance_errored");

    const errorResponse = await sendMuralWebhook({
      payload: {
        type: "compliance_review_status_changed",
        organizationId: muralOrganizationId,
        complianceReviewId: "review_regression_5",
        currentStatus: { type: "error", errorDescription: "review pipeline failed" },
      },
    });
    expect(errorResponse.status).toBe(200);

    // The error must clear the cached approval — quotes and settlement read
    // this cache — and drop the mirror out of `verified`.
    expect(await cachedKycStatus()).toBe("errored");
    const kycWallet = await getDb(env)
      .prepare("SELECT kyc_status FROM kyc_wallets WHERE id = ?")
      .bind("kyw_mural_compliance_errored")
      .first<{ kyc_status: string }>();
    expect(kycWallet).toEqual({ kyc_status: "unverified" });

    const creditResponse = await sendMuralWebhook({
      payload: {
        type: "account_credited",
        organizationId: muralOrganizationId,
        accountId,
        tokenAmount: { tokenAmount: 100, tokenSymbol: "USDC" },
      },
    });
    expect(creditResponse.status).toBe(200);

    // Settlement is barred, and the refusal must NOT discharge the event: the
    // pending inbox row is what replays the credit once the error clears.
    expect(await transferStatus("xfr_mural_compliance_errored")).toBe("awaiting_payment");
    expect(await inboxCount()).toBe(1);
  });

  it("does not let a late approval reverse a recorded rejection", async () => {
    const rejectionResponse = await sendMuralWebhook({
      payload: {
        type: "compliance_review_status_changed",
        organizationId: muralOrganizationId,
        complianceReviewId: "review_regression_6",
        currentStatus: { type: "rejected", rejectionDescription: "KYC rejected" },
      },
    });
    expect(rejectionResponse.status).toBe(200);
    expect(await cachedKycStatus()).toBe("rejected");

    const approvalResponse = await sendMuralWebhook({
      payload: {
        type: "compliance_review_status_changed",
        organizationId: muralOrganizationId,
        complianceReviewId: "review_regression_7",
        currentStatus: { type: "approved" },
      },
    });
    expect(approvalResponse.status).toBe(200);

    // A stale or out-of-order approval must not re-open quote eligibility and
    // settlement after the rejection landed.
    expect(await cachedKycStatus()).toBe("rejected");
  });

  it("honors the compliance gate inside the atomic credit claim", async () => {
    await seedAwaitingTransfer("xfr_mural_claim_approved");
    const approvedTransfer = await transferRow("xfr_mural_claim_approved");
    expect(
      await claimMuralAccountCredit(env, {
        transfer: approvedTransfer,
        counterpartyId,
        deliveryId: "delivery_claim_approved",
        tokenAmount: 100,
      })
    ).toBe("completed");
    expect(await transferStatus("xfr_mural_claim_approved")).toBe("completed");

    // An already-claimed (completed) transfer reports as claimed elsewhere.
    expect(
      await claimMuralAccountCredit(env, {
        transfer: approvedTransfer,
        counterpartyId,
        deliveryId: "delivery_claim_approved",
        tokenAmount: 100,
      })
    ).toBe("already_claimed");

    // A rejection that commits before the claim bars the settlement in the
    // same statement that would move the money.
    await setCachedKycStatus("rejected");
    await seedAwaitingTransfer("xfr_mural_claim_rejected");
    const rejectedTransfer = await transferRow("xfr_mural_claim_rejected");
    expect(
      await claimMuralAccountCredit(env, {
        transfer: rejectedTransfer,
        counterpartyId,
        deliveryId: "delivery_claim_rejected",
        tokenAmount: 100,
      })
    ).toBe("blocked");
    expect(await transferStatus("xfr_mural_claim_rejected")).toBe("awaiting_payment");

    // The blocked classification keys off the transfer's own status — the
    // other guard in the failed statement — never off a compliance re-read
    // that may already have cleared and would discharge the credit event.
    await setCachedKycStatus("errored");
    await seedAwaitingTransfer("xfr_mural_claim_errored");
    const erroredTransfer = await transferRow("xfr_mural_claim_errored");
    expect(
      await claimMuralAccountCredit(env, {
        transfer: erroredTransfer,
        counterpartyId,
        deliveryId: "delivery_claim_errored",
        tokenAmount: 100,
      })
    ).toBe("blocked");
  });

  it("does not let a delayed in-review status clear a review error", async () => {
    await sendMuralWebhook({
      payload: {
        type: "compliance_review_status_changed",
        organizationId: muralOrganizationId,
        complianceReviewId: "review_regression_8",
        currentStatus: { type: "error", errorDescription: "review pipeline failed" },
      },
    });
    expect(await cachedKycStatus()).toBe("errored");

    // A delayed or replayed pre-decision status must not clear the blocking
    // error, or a credit refused during the error would settle on replay
    // without any signed approval.
    await sendMuralWebhook({
      payload: {
        type: "compliance_review_status_changed",
        organizationId: muralOrganizationId,
        complianceReviewId: "review_regression_9",
        previousStatus: { type: "inReview" },
        currentStatus: { type: "inReview" },
      },
    });
    expect(await cachedKycStatus()).toBe("errored");
  });

  it("keeps a compliance-deferred credit pending until compliance clears, then settles it", async () => {
    await seedAwaitingTransfer("xfr_mural_compliance_deferred");
    await sendMuralWebhook({
      payload: {
        type: "compliance_review_status_changed",
        organizationId: muralOrganizationId,
        complianceReviewId: "review_regression_10",
        currentStatus: { type: "error", errorDescription: "review pipeline failed" },
      },
    });
    const creditResponse = await sendMuralWebhook({
      payload: {
        type: "account_credited",
        organizationId: muralOrganizationId,
        accountId,
        tokenAmount: { tokenAmount: 100, tokenSymbol: "USDC" },
      },
    });
    expect(creditResponse.status).toBe(200);
    expect(await inboxCount()).toBe(1);
    const row = await inboxRow();
    expect(row.status).toBe("pending");

    // Every replay pass defers the credit instead of spending an attempt: the
    // row must never park as failed, however long compliance stays blocking —
    // a parked row would strand the customer's credit until an unrelated
    // deploy re-armed it.
    for (let attempt = 1; attempt <= RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS + 1; attempt++) {
      await expect(applyStoredRampWebhookEvent(env, row, attempt)).resolves.toBe(false);
    }
    const parked = await getDb(env)
      .prepare("SELECT status, attempts, last_error FROM ramp_webhook_events WHERE id = ?")
      .bind(row.id)
      .first<{ status: string; attempts: number; last_error: string | null }>();
    expect(parked?.status).toBe("pending");
    expect(Number(parked?.attempts)).toBe(0);
    expect(parked?.last_error).toContain("deferred");

    // Once the error clears (a signed approval supersedes it), the next
    // replay settles the credit and discharges the row.
    await sendMuralWebhook({
      payload: {
        type: "compliance_review_status_changed",
        organizationId: muralOrganizationId,
        complianceReviewId: "review_regression_11",
        currentStatus: { type: "approved" },
      },
    });
    expect(await cachedKycStatus()).toBe("approved");
    await expect(applyStoredRampWebhookEvent(env, row, 1)).resolves.toBe(true);
    expect(await transferStatus("xfr_mural_compliance_deferred")).toBe("completed");
    expect(await inboxCount()).toBe(0);
  });
});
