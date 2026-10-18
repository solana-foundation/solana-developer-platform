import { RETIRED_RAMP_PROVIDERS } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { env } from "@/test/helpers/env";
import {
  installPaymentsRouteTestHooks,
  seedCounterparty,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import { required } from "@/test/helpers/required";

const UNKNOWN_PROVIDER = "not-a-ramp-provider";

const authorization = { Authorization: `Bearer ${TEST_API_KEY.raw}` };

async function seedRampTransfer(input: {
  id: string;
  provider: string;
  type: "onramp" | "offramp";
  status: string;
  deliveryMode?: string;
  providerData?: Record<string, unknown>;
}): Promise<void> {
  const now = new Date().toISOString();
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers (
         id, organization_id, project_id, wallet_id, custody_wallet_id, token, amount, type,
         direction, status, provider, provider_reference, delivery_mode, provider_data,
         fiat_currency, fiat_amount, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)`
    )
    .bind(
      input.id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      TEST_WALLET_ID,
      TEST_CUSTODY_WALLET_ID,
      "USDC",
      "10",
      input.type,
      input.type === "onramp" ? "inbound" : "outbound",
      input.status,
      input.provider,
      `${input.provider}_reference`,
      input.deliveryMode ?? null,
      input.providerData ?? {},
      "USD",
      "10.00",
      now,
      now
    )
    .run();
}

async function seedProviderAccount(input: {
  id: string;
  counterpartyId: string;
  provider: string;
  kind: "customer_link" | "payout_account";
}): Promise<void> {
  const payout = input.kind === "payout_account";
  await getDb(env)
    .prepare(
      `INSERT INTO counterparty_provider_accounts (
         id, organization_id, project_id, counterparty_id, provider,
         provider_customer_reference, kind, external_account_reference, fiat_currency,
         destination_country, payment_rail, provider_status, status, metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '{}'::jsonb)`
    )
    .bind(
      input.id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      input.counterpartyId,
      input.provider,
      `${input.provider}_customer`,
      input.kind,
      payout ? `${input.provider}_external_account` : null,
      payout ? "USD" : null,
      payout ? "US" : null,
      payout ? "ACH" : null,
      "ACTIVE"
    )
    .run();
}

async function readTransferStatus(id: string): Promise<string> {
  const row = await getDb(env)
    .prepare("SELECT status FROM payment_transfers WHERE id = ?")
    .bind(id)
    .first<{ status: string }>();
  return required(row).status;
}

/**
 * A removed ramp provider's id moves to RETIRED_RAMP_PROVIDERS. Its stored rows
 * keep reading through the API as stored, and anything that would act on them
 * answers 503 PROVIDER_NOT_CONFIGURED instead of dispatching to a client that is
 * gone. Every retired id gets these fixtures.
 */
describe.each(RETIRED_RAMP_PROVIDERS)("retired ramp provider %s", (provider) => {
  installPaymentsRouteTestHooks();

  it("lists and reads its transfers as stored", async () => {
    const id = `xfr_retired_read_${provider}`;
    await seedRampTransfer({ id, provider, type: "offramp", status: "completed" });

    const listed = await app.request(
      "/v1/payments/transfers?category=ramp",
      { headers: authorization },
      env
    );
    expect(listed.status).toBe(200);
    const list = (await listed.json()) as { data: Array<Record<string, unknown>> };
    expect(list.data).toContainEqual(
      expect.objectContaining({ id, provider, providerReference: `${provider}_reference` })
    );

    const read = await app.request(`/v1/payments/transfers/${id}`, { headers: authorization }, env);
    expect(read.status).toBe(200);
    const body = (await read.json()) as { data: { transfer: Record<string, unknown> } };
    expect(body.data.transfer).toMatchObject({
      id,
      provider,
      status: "completed",
      providerReference: `${provider}_reference`,
      fiatCurrency: "USD",
      fiatAmount: "10.00",
    });
  });

  it("reads its transfer without a settlement its code no longer describes", async () => {
    const id = `xfr_retired_settlement_${provider}`;
    await seedRampTransfer({
      id,
      provider,
      type: "onramp",
      status: "completed",
      providerData: { settlement: { provider, receivedAmount: "10" } },
    });

    const read = await app.request(`/v1/payments/transfers/${id}`, { headers: authorization }, env);

    expect(read.status).toBe(200);
    const body: unknown = await read.json();
    expect(body).toMatchObject({ data: { transfer: { id, provider, status: "completed" } } });
    expect(body).not.toHaveProperty("data.transfer.settlement");
  });

  it("answers 503 to a cancel instead of acting on its transfer", async () => {
    const id = `xfr_retired_cancel_${provider}`;
    await seedRampTransfer({ id, provider, type: "offramp", status: "awaiting_payment" });

    const res = await app.request(
      "/v1/payments/ramps/transfers/cancel",
      {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ transferId: id }),
      },
      env
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect(await readTransferStatus(id)).toBe("awaiting_payment");
  });

  it("answers 503 to a sandbox simulation instead of acting on its transfer", async () => {
    const id = `xfr_retired_simulate_${provider}`;
    await seedRampTransfer({ id, provider, type: "onramp", status: "awaiting_payment" });

    const res = await app.request(
      "/v1/payments/ramps/sandbox/simulate",
      {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ transferId: id }),
      },
      env
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect(await readTransferStatus(id)).toBe("awaiting_payment");
  });

  it("refuses a quote that names it at validation", async () => {
    const res = await app.request(
      "/v1/payments/ramps/onramp/quote",
      {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          counterpartyId: "cpty_retired_quote",
          destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          assetRail: "usdc.solana",
          fiatCurrency: "USD",
          fiatAmount: "10",
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("provider");
  });

  it("refuses a webhook that names it as an unsupported provider", async () => {
    const res = await app.request(
      `/webhooks/payments/ramps/sandbox/${provider}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      env
    );

    expect(res.status).toBe(400);
  });

  it("lists its provider accounts as stored, without enrichment", async () => {
    const counterpartyId = await seedCounterparty();
    await seedProviderAccount({
      id: `cpa_retired_link_${provider}`,
      counterpartyId,
      provider,
      kind: "customer_link",
    });
    await seedProviderAccount({
      id: `cpa_retired_payout_${provider}`,
      counterpartyId,
      provider,
      kind: "payout_account",
    });

    const res = await app.request(
      `/v1/counterparties/${counterpartyId}/provider-accounts`,
      { headers: authorization },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { accounts: Array<Record<string, unknown>> } };
    expect(body.data.accounts).toEqual([
      expect.objectContaining({
        id: `cpa_retired_payout_${provider}`,
        provider,
        kind: "payout_account",
        fiatCurrency: "USD",
        providerStatus: "ACTIVE",
        customerLink: expect.objectContaining({
          id: `cpa_retired_link_${provider}`,
          provider,
          providerCustomerReference: `${provider}_customer`,
        }),
      }),
    ]);
    expect(body.data.accounts[0]).not.toHaveProperty("paymentRails");
  });
});

describe("a retired provider's stored provider data", () => {
  installPaymentsRouteTestHooks();

  it("reads a MoneyGram widget transfer with base fields only", async () => {
    const id = "xfr_retired_moneygram_widget";
    await seedRampTransfer({
      id,
      provider: "moneygram",
      type: "offramp",
      status: "completed",
      deliveryMode: "session_widget",
      providerData: {
        moneygram: { transactionId: "mg_tx_stored", referenceNumber: "12345678" },
      },
    });

    const read = await app.request(`/v1/payments/transfers/${id}`, { headers: authorization }, env);

    expect(read.status).toBe(200);
    const body = (await read.json()) as { data: { transfer: Record<string, unknown> } };
    expect(body.data.transfer).toMatchObject({
      id,
      provider: "moneygram",
      status: "completed",
      deliveryMode: "session_widget",
      providerReference: "moneygram_reference",
    });
    expect(body.data.transfer).not.toHaveProperty("moneygram");
  });
});

describe("a stored ramp provider id this deployment does not know", () => {
  installPaymentsRouteTestHooks();

  it("fails the transfer read explicitly instead of casting it", async () => {
    const id = "xfr_unknown_provider";
    await seedRampTransfer({
      id,
      provider: UNKNOWN_PROVIDER,
      type: "offramp",
      status: "completed",
    });

    const res = await app.request(`/v1/payments/transfers/${id}`, { headers: authorization }, env);

    expect(res.status).toBe(500);
  });

  it("fails the provider-account read explicitly instead of casting it", async () => {
    const counterpartyId = await seedCounterparty();
    await seedProviderAccount({
      id: "cpa_unknown_provider",
      counterpartyId,
      provider: UNKNOWN_PROVIDER,
      kind: "customer_link",
    });

    const res = await app.request(
      `/v1/counterparties/${counterpartyId}/provider-accounts`,
      { headers: authorization },
      env
    );

    expect(res.status).toBe(500);
  });
});
