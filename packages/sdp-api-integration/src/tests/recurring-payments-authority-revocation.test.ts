import { apiTestSupport } from "@sdp/api/test-support";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { type Address, address, generateKeyPairSigner } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const {
  findAssociatedTokenPda,
  findSubscriptionAuthorityPda,
  getDb,
  revokeIdleSubscriptionAuthorities,
  TOKEN_PROGRAM_ADDRESS,
} = apiTestSupport;

const USDC = address(WELL_KNOWN_TOKENS.USDC.mints.devnet.address);
const PERIOD_HOURS = 1;
/** Past one period plus the cron's one-hour margin. */
const IDLE_BACKDATE_MS = 3 * 60 * 60 * 1000;
const TEST_TIMEOUT_MS = 600_000;

const api = requestWithApiKey();

interface RecurringPaymentBody {
  data: { recurringPayment: { id: string; status: string } };
}

async function cheat(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(env.SOLANA_RPC_URL ?? "", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
  return body.result;
}

async function accountInfo(account: Address): Promise<{
  data: { parsed?: { info?: { delegate?: string } } };
} | null> {
  const result = (await cheat("getAccountInfo", [
    account,
    { encoding: "jsonParsed", commitment: "confirmed" },
  ])) as { value: { data: { parsed?: { info?: { delegate?: string } } } } | null };
  return result.value;
}

async function tokenAccountDelegate(tokenAccount: Address): Promise<string | null> {
  return (await accountInfo(tokenAccount))?.data.parsed?.info?.delegate ?? null;
}

async function call(
  request: ReturnType<typeof requestWithApiKey>,
  path: string,
  body: unknown = {},
  expectedStatus = 200
): Promise<RecurringPaymentBody> {
  const response = await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 180_000,
  });
  const payload = (await response.json()) as RecurringPaymentBody & { error?: unknown };
  expect(response.status, JSON.stringify(payload.error ?? payload)).toBe(expectedStatus);
  return payload;
}

describe.skipIf(!RUN_INTEGRATION_TESTS)("recurring payment authority revocation (Surfpool)", () => {
  let walletId: string;
  let walletAddress: Address;
  let tokenAccount: Address;
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
    await cheat("surfnet_setTokenAccount", [walletAddress, USDC, { amount: 1_000_000_000 }]);
    [tokenAccount] = await findAssociatedTokenPda({
      owner: walletAddress,
      mint: USDC,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    [authority] = await findSubscriptionAuthorityPda({ user: walletAddress, tokenMint: USDC });

    const recipient = await generateKeyPairSigner();
    const counterpartyResponse = await api("/v1/counterparties", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityType: "individual", displayName: "Authority revocation" }),
    });
    expect(counterpartyResponse.status).toBe(201);
    counterpartyId = (
      (await counterpartyResponse.json()) as { data: { counterparty: { id: string } } }
    ).data.counterparty.id;
    const accountResponse = await api(`/v1/counterparties/${counterpartyId}/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountKind: "crypto_wallet",
        label: "Authority revocation recipient",
        details: { network: "solana", address: recipient.address },
      }),
    });
    expect(accountResponse.status).toBe(201);
    counterpartyAccountId = (
      (await accountResponse.json()) as { data: { account: { id: string } } }
    ).data.account.id;
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await cleanupIntegrationSuite();
  });

  async function createSchedule(request: ReturnType<typeof requestWithApiKey>): Promise<string> {
    const created = await call(
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
    return created.data.recurringPayment.id;
  }

  async function activeSchedule(request: ReturnType<typeof requestWithApiKey>): Promise<string> {
    const id = await createSchedule(request);
    const activated = await call(request, `/v1/payments/recurring-payments/${id}/activate`);
    expect(activated.data.recurringPayment.status).toBe("active");
    return id;
  }

  /** Moves every schedule's last change past its period, as time passing would. */
  async function letPeriodsEnd(ids: string[]): Promise<void> {
    await getDb(env).execute(
      "UPDATE payment_recurring_payments SET updated_at = ? WHERE id = ANY(?::text[])",
      [new Date(Date.now() - IDLE_BACKDATE_MS).toISOString(), ids]
    );
  }

  it("revokes the delegation only once every schedule on it has ended, without the key that set them up", {
    timeout: TEST_TIMEOUT_MS,
  }, async () => {
    const keyManager = await requestAsOrganizationAdmin();
    const keyName = `HOO-2210 schedules ${Date.now()}`;
    const keyResponse = await keyManager(`/v1/projects/${TEST_PROJECT.id}/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: keyName,
        grants: ["recurring.read", "recurring.manage", "recurring.execute", "counterparties.read"],
        walletScope: "all",
      }),
    });
    expect(keyResponse.status).toBe(201);
    const key = ((await keyResponse.json()) as { data: { apiKey: { id: string; key: string } } })
      .data.apiKey;
    const scheduler = requestWithApiKey(key.key);

    const first = await activeSchedule(scheduler);
    const second = await activeSchedule(scheduler);
    const stored = await getDb(env).queryMany<{ subscription_authority_address: string }>(
      "SELECT subscription_authority_address FROM payment_recurring_payments WHERE id = ANY(?::text[])",
      [[first, second]]
    );
    expect(stored.map((row) => row.subscription_authority_address)).toEqual([authority, authority]);
    expect(await tokenAccountDelegate(tokenAccount)).toBe(authority);

    // One schedule ends; the other still collects through the same delegation.
    await call(scheduler, `/v1/payments/recurring-payments/${first}/cancel`);
    await letPeriodsEnd([first]);
    expect(await revokeIdleSubscriptionAuthorities(env, new Date())).toMatchObject({ revoked: 0 });
    expect(await tokenAccountDelegate(tokenAccount)).toBe(authority);

    // Both canceled, but the second is inside its period: it can still be resumed.
    await call(scheduler, `/v1/payments/recurring-payments/${second}/cancel`);
    expect(await revokeIdleSubscriptionAuthorities(env, new Date())).toMatchObject({ revoked: 0 });
    const resumed = await call(scheduler, `/v1/payments/recurring-payments/${second}/resume`);
    expect(resumed.data.recurringPayment.status).toBe("active");
    await call(scheduler, `/v1/payments/recurring-payments/${second}/cancel`);

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
    expect(await accountInfo(authority)).toBeNull();
    expect(await tokenAccountDelegate(tokenAccount)).toBeNull();
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
    expect(await tokenAccountDelegate(tokenAccount)).toBe(authority);
    await call(api, `/v1/payments/recurring-payments/${third}/cancel`);
  });

  it("refuses to activate on a wallet whose delegation is being revoked", {
    timeout: TEST_TIMEOUT_MS,
  }, async () => {
    const pending = await createSchedule(api);
    const now = new Date().toISOString();
    await getDb(env).execute(
      `INSERT INTO payment_subscription_authority_revocations (
         id, organization_id, project_id, environment, custody_wallet_id, wallet_address,
         token_mint, subscription_authority_address, status, created_at, updated_at)
       VALUES ('psar_in_flight_test', ?, ?, 'sandbox', ?, ?, ?, ?, 'processing', ?, ?)`,
      [TEST_ORG.id, TEST_PROJECT.id, walletId, walletAddress, USDC, authority, now, now]
    );
    try {
      await call(api, `/v1/payments/recurring-payments/${pending}/activate`, {}, 409);
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
    await call(api, `/v1/payments/recurring-payments/${pending}/cancel`);
  });
});
