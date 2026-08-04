import { createSign, generateKeyPairSync } from "node:crypto";
import type { RampWebhookValidationContext } from "@sdp/payments/ramps/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { MuralWebhookProcessor } from "./mural";
import type { AppContext } from "./processor";

function context(input: {
  headers?: Record<string, string>;
  rawBody?: string;
  env?: Record<string, string | undefined>;
}): RampWebhookValidationContext {
  return {
    env: input.env === undefined ? {} : input.env,
    environment: "sandbox",
    headers: new Headers(input.headers === undefined ? {} : input.headers),
    rawBody: input.rawBody === undefined ? "{}" : input.rawBody,
  };
}

describe("MuralWebhookProcessor.verify", () => {
  const env = { MURAL_PAY_SANDBOX_WEBHOOK_PUBLIC_KEY: "unused-for-header-checks" };

  it("rejects a missing signature header", async () => {
    const processor = new MuralWebhookProcessor();

    await expect(
      processor.verify(
        context({ env, headers: { "x-mural-webhook-timestamp": new Date().toISOString() } })
      )
    ).rejects.toThrow(AppError);
  });

  it("rejects a missing timestamp header", async () => {
    const processor = new MuralWebhookProcessor();

    await expect(
      processor.verify(context({ env, headers: { "x-mural-webhook-signature": "abc" } }))
    ).rejects.toThrow(AppError);
  });

  it("accepts a valid ECDSA signature over timestamp-dot-body and rejects tampering", async () => {
    const processor = new MuralWebhookProcessor();
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const rawBody = JSON.stringify({
      payload: { type: "tos_accepted", organizationId: "org_9" },
    });
    const timestamp = new Date().toISOString();
    const signature = createSign("SHA256")
      .update(`${timestamp}.${rawBody}`)
      .sign(privateKey)
      .toString("base64");
    const signedEnv = { MURAL_PAY_SANDBOX_WEBHOOK_PUBLIC_KEY: publicKey };
    const headers = {
      "x-mural-webhook-signature": signature,
      "x-mural-webhook-timestamp": timestamp,
    };

    const result = await processor.verify(context({ env: signedEnv, rawBody, headers }));
    expect(result).toMatchObject({
      payload: { type: "tos_accepted", organizationId: "org_9" },
      __sdpDeliveryId: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    await expect(
      processor.verify(context({ env: signedEnv, rawBody: `${rawBody} `, headers }))
    ).rejects.toThrow(AppError);
  });
});

describe("MuralWebhookProcessor.parse", () => {
  it("delegates Mural event parsing", () => {
    const processor = new MuralWebhookProcessor();

    expect(
      processor.parse({
        payload: { type: "tos_accepted", organizationId: "org_9" },
      })
    ).toEqual({ kind: "tos_accepted", organizationId: "org_9" });
  });
});

describe("MuralWebhookProcessor.process", () => {
  const organizationId = "org_mural_webhook_test";
  const projectId = "prj_mural_webhook_test";
  const userId = "usr_mural_webhook_test";
  const counterpartyId = "cp_mural_webhook_test";
  const muralOrganizationId = "mural_org_webhook_test";
  const accountId = "mural_account_webhook_test";
  const processor = new MuralWebhookProcessor();
  const appContext = { env } as unknown as AppContext;

  async function seedTransfer(id: string): Promise<void> {
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
        "wallet_mural_webhook_test",
        counterpartyId,
        null,
        "destination",
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

  async function transferStatus(id: string): Promise<string | undefined> {
    const row = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    return row?.status;
  }

  beforeEach(async () => {
    await seedTestDatabase(env);
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(organizationId, "Mural Webhook Test", "mural-webhook-test", "enterprise", "active"),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
        .bind(userId, "mural-webhook@example.com", 1, "active"),
      getDb(env)
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          projectId,
          organizationId,
          "Mural Webhook Project",
          "mural-webhook-project",
          "sandbox",
          "active",
          userId
        ),
      getDb(env)
        .prepare(
          `INSERT INTO counterparties (
             id, organization_id, project_id, entity_type, display_name, email,
             identity, status, created_by, mural_organization_id, provider_data
           ) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?::jsonb)`
        )
        .bind(
          counterpartyId,
          organizationId,
          projectId,
          "business",
          "Mural Buyer",
          "mural-buyer@example.com",
          { businessName: "Mural Buyer" },
          "active",
          userId,
          muralOrganizationId,
          {}
        ),
    ]);
  });

  afterEach(async () => {
    await clearTestDatabase(env);
  });

  it("consumes a signed account-credit delivery once", async () => {
    await seedTransfer("xfr_mural_first");

    await processor.process(appContext, "sandbox", {
      kind: "account_credited",
      organizationId: muralOrganizationId,
      accountId,
      tokenAmount: 99,
      deliveryId: "delivery_mural_once",
    });
    await seedTransfer("xfr_mural_second");
    await processor.process(appContext, "sandbox", {
      kind: "account_credited",
      organizationId: muralOrganizationId,
      accountId,
      tokenAmount: 99,
      deliveryId: "delivery_mural_once",
    });

    expect(await transferStatus("xfr_mural_first")).toBe("completed");
    expect(await transferStatus("xfr_mural_second")).toBe("awaiting_payment");
  });

  it("refuses to guess between ambiguous live quotes", async () => {
    await seedTransfer("xfr_mural_ambiguous_a");
    await seedTransfer("xfr_mural_ambiguous_b");

    await processor.process(appContext, "sandbox", {
      kind: "account_credited",
      organizationId: muralOrganizationId,
      accountId,
      tokenAmount: 99,
      deliveryId: "delivery_mural_ambiguous",
    });

    expect(await transferStatus("xfr_mural_ambiguous_a")).toBe("awaiting_payment");
    expect(await transferStatus("xfr_mural_ambiguous_b")).toBe("awaiting_payment");
  });

  it("finds an exact account match beyond one hundred newer candidates", async () => {
    await seedTransfer("xfr_mural_complete_set_match");
    await getDb(env)
      .prepare(
        `UPDATE payment_transfers
         SET created_at = '2026-08-03T00:00:00.000Z'
         WHERE id = 'xfr_mural_complete_set_match'`
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id, organization_id, project_id, wallet_id, counterparty_id,
           destination_address, token, type, direction, status, provider,
           provider_reference, delivery_mode, fiat_currency, fiat_amount,
           provider_data, created_at, updated_at
         )
         SELECT
           'xfr_mural_decoy_' || candidate,
           ?, ?, ?, ?, 'destination', 'USDC', 'onramp', 'inbound',
           'awaiting_payment', 'mural', 'quote_mural_decoy_' || candidate,
           'manual_instructions', 'USD', '100',
           jsonb_build_object('mural', jsonb_build_object('accountId', 'decoy_' || candidate)),
           '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'
         FROM generate_series(1, 100) AS candidate`
      )
      .bind(organizationId, projectId, "wallet_mural_webhook_test", counterpartyId)
      .run();

    await processor.process(appContext, "sandbox", {
      kind: "account_credited",
      organizationId: muralOrganizationId,
      accountId,
      tokenAmount: 99,
      deliveryId: "delivery_mural_complete_set_match",
    });

    expect(await transferStatus("xfr_mural_complete_set_match")).toBe("completed");
  });

  it("refuses an organization reference associated with multiple tenants", async () => {
    await getDb(env)
      .prepare(
        `INSERT INTO counterparties (
           id, organization_id, project_id, entity_type, display_name, email,
           identity, status, created_by, provider_data
         ) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?::jsonb)`
      )
      .bind(
        "cp_mural_ambiguous_tenant",
        organizationId,
        projectId,
        "business",
        "Other Mural Buyer",
        "other-mural-buyer@example.com",
        { businessName: "Other Mural Buyer" },
        "active",
        userId,
        { mural: { organization: { id: muralOrganizationId } } }
      )
      .run();
    await seedTransfer("xfr_mural_ambiguous_tenant");

    await processor.process(appContext, "sandbox", {
      kind: "account_credited",
      organizationId: muralOrganizationId,
      accountId,
      tokenAmount: 99,
      deliveryId: "delivery_mural_ambiguous_tenant",
    });

    expect(await transferStatus("xfr_mural_ambiguous_tenant")).toBe("awaiting_payment");
  });
});
