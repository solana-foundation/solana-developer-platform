import { describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  DEVNET_USDC_MINT,
  installPaymentsRouteTestHooks,
  seedCounterparty,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
} from "@/test/helpers/payments-routes";
import {
  installRecurringExecutionHooks,
  parseRecurringResponse,
  RECURRING_HEADERS,
} from "@/test/helpers/recurring-payments";

/**
 * Regression tests for SOLA9-147 (APE-713): recurring-payment creation was
 * replayable — a lost response or client retry sent the same authenticated
 * create twice and both attempts landed, producing two `pending_activation`
 * rows that each activate into their own plan/subscription and duplicate the
 * future debits. Creation must be replay-safe under an `Idempotency-Key`:
 * an identical retry returns the original row, key reuse with a different
 * payload conflicts, and callers that want a second schedule simply use a
 * different (or no) key.
 */
describe("Payments routes — recurring payment create idempotency", () => {
  installPaymentsRouteTestHooks();
  installRecurringExecutionHooks();

  const createBody = async () => {
    const counterpartyId = await seedCounterparty({
      externalId: `recurring_idempotency_${crypto.randomUUID()}`,
    });
    const counterpartyAccountId = `cpa_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO counterparty_accounts (
           id, organization_id, project_id, counterparty_id, account_kind, label,
           details, provider_account_data, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'crypto_wallet', 'Recurring idempotency wallet', ?, '{}', 'active', ?, ?)`
      )
      .bind(
        counterpartyAccountId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        counterpartyId,
        JSON.stringify({ network: "solana", address: TEST_SOLANA_ADDRESSES.wallet2 }),
        now,
        now
      )
      .run();
    return {
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      counterpartyId,
      counterpartyAccountId,
      token: DEVNET_USDC_MINT,
      amount: "25.00",
      periodHours: 24,
    };
  };

  const postCreate = (body: object, idempotencyKey?: string) =>
    app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers: {
          ...RECURRING_HEADERS,
          ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
        },
        body: JSON.stringify(body),
      },
      env
    );

  const countRows = async () => {
    const row = await getDb(env)
      .prepare(
        `SELECT COUNT(*) AS count FROM payment_recurring_payments
         WHERE organization_id = ? AND project_id = ?`
      )
      .bind(TEST_ORG.id, TEST_PROJECT.id)
      .first<{ count: number }>();
    return Number(row?.count ?? 0);
  };

  it("replays a recurring payment when the same Idempotency-Key + body is retried", async () => {
    const body = await createBody();

    const firstResponse = await postCreate(body, "recurring-key-1");
    expect(firstResponse.status).toBe(201);
    const first = (await parseRecurringResponse(firstResponse)).data.recurringPayment;
    expect(first.id).toMatch(/^prp_/);

    const secondResponse = await postCreate(body, "recurring-key-1");
    expect(secondResponse.status).toBe(200);
    const second = (await parseRecurringResponse(secondResponse)).data.recurringPayment;
    expect(second.id).toBe(first.id);

    expect(await countRows()).toBe(1);

    const stored = await getDb(env)
      .prepare(
        `SELECT idempotency_key, idempotency_fingerprint FROM payment_recurring_payments WHERE id = ?`
      )
      .bind(first.id)
      .first<{ idempotency_key: string | null; idempotency_fingerprint: string | null }>();
    expect(stored?.idempotency_key).toBe("recurring-key-1");
    if (!stored?.idempotency_fingerprint) throw new Error("missing idempotency fingerprint");
    expect(JSON.parse(stored.idempotency_fingerprint)).toHaveProperty(
      "counterpartyAccountId",
      body.counterpartyAccountId
    );
  });

  it("rejects the same Idempotency-Key with a different body", async () => {
    const body = await createBody();

    const firstResponse = await postCreate(body, "recurring-key-2");
    expect(firstResponse.status).toBe(201);

    const conflictResponse = await postCreate({ ...body, amount: "50.00" }, "recurring-key-2");
    expect(conflictResponse.status).toBe(409);

    expect(await countRows()).toBe(1);
  });

  it("does not dedup when no Idempotency-Key is supplied", async () => {
    const body = await createBody();

    const firstResponse = await postCreate(body);
    expect(firstResponse.status).toBe(201);
    const secondResponse = await postCreate(body);
    expect(secondResponse.status).toBe(201);

    const first = (await parseRecurringResponse(firstResponse)).data.recurringPayment;
    const second = (await parseRecurringResponse(secondResponse)).data.recurringPayment;
    expect(second.id).not.toBe(first.id);
    expect(await countRows()).toBe(2);
  });
});
