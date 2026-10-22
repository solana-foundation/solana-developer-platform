import { apiTestSupport } from "@sdp/api/test-support";
import { PAYMENT_RECURRING_PAYMENT_STATUSES } from "@sdp/types/payments";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { type Address, address, generateKeyPairSigner } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  cleanupIntegrationSuite,
  createFundedIntegrationWallet,
  initIntegrationSuite,
  RUN_INTEGRATION_TESTS,
  requestAsOrganizationAdmin,
  requestWithApiKey,
  TEST_ORG,
  TEST_PROJECT,
} from "#/helpers/integration";
import { env } from "#env-impl";

/**
 * HOO-2210 on a local Surfpool fork: a wallet's per-mint delegation to the Subscriptions program
 * outlives cancel (a canceled subscription stays resumable until its period ends), and the
 * revoke-subscription-authorities cron takes it back once every schedule on it has ended,
 * signing with no API key, so revoking the key that set the schedules up never strands it.
 */

const { getDb, readSubscriptionDelegation, revokeIdleSubscriptionAuthorities } = apiTestSupport;

const USDC = address(WELL_KNOWN_TOKENS.USDC.mints.devnet.address);
const PERIOD_HOURS = 1;
/** Past one period plus the cron's one-hour margin. */
const IDLE_BACKDATE_MS = 3 * 60 * 60 * 1000;
const TEST_TIMEOUT_MS = 600_000;

const api = requestWithApiKey();

const recurringPaymentResponseSchema = z.object({
  data: z.object({
    recurringPayment: z.object({
      id: z.string(),
      status: z.enum(PAYMENT_RECURRING_PAYMENT_STATUSES),
    }),
  }),
});
const counterpartyResponseSchema = z.object({
  data: z.object({ counterparty: z.object({ id: z.string() }) }),
});
const counterpartyAccountResponseSchema = z.object({
  data: z.object({ account: z.object({ id: z.string() }) }),
});
const apiKeyResponseSchema = z.object({
  data: z.object({ apiKey: z.object({ id: z.string(), key: z.string() }) }),
});
const surfnetResponseSchema = z.object({
  error: z.object({ message: z.string() }).optional(),
});

/** A Surfpool cheatcode, which no shared RPC client knows. */
async function surfnetCheat(
  method: `surfnet_${string}`,
  params: readonly unknown[]
): Promise<void> {
  const response = await fetch(env.SOLANA_RPC_URL ?? "", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = surfnetResponseSchema.parse(await response.json());
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
}

async function postJson(
  request: ReturnType<typeof requestWithApiKey>,
  path: string,
  body: Record<string, unknown>,
  expectedStatus: number
): Promise<Response> {
  const response = await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 180_000,
  });
  expect(response.status, await response.clone().text()).toBe(expectedStatus);
  return response;
}

async function scheduleCall(
  request: ReturnType<typeof requestWithApiKey>,
  path: string,
  body: Record<string, unknown> = {},
  expectedStatus = 200
) {
  const response = await postJson(request, path, body, expectedStatus);
  return recurringPaymentResponseSchema.parse(await response.json()).data.recurringPayment;
}

describe.skipIf(!RUN_INTEGRATION_TESTS)("recurring payment authority revocation (Surfpool)", () => {
  let walletId: string;
  let walletAddress: Address;
  let authority: Address;
  let counterpartyId: string;
  let counterpartyAccountId: string;

  beforeAll(async () => {
    await initIntegrationSuite();
    const wallet = await createFundedIntegrationWallet({
      label: "Recurring authority revocation",
      fundLamports: 50_000_000,
    });
    walletId = wallet.id;
    walletAddress = address(wallet.publicKey);
    await surfnetCheat("surfnet_setTokenAccount", [walletAddress, USDC, { amount: 1_000_000_000 }]);
    ({ authority } = await readSubscriptionDelegation(walletAddress, USDC));

    const recipient = await generateKeyPairSigner();
    const counterparty = await postJson(
      api,
      "/v1/counterparties",
      { entityType: "individual", displayName: "Authority revocation" },
      201
    );
    counterpartyId = counterpartyResponseSchema.parse(await counterparty.json()).data.counterparty
      .id;
    const account = await postJson(
      api,
      `/v1/counterparties/${counterpartyId}/accounts`,
      {
        accountKind: "crypto_wallet",
        label: "Authority revocation recipient",
        details: { network: "solana", address: recipient.address },
      },
      201
    );
    counterpartyAccountId = counterpartyAccountResponseSchema.parse(await account.json()).data
      .account.id;
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await cleanupIntegrationSuite();
  });

  async function createSchedule(request: ReturnType<typeof requestWithApiKey>): Promise<string> {
    const created = await scheduleCall(
      request,
      "/v1/payments/recurring-payments",
      {
        sourceCustodyWalletId: walletId,
        counterpartyId,
        counterpartyAccountId,
        token: USDC,
        amount: "1",
        periodHours: PERIOD_HOURS,
      },
      201
    );
    return created.id;
  }

  async function activeSchedule(request: ReturnType<typeof requestWithApiKey>): Promise<string> {
    const id = await createSchedule(request);
    const activated = await scheduleCall(request, `/v1/payments/recurring-payments/${id}/activate`);
    expect(activated.status).toBe("active");
    return id;
  }

  /** Moves the schedules' and their subscriptions' last change past their period, as time would. */
  async function letPeriodsEnd(ids: string[]): Promise<void> {
    const longAgo = new Date(Date.now() - IDLE_BACKDATE_MS).toISOString();
    await getDb(env).execute(
      "UPDATE payment_recurring_payments SET updated_at = ? WHERE id = ANY(?::text[])",
      [longAgo, ids]
    );
    await getDb(env).execute(
      `UPDATE payment_subscriptions s
          SET updated_at = ?, canceled_at = CASE WHEN s.canceled_at IS NULL THEN NULL ELSE ? END
         FROM payment_recurring_payments rp
        WHERE rp.id = ANY(?::text[]) AND s.id = rp.subscription_id`,
      [longAgo, longAgo, ids]
    );
  }

  it("revokes the delegation only once every schedule on it has ended, without the key that set them up", {
    timeout: TEST_TIMEOUT_MS,
  }, async () => {
    const keyManager = await requestAsOrganizationAdmin();
    const keyName = `HOO-2210 schedules ${Date.now()}`;
    const created = await postJson(
      keyManager,
      `/v1/projects/${TEST_PROJECT.id}/api-keys`,
      {
        name: keyName,
        grants: ["recurring.read", "recurring.manage", "recurring.execute", "counterparties.read"],
        walletScope: "all",
      },
      201
    );
    const key = apiKeyResponseSchema.parse(await created.json()).data.apiKey;
    const scheduler = requestWithApiKey(key.key);

    const first = await activeSchedule(scheduler);
    const second = await activeSchedule(scheduler);
    expect(await readSubscriptionDelegation(walletAddress, USDC)).toEqual({
      authority,
      authorityOpen: true,
      delegate: authority,
    });

    // One schedule ends; the other still collects through the same delegation.
    await scheduleCall(scheduler, `/v1/payments/recurring-payments/${first}/cancel`);
    await letPeriodsEnd([first]);
    expect(await revokeIdleSubscriptionAuthorities(env, new Date())).toMatchObject({ revoked: 0 });
    expect((await readSubscriptionDelegation(walletAddress, USDC)).delegate).toBe(authority);

    // Both canceled, but the second is inside its period: it can still be resumed.
    await scheduleCall(scheduler, `/v1/payments/recurring-payments/${second}/cancel`);
    expect(await revokeIdleSubscriptionAuthorities(env, new Date())).toMatchObject({ revoked: 0 });
    const resumed = await scheduleCall(
      scheduler,
      `/v1/payments/recurring-payments/${second}/resume`
    );
    expect(resumed.status).toBe("active");
    await scheduleCall(scheduler, `/v1/payments/recurring-payments/${second}/cancel`);

    // The key that created, activated and resumed both is revoked before the cleanup runs.
    const revokeKey = await keyManager(`/v1/api-keys/${key.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: keyName }),
    });
    expect(revokeKey.status).toBe(200);

    await letPeriodsEnd([first, second]);
    expect(await revokeIdleSubscriptionAuthorities(env, new Date())).toMatchObject({
      revoked: 1,
      failed: 0,
    });
    expect(await readSubscriptionDelegation(walletAddress, USDC)).toEqual({
      authority,
      authorityOpen: false,
      delegate: null,
    });
    const [revocation] = await getDb(env).queryMany<{ status: string; signature: string | null }>(
      `SELECT status, signature FROM payment_subscription_authority_revocations
        WHERE organization_id = ? AND subscription_authority_address = ?`,
      [TEST_ORG.id, authority]
    );
    expect(revocation).toMatchObject({ status: "confirmed", signature: expect.any(String) });

    // Nothing left to do: the next run neither revokes nor retries.
    expect(await revokeIdleSubscriptionAuthorities(env, new Date())).toEqual({
      revoked: 0,
      recovered: 0,
      failed: 0,
      skipped: 0,
    });

    // A new schedule on the same wallet and mint sets the delegation up again.
    const third = await activeSchedule(api);
    expect((await readSubscriptionDelegation(walletAddress, USDC)).delegate).toBe(authority);
    await scheduleCall(api, `/v1/payments/recurring-payments/${third}/cancel`);
  });

  it("refuses to activate on a wallet whose delegation is being revoked", {
    timeout: TEST_TIMEOUT_MS,
  }, async () => {
    const pending = await createSchedule(api);
    const now = new Date().toISOString();
    await getDb(env).execute(
      `INSERT INTO payment_subscription_authority_revocations (
         id, organization_id, project_id, environment, custody_wallet_id, wallet_address,
         token_mint, subscription_authority_address, status, lease_id, created_at, updated_at)
       VALUES ('psar_in_flight_test', ?, ?, 'sandbox', ?, ?, ?, ?, 'processing', 'lease_test', ?, ?)`,
      [TEST_ORG.id, TEST_PROJECT.id, walletId, walletAddress, USDC, authority, now, now]
    );
    try {
      await postJson(api, `/v1/payments/recurring-payments/${pending}/activate`, {}, 409);
      const [row] = await getDb(env).queryMany<{ status: string }>(
        "SELECT status FROM payment_recurring_payments WHERE id = ?",
        [pending]
      );
      expect(row?.status).toBe("pending_activation");
    } finally {
      await getDb(env).execute(
        "DELETE FROM payment_subscription_authority_revocations WHERE id = 'psar_in_flight_test'"
      );
    }
    await scheduleCall(api, `/v1/payments/recurring-payments/${pending}/cancel`);
  });
});
