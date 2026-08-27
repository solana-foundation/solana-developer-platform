import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { reconcileRampTransfers } from "@/services/jobs/reconcile-ramp-transfers";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const ORG_ID = "org_ramp_reconcile_test";
const PROJECT_ID = "prj_ramp_reconcile_test";
const USER_ID = "usr_ramp_reconcile_test";
const COUNTERPARTY_ID = "cpty_ramp_reconcile_test";
const MOONPAY_CUSTOMER_ID = "7d1f7b3a-40e2-4b0a-9a51-2f1f8f9f0a11";
const STALE_TIMESTAMP = "2026-06-18T00:00:00.000Z";

describe("reconcileRampTransfers", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    env.MOONPAY_SANDBOX_API_KEY = "pk_test_reconcile";
    env.MOONPAY_SANDBOX_SECRET_KEY = "sk_test_reconcile";
    await seedScope();
  });

  afterEach(() => {
    env.MOONPAY_SANDBOX_API_KEY = undefined;
    env.MOONPAY_SANDBOX_SECRET_KEY = undefined;
    vi.unstubAllGlobals();
  });

  async function seedScope() {
    await getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG_ID, "Ramp Reconcile Org", "ramp-reconcile-org", "enterprise", "active")
      .run();
    await getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER_ID, "ramp-reconcile@example.com", 1, "active")
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(PROJECT_ID, ORG_ID, "Test", "ramp-reconcile-proj", "sandbox", "active", USER_ID)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO counterparties (
           id, organization_id, project_id, entity_type, display_name, status, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        COUNTERPARTY_ID,
        ORG_ID,
        PROJECT_ID,
        "individual",
        "Reconciled Buyer",
        "active",
        USER_ID
      )
      .run();
  }

  async function seedTransfer(input: { id: string; reference: string; status: string }) {
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id, organization_id, project_id, wallet_id, counterparty_id, source_address,
           destination_address, token, amount, memo, type, direction, status, provider,
           provider_reference, delivery_mode, fiat_currency, fiat_amount, provider_data,
           signature, serialized_tx, initiated_by_key_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.id,
        ORG_ID,
        PROJECT_ID,
        "wallet_ramp_reconcile",
        COUNTERPARTY_ID,
        null,
        "DestinationSolanaWallet111111111111111111111111",
        "SOL",
        null,
        null,
        "onramp",
        "inbound",
        input.status,
        "moonpay",
        input.reference,
        null,
        "USD",
        "47.73",
        {},
        null,
        null,
        null,
        STALE_TIMESTAMP,
        STALE_TIMESTAMP
      )
      .run();
  }

  function stubMoonpayTransactions(transactions: unknown[]) {
    const providerFetch = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toContain("api.moonpay.com/v1/transactions");
      return new Response(JSON.stringify(transactions), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", providerFetch);
    return providerFetch;
  }

  it("settles a stale transfer from the provider's view and links the customer", async () => {
    await seedTransfer({
      id: "pt_reconcile_settled",
      reference: "ramp_quote_reconcile_settled",
      status: "awaiting_payment",
    });
    const providerFetch = stubMoonpayTransactions([
      {
        id: "9a71b6ff-6a3f-45f2-9a56-1e7c9a30a2bc",
        status: "completed",
        customerId: MOONPAY_CUSTOMER_ID,
        externalTransactionId: "ramp_quote_reconcile_settled",
        failureReason: null,
        createdAt: "2026-06-18T00:01:00.000Z",
        baseCurrencyAmount: 47.73,
        quoteCurrencyAmount: 0.649,
        feeAmount: 2,
        extraFeeAmount: 0,
        networkFeeAmount: 0.27,
        areFeesIncluded: true,
        usdRate: 1,
        cryptoTransactionId: "t11paHKpm79qTHVgSQ4rr9PAqE7ZT87MWpi1f5Nim8XzPyc7aPux",
        baseCurrency: { code: "usd" },
        currency: { code: "sol" },
      },
    ]);

    await reconcileRampTransfers(env);

    expect(providerFetch).toHaveBeenCalledTimes(1);
    const transfer = await getDb(env)
      .prepare("SELECT status, amount, provider_data FROM payment_transfers WHERE id = ?")
      .bind("pt_reconcile_settled")
      .first<{
        status: string;
        amount: string | null;
        provider_data: { settlement?: Record<string, unknown> };
      }>();
    expect(transfer?.status).toBe("completed");
    expect(transfer?.amount).toBe("0.649");
    expect(transfer?.provider_data.settlement).toMatchObject({
      provider: "moonpay",
      status: "completed",
      cryptoTransactionId: "t11paHKpm79qTHVgSQ4rr9PAqE7ZT87MWpi1f5Nim8XzPyc7aPux",
    });

    const link = await getDb(env)
      .prepare(
        `SELECT provider_customer_reference FROM counterparty_provider_accounts
         WHERE counterparty_id = ? AND provider = 'moonpay'`
      )
      .bind(COUNTERPARTY_ID)
      .first<{ provider_customer_reference: string }>();
    expect(link?.provider_customer_reference).toBe(MOONPAY_CUSTOMER_ID);
  });

  it("expires an abandoned pending transfer the provider never saw", async () => {
    await seedTransfer({
      id: "pt_reconcile_abandoned",
      reference: "ramp_quote_reconcile_abandoned",
      status: "pending",
    });
    stubMoonpayTransactions([]);

    await reconcileRampTransfers(env);

    const transfer = await getDb(env)
      .prepare("SELECT status, error FROM payment_transfers WHERE id = ?")
      .bind("pt_reconcile_abandoned")
      .first<{ status: string; error: string | null }>();
    expect(transfer?.status).toBe("expired");
    expect(transfer?.error).toBe("Checkout was never completed with the provider.");
  });

  it("leaves an in-progress transfer alone when the provider still reports it settling", async () => {
    await seedTransfer({
      id: "pt_reconcile_settling",
      reference: "ramp_quote_reconcile_settling",
      status: "awaiting_payment",
    });
    stubMoonpayTransactions([
      {
        id: "3f0dbf3a-2f57-4f19-93b3-2f6f0e6f1d20",
        status: "pending",
        customerId: MOONPAY_CUSTOMER_ID,
        externalTransactionId: "ramp_quote_reconcile_settling",
        failureReason: null,
        createdAt: "2026-06-18T00:01:00.000Z",
      },
    ]);

    await reconcileRampTransfers(env);

    const transfer = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind("pt_reconcile_settling")
      .first<{ status: string }>();
    expect(transfer?.status).toBe("settling");
  });
});
