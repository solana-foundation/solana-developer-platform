import type * as feePaymentAdapters from "@sdp/payments/fee-payment";
import type * as solanaRpc from "@sdp/rpc/solana";
import type { TokenStatus } from "@sdp/types";
import { getBase58Codec } from "@solana/codecs";
import type { Signature } from "@solana/kit";
import {
  address,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import * as subscriptionsProgram from "@solana/subscriptions";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresPaymentSubscriptionsRepository } from "@/db/repositories";
import app from "@/index";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  confirmTransactionMock,
  createFeePaymentAdapterMock,
  createOrgSignerMock,
  DEVNET_USDC_MINT,
  fetchMaybeSubscriptionDelegationMock,
  getAccountInfoMock,
  getRecentBlockhashMock,
  getTransactionMock,
  installPaymentsRouteTestHooks,
  mockRecurringActivationRpc,
  mockTokenSupplyDecimalsOnce,
  recurringCollectionTransactionForSignature,
  seedCachedKey,
  seedCounterparty,
  TEST_API_KEY,
  TEST_KORA_FEE_PAYER,
  TEST_ORG,
  TEST_PROJECT,
  TEST_SPONSORSHIP_PROVIDER_CONFIG,
  TEST_USER,
  TEST_WALLET_ID,
  updateSeededWalletPublicKey,
} from "@/test/helpers/payments-routes";

function mockDistinctRecentBlockhashes(): void {
  const blockhashes = [
    "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
    "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR",
    "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8",
    "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq",
    "LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY",
    "QWmroo4YnnMqYW3cnxWkFdaTxGD3P7vMSzwMHGbUzwF",
  ];
  let call = 0;
  getRecentBlockhashMock.mockImplementation(async () => ({
    blockhash: blockhashes[call++ % blockhashes.length] as Awaited<
      ReturnType<typeof solanaRpc.getRecentBlockhash>
    >["blockhash"],
    lastValidBlockHeight: 1000n,
  }));
}

const TEST_COUNTERPARTY_IDENTITY = {
  firstName: "Ada",
  lastName: "Lovelace",
  dateOfBirth: "1990-01-15",
  phone: "+14155551234",
  address: {
    line1: "1 Market St",
    city: "San Francisco",
    countryCode: "US",
  },
} as const;

async function seedCryptoWalletCounterpartyAccount(params: {
  counterpartyId: string;
  address: string;
}): Promise<string> {
  const id = `counterparty_account_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  await getDb(env)
    .prepare(
      `INSERT INTO counterparty_accounts (
         id,
         organization_id,
         project_id,
         counterparty_id,
         account_kind,
         label,
         details,
         provider_account_data,
         status,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      params.counterpartyId,
      "crypto_wallet",
      "Recurring payment wallet",
      JSON.stringify({ network: "solana", address: params.address }),
      JSON.stringify({}),
      "active",
      now,
      now
    )
    .run();

  return id;
}

async function seedIssuedTokenMint(params: {
  projectId: string;
  mintAddress: string;
  status: TokenStatus;
}): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO issued_tokens (id, project_id, organization_id, mint_address, name, symbol, decimals, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      `tok_${crypto.randomUUID()}`,
      params.projectId,
      TEST_ORG.id,
      params.mintAddress,
      "Issued Test Token",
      "ITT",
      6,
      params.status,
      TEST_USER.id
    )
    .run();
}

function expectPreparedSubscriptionTransaction(
  preparedTransaction: {
    serialized: string;
    blockhash: string;
    lastValidBlockHeight: string;
    requiredSigners: string[];
  },
  expectedSigners: string[]
): void {
  expect(preparedTransaction.serialized).toBeTruthy();
  expect(preparedTransaction.blockhash).toBe("EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N");
  expect(preparedTransaction.lastValidBlockHeight).toBe("1000");
  for (const signer of expectedSigners) {
    expect(preparedTransaction.requiredSigners).toContain(signer);
  }

  const transaction = getTransactionDecoder().decode(
    Buffer.from(preparedTransaction.serialized, "base64")
  );
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);

  expect(message.staticAccounts.length).toBeGreaterThan(0);
  for (const signer of expectedSigners) {
    expect(Object.keys(transaction.signatures)).toContain(signer);
  }
}

async function createRecurringPaymentForActivation(headers: Record<string, string>) {
  const counterpartyId = await seedCounterparty({
    externalId: `recurring_activation_counterparty_${crypto.randomUUID()}`,
  });
  const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
    counterpartyId,
    address: TEST_SOLANA_ADDRESSES.wallet2,
  });

  const createRes = await app.request(
    "/v1/payments/recurring-payments",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        sourceWalletId: TEST_WALLET_ID,
        counterpartyId,
        counterpartyAccountId,
        token: DEVNET_USDC_MINT,
        amount: "25.00",
        periodHours: 24,
      }),
    },
    env
  );
  expect(createRes.status).toBe(201);
  const createBody = (await createRes.json()) as {
    data: { recurringPayment: { id: string } };
  };

  return createBody.data.recurringPayment.id;
}

async function activateRecurringPaymentForTest(headers: Record<string, string>) {
  const recurringPaymentId = await createRecurringPaymentForActivation(headers);
  const activateRes = await app.request(
    `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
    {
      method: "POST",
      headers,
    },
    env
  );
  expect(activateRes.status).toBe(200);
  const activateBody = (await activateRes.json()) as {
    data: {
      recurringPayment: {
        id: string;
        status: string;
        planId: string;
        subscriptionId: string;
        nextCollectionDueAt: string;
      };
    };
  };
  expect(activateBody.data.recurringPayment.status).toBe("active");
  return activateBody.data.recurringPayment;
}

describe("Payments routes — recurring", () => {
  installPaymentsRouteTestHooks();

  it("creates, lists, and gets recurring payment records through SDP API routes", async () => {
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const counterpartyId = await seedCounterparty({ externalId: "recurring_records_counterparty" });
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const createRes = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          sourceWalletId: TEST_WALLET_ID,
          counterpartyId,
          counterpartyAccountId,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 24,
        }),
      },
      env
    );

    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      data: {
        recurringPayment: {
          id: string;
          sourceWalletId: string;
          counterpartyId: string;
          counterpartyAccountId: string;
          destinationAddress: string;
          token: string;
          amount: string;
          status: string;
        };
      };
    };
    expect(createBody.data.recurringPayment.id).toMatch(/^prp_/);
    expect(createBody.data.recurringPayment.sourceWalletId).toBe(TEST_WALLET_ID);
    expect(createBody.data.recurringPayment.counterpartyId).toBe(counterpartyId);
    expect(createBody.data.recurringPayment.counterpartyAccountId).toBe(counterpartyAccountId);
    expect(createBody.data.recurringPayment.destinationAddress).toBe(TEST_SOLANA_ADDRESSES.wallet2);
    expect(createBody.data.recurringPayment.token).toBe(DEVNET_USDC_MINT);
    expect(createBody.data.recurringPayment.amount).toBe("25.00");
    expect(createBody.data.recurringPayment.status).toBe("pending_activation");

    const listRes = await app.request(
      "/v1/payments/recurring-payments?status=pending_activation",
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      data: { recurringPayments: Array<{ id: string }>; total: number };
    };
    expect(listBody.data.total).toBe(1);
    expect(listBody.data.recurringPayments[0]?.id).toBe(createBody.data.recurringPayment.id);

    const getRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      data: { recurringPayment: { id: string; status: string } };
    };
    expect(getBody.data.recurringPayment.id).toBe(createBody.data.recurringPayment.id);
    expect(getBody.data.recurringPayment.status).toBe("pending_activation");
  });

  it("restricts recurring payment tokens to USD stablecoins and project-issued tokens", async () => {
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const counterpartyId = await seedCounterparty({ externalId: "recurring_token_gate" });
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const createRecurring = (token: string) =>
      app.request(
        "/v1/payments/recurring-payments",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            sourceWalletId: TEST_WALLET_ID,
            counterpartyId,
            counterpartyAccountId,
            token,
            amount: "25.00",
            periodHours: 24,
          }),
        },
        env
      );

    const expectTokenRejected = async (token: string) => {
      const res = await createRecurring(token);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe(
        "Recurring payments support USD stablecoins and tokens issued in this project; native SOL is not supported"
      );
    };

    await expectTokenRejected("SOL");
    await expectTokenRejected(TEST_SOLANA_ADDRESSES.wallet1);

    const otherProject = { id: "prj_other_token_gate", slug: "other-token-gate-project" };
    await getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        otherProject.id,
        TEST_ORG.id,
        "Other Token Gate Project",
        otherProject.slug,
        "sandbox",
        "active",
        TEST_USER.id
      )
      .run();

    const issuedMint = (await generateKeyPairSigner()).address;
    const pausedMint = (await generateKeyPairSigner()).address;
    const otherProjectMint = (await generateKeyPairSigner()).address;
    await seedIssuedTokenMint({
      projectId: TEST_PROJECT.id,
      mintAddress: issuedMint,
      status: "active",
    });
    await seedIssuedTokenMint({
      projectId: TEST_PROJECT.id,
      mintAddress: pausedMint,
      status: "paused",
    });
    await seedIssuedTokenMint({
      projectId: otherProject.id,
      mintAddress: otherProjectMint,
      status: "active",
    });

    await expectTokenRejected(pausedMint);
    await expectTokenRejected(otherProjectMint);

    const issuedRes = await createRecurring(issuedMint);
    expect(issuedRes.status).toBe(201);
    const issuedBody = (await issuedRes.json()) as {
      data: { recurringPayment: { token: string } };
    };
    expect(issuedBody.data.recurringPayment.token).toBe(issuedMint);

    const stableRes = await createRecurring("USDC");
    expect(stableRes.status).toBe(201);
    const stableBody = (await stableRes.json()) as {
      data: { recurringPayment: { token: string } };
    };
    expect(stableBody.data.recurringPayment.token).toBe(DEVNET_USDC_MINT);
  });

  it("activates recurring payments through SDP API routes", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const counterpartyId = await seedCounterparty({
      externalId: "recurring_activation_counterparty",
    });
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const createRes = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          sourceWalletId: TEST_WALLET_ID,
          counterpartyId,
          counterpartyAccountId,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 24,
        }),
      },
      env
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      data: { recurringPayment: { id: string } };
    };

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      {
        method: "POST",
        headers,
      },
      env
    );

    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: {
        recurringPayment: {
          id: string;
          status: string;
          planId: string;
          subscriptionId: string;
          planPda: string;
          planCreatedAt: string;
          planCreationSignature: string;
          subscriptionPda: string;
          subscriptionAuthorityAddress: string;
          authorizationSignature: string;
          nextCollectionDueAt: string;
        };
      };
    };
    expect(activateBody.data.recurringPayment).toMatchObject({
      id: createBody.data.recurringPayment.id,
      status: "active",
      planCreatedAt: "1770000000",
      planCreationSignature:
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy",
      authorizationSignature:
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV",
    });
    expect(activateBody.data.recurringPayment.planId).toMatch(/^psp_/);
    expect(activateBody.data.recurringPayment.subscriptionId).toMatch(/^psub_/);
    expect(activateBody.data.recurringPayment.planPda).toBeTruthy();
    expect(activateBody.data.recurringPayment.subscriptionPda).toBeTruthy();
    expect(activateBody.data.recurringPayment.subscriptionAuthorityAddress).toBeTruthy();
    expect(activateBody.data.recurringPayment.nextCollectionDueAt).toBeTruthy();
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
    const confirmedAttempts = await getDb(env)
      .prepare(
        `SELECT status, stage, plan_creation_signature, authorization_signature
           FROM payment_recurring_payment_activation_attempts
          WHERE recurring_payment_id = ?
          ORDER BY created_at DESC`
      )
      .bind(createBody.data.recurringPayment.id)
      .all<{
        status: string;
        stage: string;
        plan_creation_signature: string | null;
        authorization_signature: string | null;
      }>();
    expect(confirmedAttempts.results[0]).toMatchObject({
      status: "confirmed",
      stage: "finalize",
      plan_creation_signature: activateBody.data.recurringPayment.planCreationSignature,
      authorization_signature: activateBody.data.recurringPayment.authorizationSignature,
    });

    const replayRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      {
        method: "POST",
        headers,
      },
      env
    );

    expect(replayRes.status).toBe(200);
    const replayBody = (await replayRes.json()) as {
      data: { recurringPayment: { id: string; status: string; authorizationSignature: string } };
    };
    expect(replayBody.data.recurringPayment).toMatchObject({
      id: createBody.data.recurringPayment.id,
      status: "active",
      authorizationSignature: activateBody.data.recurringPayment.authorizationSignature,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(2);

    await getDb(env)
      .prepare(
        `UPDATE payment_recurring_payment_activation_attempts
            SET status = 'processing',
                stage = 'finalize',
                updated_at = ?
          WHERE recurring_payment_id = ?`
      )
      .bind(new Date().toISOString(), createBody.data.recurringPayment.id)
      .run();

    const repairedReplayRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      {
        method: "POST",
        headers,
      },
      env
    );

    expect(repairedReplayRes.status).toBe(200);
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
    const repairedAttempt = await getDb(env)
      .prepare(
        `SELECT status, stage
           FROM payment_recurring_payment_activation_attempts
          WHERE recurring_payment_id = ?`
      )
      .bind(createBody.data.recurringPayment.id)
      .first<{ status: string; stage: string }>();
    expect(repairedAttempt).toMatchObject({
      status: "confirmed",
      stage: "finalize",
    });
  });

  it("updates pending recurring payment terms directly and journals an audit event", async () => {
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const counterpartyId = await seedCounterparty({
      externalId: "recurring_pending_update_counterparty",
    });
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const createRes = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          sourceWalletId: TEST_WALLET_ID,
          counterpartyId,
          counterpartyAccountId,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 24,
        }),
      },
      env
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      data: { recurringPayment: { id: string } };
    };

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          amount: "30.50",
          periodHours: 48,
          firstCollectionAt: null,
          metadataUri: "https://example.com/recurring/update.json",
        }),
      },
      env
    );

    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as {
      data: {
        recurringPayment: {
          id: string;
          amount: string;
          periodHours: number;
          metadataUri: string | null;
          status: string;
        };
      };
    };
    expect(updateBody.data.recurringPayment).toMatchObject({
      id: createBody.data.recurringPayment.id,
      amount: "30.50",
      periodHours: 48,
      metadataUri: "https://example.com/recurring/update.json",
      status: "pending_activation",
    });

    const event = await getDb(env)
      .prepare(
        `SELECT changed_fields, before_values, after_values
           FROM payment_recurring_payment_update_events
          WHERE recurring_payment_id = ?`
      )
      .bind(createBody.data.recurringPayment.id)
      .first<{
        changed_fields: string[];
        before_values: Record<string, unknown>;
        after_values: Record<string, unknown>;
      }>();
    expect(event?.changed_fields).toEqual(expect.arrayContaining(["amount", "periodHours"]));
    expect(event?.before_values.amount).toBe("25.00");
    expect(event?.after_values.amount).toBe("30.50");
  });

  it("updates active recurring payment metadata in place on the existing on-chain plan", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const updatePlanSignature =
      "4hVxsUpdat3Plan111111111111111111111111111111111111111111111111" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      )
      .mockResolvedValueOnce(updatePlanSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    const laterPeriodStartAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET current_period_start_at = ? WHERE id = ?")
      .bind(laterPeriodStartAt, activated.subscriptionId)
      .run();

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          metadataUri: "https://example.com/recurring/active.json",
          nextCollectionDueAt: null,
        }),
      },
      env
    );

    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as {
      data: {
        recurringPayment: {
          status: string;
          planId: string;
          subscriptionId: string;
          metadataUri: string | null;
          nextCollectionDueAt: string;
        };
      };
    };
    expect(updateBody.data.recurringPayment).toMatchObject({
      status: "active",
      planId: activated.planId,
      subscriptionId: activated.subscriptionId,
      metadataUri: "https://example.com/recurring/active.json",
    });
    expect(updateBody.data.recurringPayment.nextCollectionDueAt).not.toBeNull();
    expect(signAndSendMock).toHaveBeenCalledTimes(3);

    const attempt = await getDb(env)
      .prepare(
        `SELECT mode, status, stage, plan_update_signature
           FROM payment_recurring_payment_update_attempts
          WHERE recurring_payment_id = ?`
      )
      .bind(activated.id)
      .first<{
        mode: string;
        status: string;
        stage: string;
        plan_update_signature: string | null;
      }>();
    expect(attempt).toMatchObject({
      mode: "metadata_schedule",
      status: "confirmed",
      stage: "finalize",
      plan_update_signature: updatePlanSignature,
    });
    const event = await getDb(env)
      .prepare(
        `SELECT after_values
           FROM payment_recurring_payment_update_events
          WHERE recurring_payment_id = ?`
      )
      .bind(activated.id)
      .first<{ after_values: Record<string, unknown> }>();
    expect(event?.after_values.nextCollectionDueAt).toBe(
      updateBody.data.recurringPayment.nextCollectionDueAt
    );
  });

  it("replaces active recurring payment records for term changes and cancels the old subscription", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const replacementPlanSignature =
      "4hVxsReplac3Plan11111111111111111111111111111111111111111111" as Signature;
    const replacementAuthSignature =
      "4hVxsReplac3Auth11111111111111111111111111111111111111111111" as Signature;
    const oldCancelSignature =
      "4hVxsOldCanc3l111111111111111111111111111111111111111111111" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      )
      .mockResolvedValueOnce(replacementPlanSignature)
      .mockResolvedValueOnce(replacementAuthSignature)
      .mockResolvedValueOnce(oldCancelSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    const firstCollectionAt = "2026-07-02T00:00:00.000Z";
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET first_collection_at = ? WHERE id = ?")
      .bind(firstCollectionAt, activated.id)
      .run();

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ amount: "35.00", periodHours: 48, nextCollectionDueAt: null }),
      },
      env
    );

    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as {
      data: {
        recurringPayment: {
          status: string;
          amount: string;
          periodHours: number;
          planId: string;
          subscriptionId: string;
          authorizationSignature: string;
          nextCollectionDueAt: string;
        };
      };
    };
    expect(updateBody.data.recurringPayment).toMatchObject({
      status: "active",
      amount: "35.00",
      periodHours: 48,
      authorizationSignature: replacementAuthSignature,
    });
    expect(updateBody.data.recurringPayment.nextCollectionDueAt).not.toBeNull();
    expect(updateBody.data.recurringPayment.planId).not.toBe(activated.planId);
    expect(updateBody.data.recurringPayment.subscriptionId).not.toBe(activated.subscriptionId);
    expect(signAndSendMock).toHaveBeenCalledTimes(5);

    const oldSubscription = await getDb(env)
      .prepare("SELECT status FROM payment_subscriptions WHERE id = ?")
      .bind(activated.subscriptionId)
      .first<{ status: string }>();
    const oldPlan = await getDb(env)
      .prepare("SELECT status FROM payment_subscription_plans WHERE id = ?")
      .bind(activated.planId)
      .first<{ status: string }>();
    const attempt = await getDb(env)
      .prepare(
        `SELECT mode, status, stage, plan_creation_signature, authorization_signature, old_cancel_signature
           FROM payment_recurring_payment_update_attempts
          WHERE recurring_payment_id = ?`
      )
      .bind(activated.id)
      .first<{
        mode: string;
        status: string;
        stage: string;
        plan_creation_signature: string | null;
        authorization_signature: string | null;
        old_cancel_signature: string | null;
      }>();
    expect(oldSubscription?.status).toBe("canceled");
    expect(oldPlan?.status).toBe("archived");
    expect(attempt).toMatchObject({
      mode: "replacement",
      status: "confirmed",
      stage: "finalize",
      plan_creation_signature: replacementPlanSignature,
      authorization_signature: replacementAuthSignature,
      old_cancel_signature: oldCancelSignature,
    });
    const event = await getDb(env)
      .prepare(
        `SELECT changed_fields, before_values, after_values
           FROM payment_recurring_payment_update_events
          WHERE recurring_payment_id = ?`
      )
      .bind(activated.id)
      .first<{
        changed_fields: string[];
        before_values: Record<string, unknown>;
        after_values: Record<string, unknown>;
      }>();
    expect(event?.changed_fields).toContain("firstCollectionAt");
    expect(event?.changed_fields).toContain("nextCollectionDueAt");
    expect(event?.before_values.firstCollectionAt).toBe(firstCollectionAt);
    expect(event?.after_values.firstCollectionAt).toBeNull();
    expect(event?.after_values.nextCollectionDueAt).toBe(
      updateBody.data.recurringPayment.nextCollectionDueAt
    );
  });

  it("rejects active replacement next due dates before replacement transactions are submitted", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    const tooEarlyNextDue = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          amount: "35.00",
          periodHours: 48,
          nextCollectionDueAt: tooEarlyNextDue,
        }),
      },
      env
    );

    expect(updateRes.status).toBe(400);
    const body = (await updateRes.json()) as { error: { message: string } };
    expect(body.error.message).toContain("replacement subscription period");
    expect(signAndSendMock).toHaveBeenCalledTimes(2);

    const recurringPayment = await getDb(env)
      .prepare("SELECT status FROM payment_recurring_payments WHERE id = ?")
      .bind(activated.id)
      .first<{ status: string }>();
    const attempt = await getDb(env)
      .prepare(
        `SELECT status, error, plan_creation_signature, authorization_signature, old_cancel_signature
           FROM payment_recurring_payment_update_attempts
          WHERE recurring_payment_id = ?`
      )
      .bind(activated.id)
      .first<{
        status: string;
        error: string | null;
        plan_creation_signature: string | null;
        authorization_signature: string | null;
        old_cancel_signature: string | null;
      }>();
    expect(recurringPayment?.status).toBe("active");
    expect(attempt).toMatchObject({
      status: "failed",
      plan_creation_signature: null,
      authorization_signature: null,
      old_cancel_signature: null,
    });
    expect(attempt?.error).toContain("replacement subscription period");
  });

  it("rejects fresh in-flight recurring payment updates", async () => {
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET status = 'updating' WHERE id = ?")
      .bind(recurringPaymentId)
      .run();

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ metadataUri: "https://example.com/recurring/wait.json" }),
      },
      env
    );

    expect(updateRes.status).toBe(409);
    const body = (await updateRes.json()) as { error: { message: string } };
    expect(body.error.message).toContain("already processing");
  });

  it("rejects stale recurring payment update recovery with a different payload", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();

    await getDb(env)
      .prepare(
        "UPDATE payment_recurring_payments SET status = 'updating', updated_at = ? WHERE id = ?"
      )
      .bind(staleAt, activated.id)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_payment_update_attempts (
           id,
           organization_id,
           project_id,
           recurring_payment_id,
           mode,
           status,
           stage,
           old_plan_id,
           old_subscription_id,
           changed_fields,
           before_values,
           after_values,
           created_at,
           updated_at
         ) VALUES (
           'prpu_stale_payload_mismatch',
           ?, ?, ?, 'replacement', 'processing', 'create_plan', ?, ?,
           ARRAY['amount']::text[], ?::jsonb, ?::jsonb, ?, ?
         )`
      )
      .bind(
        TEST_ORG.id,
        TEST_PROJECT.id,
        activated.id,
        activated.planId,
        activated.subscriptionId,
        JSON.stringify({ amount: "25.00" }),
        JSON.stringify({ amount: "35.00" }),
        staleAt,
        staleAt
      )
      .run();

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ amount: "36.00" }),
      },
      env
    );

    expect(updateRes.status).toBe(409);
    const body = (await updateRes.json()) as { error: { message: string } };
    expect(body.error.message).toContain("retry the same update");
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("clamps stale metadata update retries after the subscription period advances", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const planCreationSignature =
      "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature;
    const authorizationSignature =
      "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature;
    const updatePlanSignature =
      "3agLAsjf2Qba9W59cqxbXFoPRJFDFKB3efqYRhT6wLxaM4KwV31NVrLDjKAw22hR1GFcQc4mePSjZ6XZEHUAjN4c" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(planCreationSignature)
      .mockResolvedValueOnce(authorizationSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const requestedNextDueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const advancedPeriodStartAt = new Date().toISOString();
    const expectedClampedDueAt = new Date(
      new Date(advancedPeriodStartAt).getTime() + 24 * 60 * 60 * 1000
    ).toISOString();
    const metadataUri = "https://example.com/recurring/recovered.json";

    await getDb(env)
      .prepare(
        "UPDATE payment_recurring_payments SET status = 'updating', updated_at = ? WHERE id = ?"
      )
      .bind(staleAt, activated.id)
      .run();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET current_period_start_at = ? WHERE id = ?")
      .bind(advancedPeriodStartAt, activated.subscriptionId)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_payment_update_attempts (
           id,
           organization_id,
           project_id,
           recurring_payment_id,
           mode,
           status,
           stage,
           old_plan_id,
           old_subscription_id,
           plan_update_signature,
           changed_fields,
           before_values,
           after_values,
           created_at,
           updated_at
         ) VALUES (
           'prpu_stale_metadata_schedule_recovery',
           ?, ?, ?, 'metadata_schedule', 'processing', 'update_plan', ?, ?, ?,
           ARRAY['nextCollectionDueAt', 'metadataUri']::text[], ?::jsonb, ?::jsonb, ?, ?
         )`
      )
      .bind(
        TEST_ORG.id,
        TEST_PROJECT.id,
        activated.id,
        activated.planId,
        activated.subscriptionId,
        updatePlanSignature,
        JSON.stringify({ nextCollectionDueAt: activated.nextCollectionDueAt, metadataUri: null }),
        JSON.stringify({ nextCollectionDueAt: requestedNextDueAt, metadataUri }),
        staleAt,
        staleAt
      )
      .run();

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ metadataUri, nextCollectionDueAt: requestedNextDueAt }),
      },
      env
    );

    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as {
      data: {
        recurringPayment: {
          status: string;
          metadataUri: string;
          nextCollectionDueAt: string;
        };
      };
    };
    expect(updateBody.data.recurringPayment).toMatchObject({
      status: "active",
      metadataUri,
      nextCollectionDueAt: expectedClampedDueAt,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(2);

    const event = await getDb(env)
      .prepare(
        `SELECT after_values
           FROM payment_recurring_payment_update_events
          WHERE recurring_payment_id = ?`
      )
      .bind(activated.id)
      .first<{ after_values: Record<string, unknown> }>();
    expect(event?.after_values.nextCollectionDueAt).toBe(expectedClampedDueAt);
  });

  it("creates the source token account during recurring payment activation when it is missing", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc({ tokenAccounts: [] });
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "2MAd2T6zSaHCcmstzbmY2uFw5gJtbSjz3GbASJw9XhD27K3F2JWGY4frA44oXpXbpMC5Qn2ePekemCzGH8Eb7L7J" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);
    const [expectedSourceAta] = await findAssociatedTokenPda({
      owner: sourceSigner.address,
      tokenProgram: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      mint: address(DEVNET_USDC_MINT),
    });

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      {
        method: "POST",
        headers,
      },
      env
    );

    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: { recurringPayment: { status: string; subscriptionId: string } };
    };
    expect(activateBody.data.recurringPayment.status).toBe("active");
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
    const subscriptionRow = await getDb(env)
      .prepare("SELECT subscriber_token_account FROM payment_subscriptions WHERE id = ?")
      .bind(activateBody.data.recurringPayment.subscriptionId)
      .first<{ subscriber_token_account: string | null }>();
    expect(subscriptionRow?.subscriber_token_account).toBe(expectedSourceAta);
  });

  it("cancels active recurring payments through SDP API routes", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const cancelSignature =
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      )
      .mockResolvedValueOnce(cancelSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);

    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers },
      env
    );

    expect(cancelRes.status).toBe(200);
    const cancelBody = (await cancelRes.json()) as {
      data: { recurringPayment: { id: string; status: string } };
    };
    expect(cancelBody.data.recurringPayment).toMatchObject({
      id: activated.id,
      status: "canceled",
    });
    const lifecycleAttempt = await getDb(env)
      .prepare(
        `SELECT operation, status, stage, signature
           FROM payment_recurring_payment_lifecycle_attempts
          WHERE recurring_payment_id = ?
          ORDER BY created_at DESC`
      )
      .bind(activated.id)
      .first<{ operation: string; status: string; stage: string; signature: string | null }>();
    expect(lifecycleAttempt).toMatchObject({
      operation: "cancel",
      status: "confirmed",
      stage: "finalize",
      signature: cancelSignature,
    });
    const subscriptionRow = await getDb(env)
      .prepare("SELECT status, cancel_at, canceled_at FROM payment_subscriptions WHERE id = ?")
      .bind(activated.subscriptionId)
      .first<{ status: string; cancel_at: string | null; canceled_at: string | null }>();
    expect(subscriptionRow?.status).toBe("canceled");
    expect(subscriptionRow?.cancel_at).toBeTruthy();
    expect(subscriptionRow?.canceled_at).toBeTruthy();

    const replayRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers },
      env
    );

    expect(replayRes.status).toBe(200);
    const replayBody = (await replayRes.json()) as {
      data: { recurringPayment: { id: string; status: string } };
    };
    expect(replayBody.data.recurringPayment).toMatchObject({
      id: activated.id,
      status: "canceled",
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
  });

  it("cancels pending_activation recurring payments directly without on-chain tx", async () => {
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);

    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/cancel`,
      { method: "POST", headers },
      env
    );

    expect(cancelRes.status).toBe(200);
    const cancelBody = (await cancelRes.json()) as {
      data: { recurringPayment: { id: string; status: string } };
    };
    expect(cancelBody.data.recurringPayment).toMatchObject({
      id: recurringPaymentId,
      status: "canceled",
    });

    const dbRow = await getDb(env)
      .prepare("SELECT status FROM payment_recurring_payments WHERE id = ?")
      .bind(recurringPaymentId)
      .first<{ status: string }>();
    expect(dbRow?.status).toBe("canceled");
  });

  it("resumes canceled recurring payments through SDP API routes", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const cancelSignature =
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13" as Signature;
    const resumeSignature =
      "4rNhfL5s9hQfCjVxrTQDAZECJ5M99kzF8JRgWEzZEijj73D4Jsiz82cgwxUc71vWR9NBdk2zX9qQREx9UvP4QREe" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      )
      .mockResolvedValueOnce(cancelSignature)
      .mockResolvedValueOnce(resumeSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers },
      env
    );
    expect(cancelRes.status).toBe(200);

    const resumeRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/resume`,
      { method: "POST", headers },
      env
    );

    expect(resumeRes.status).toBe(200);
    const resumeBody = (await resumeRes.json()) as {
      data: { recurringPayment: { id: string; status: string } };
    };
    expect(resumeBody.data.recurringPayment).toMatchObject({
      id: activated.id,
      status: "active",
    });
    const lifecycleAttempt = await getDb(env)
      .prepare(
        `SELECT operation, status, stage, signature
           FROM payment_recurring_payment_lifecycle_attempts
          WHERE recurring_payment_id = ? AND operation = 'resume'
          ORDER BY created_at DESC`
      )
      .bind(activated.id)
      .first<{ operation: string; status: string; stage: string; signature: string | null }>();
    expect(lifecycleAttempt).toMatchObject({
      operation: "resume",
      status: "confirmed",
      stage: "finalize",
      signature: resumeSignature,
    });
    const subscriptionRow = await getDb(env)
      .prepare("SELECT status, cancel_at, canceled_at FROM payment_subscriptions WHERE id = ?")
      .bind(activated.subscriptionId)
      .first<{ status: string; cancel_at: string | null; canceled_at: string | null }>();
    expect(subscriptionRow).toMatchObject({
      status: "active",
      cancel_at: null,
      canceled_at: null,
    });

    const replayRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/resume`,
      { method: "POST", headers },
      env
    );

    expect(replayRes.status).toBe(200);
    expect(signAndSendMock).toHaveBeenCalledTimes(4);
  });

  it("recovers submitted recurring payment cancel attempts", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const cancelSignature =
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    const staleUpdatedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const attemptId = `prpl_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare(
        "UPDATE payment_recurring_payments SET status = 'canceling', updated_at = ? WHERE id = ?"
      )
      .bind(staleUpdatedAt, activated.id)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_payment_lifecycle_attempts (
           id,
           organization_id,
           project_id,
           recurring_payment_id,
           operation,
           status,
           stage,
           signature,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        activated.id,
        "cancel",
        "processing",
        "submit",
        cancelSignature,
        JSON.stringify({}),
        staleUpdatedAt,
        staleUpdatedAt
      )
      .run();

    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers },
      env
    );

    expect(cancelRes.status).toBe(200);
    const cancelBody = (await cancelRes.json()) as {
      data: { recurringPayment: { status: string } };
    };
    expect(cancelBody.data.recurringPayment.status).toBe("canceled");
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
    expect(confirmTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      cancelSignature,
      expect.objectContaining({ commitment: "confirmed" })
    );
    const recoveredAttempt = await getDb(env)
      .prepare(
        "SELECT status, stage, signature FROM payment_recurring_payment_lifecycle_attempts WHERE id = ?"
      )
      .bind(attemptId)
      .first<{ status: string; stage: string; signature: string | null }>();
    expect(recoveredAttempt).toMatchObject({
      status: "confirmed",
      stage: "finalize",
      signature: cancelSignature,
    });
  });

  it("recovers submitted recurring payment resume attempts", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const cancelSignature =
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13" as Signature;
    const resumeSignature =
      "4rNhfL5s9hQfCjVxrTQDAZECJ5M99kzF8JRgWEzZEijj73D4Jsiz82cgwxUc71vWR9NBdk2zX9qQREx9UvP4QREe" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      )
      .mockResolvedValueOnce(cancelSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers },
      env
    );
    expect(cancelRes.status).toBe(200);

    const staleUpdatedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const attemptId = `prpl_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare(
        "UPDATE payment_recurring_payments SET status = 'resuming', updated_at = ? WHERE id = ?"
      )
      .bind(staleUpdatedAt, activated.id)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_payment_lifecycle_attempts (
           id,
           organization_id,
           project_id,
           recurring_payment_id,
           operation,
           status,
           stage,
           signature,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        activated.id,
        "resume",
        "processing",
        "submit",
        resumeSignature,
        JSON.stringify({}),
        staleUpdatedAt,
        staleUpdatedAt
      )
      .run();

    const resumeRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/resume`,
      { method: "POST", headers },
      env
    );

    expect(resumeRes.status).toBe(200);
    const resumeBody = (await resumeRes.json()) as {
      data: { recurringPayment: { status: string } };
    };
    expect(resumeBody.data.recurringPayment.status).toBe("active");
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
    expect(confirmTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      resumeSignature,
      expect.objectContaining({ commitment: "confirmed" })
    );
    const recoveredAttempt = await getDb(env)
      .prepare(
        "SELECT status, stage, signature FROM payment_recurring_payment_lifecycle_attempts WHERE id = ?"
      )
      .bind(attemptId)
      .first<{ status: string; stage: string; signature: string | null }>();
    expect(recoveredAttempt).toMatchObject({
      status: "confirmed",
      stage: "finalize",
      signature: resumeSignature,
    });
  });

  it("blocks recurring payment cancellation while a fresh collection is processing", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activated.id)
      .run();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activated.subscriptionId)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_collection_attempts (
           id,
           organization_id,
           project_id,
           subscription_id,
           transfer_id,
           token,
           amount,
           due_at,
           attempted_at,
           status,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        `psca_${crypto.randomUUID()}`,
        TEST_ORG.id,
        TEST_PROJECT.id,
        activated.subscriptionId,
        DEVNET_USDC_MINT,
        "25.00",
        dueAt,
        now,
        "processing",
        JSON.stringify({
          recurringPaymentId: activated.id,
          subscriptionId: activated.subscriptionId,
          collectionDueAt: dueAt,
        }),
        now,
        now
      )
      .run();

    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers },
      env
    );

    expect(cancelRes.status).toBe(409);
    const row = await getDb(env)
      .prepare("SELECT status FROM payment_recurring_payments WHERE id = ?")
      .bind(activated.id)
      .first<{ status: string }>();
    expect(row?.status).toBe("active");
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("resets recurring payment cancellation claims when subscription validation fails", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET status = 'paused' WHERE id = ?")
      .bind(activated.subscriptionId)
      .run();

    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers },
      env
    );

    expect(cancelRes.status).toBe(409);
    const cancelBody = (await cancelRes.json()) as { error: { message: string } };
    expect(cancelBody.error.message).toContain("Subscription cannot be canceled");
    const row = await getDb(env)
      .prepare("SELECT status FROM payment_recurring_payments WHERE id = ?")
      .bind(activated.id)
      .first<{ status: string }>();
    expect(row?.status).toBe("active");
    const lifecycleAttempt = await getDb(env)
      .prepare(
        `SELECT operation, status, stage, error
           FROM payment_recurring_payment_lifecycle_attempts
          WHERE recurring_payment_id = ?
          ORDER BY created_at DESC`
      )
      .bind(activated.id)
      .first<{ operation: string; status: string; stage: string; error: string | null }>();
    expect(lifecycleAttempt).toMatchObject({
      operation: "cancel",
      status: "failed",
      stage: "claim",
    });
    expect(lifecycleAttempt?.error).toContain("Subscription cannot be canceled");
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("recovers confirmed recurring payment collections before cancellation", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const collectionSignature =
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13" as Signature;
    const cancelSignature =
      "4rNhfL5s9hQfCjVxrTQDAZECJ5M99kzF8JRgWEzZEijj73D4Jsiz82cgwxUc71vWR9NBdk2zX9qQREx9UvP4QREe" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      )
      .mockResolvedValueOnce(cancelSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const transferId = `xfr_${crypto.randomUUID()}`;
    const attemptId = `psca_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activated.id)
      .run();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activated.subscriptionId)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id,
           organization_id,
           project_id,
           wallet_id,
           counterparty_id,
           source_address,
           destination_address,
           token,
           amount,
           memo,
           type,
           direction,
           status,
           provider_data,
           signature,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, (SELECT counterparty_id FROM payment_recurring_payments WHERE id = ?), ?, ?, ?, ?, NULL, ?, ?, ?, ?::jsonb, ?, ?, ?)`
      )
      .bind(
        transferId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        activated.id,
        sourceSigner.address,
        TEST_SOLANA_ADDRESSES.wallet2,
        DEVNET_USDC_MINT,
        "25.00",
        "transfer",
        "outbound",
        "confirmed",
        JSON.stringify({
          recurringPaymentId: activated.id,
          subscriptionId: activated.subscriptionId,
          collectionDueAt: dueAt,
        }),
        collectionSignature,
        now,
        now
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_collection_attempts (
           id,
           organization_id,
           project_id,
           subscription_id,
           transfer_id,
           token,
           amount,
           due_at,
           attempted_at,
           status,
           signature,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        activated.subscriptionId,
        transferId,
        DEVNET_USDC_MINT,
        "25.00",
        dueAt,
        now,
        "confirmed",
        collectionSignature,
        JSON.stringify({ recurringPaymentId: activated.id }),
        now,
        now
      )
      .run();

    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers },
      env
    );

    expect(cancelRes.status).toBe(200);
    const cancelBody = (await cancelRes.json()) as {
      data: { recurringPayment: { status: string; nextCollectionDueAt: string } };
    };
    expect(cancelBody.data.recurringPayment.status).toBe("canceled");
    expect(new Date(cancelBody.data.recurringPayment.nextCollectionDueAt).getTime()).toBe(
      new Date(dueAt).getTime() + 24 * 60 * 60 * 1000
    );
    const recoveredAttempt = await getDb(env)
      .prepare(
        "SELECT status, signature FROM payment_subscription_collection_attempts WHERE id = ?"
      )
      .bind(attemptId)
      .first<{ status: string; signature: string | null }>();
    expect(recoveredAttempt).toMatchObject({
      status: "confirmed",
      signature: collectionSignature,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
  });

  it("collects due recurring payments through SDP API routes", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const collectionSignature =
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      )
      .mockResolvedValueOnce(collectionSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      { method: "POST", headers },
      env
    );
    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: { recurringPayment: { subscriptionId: string } };
    };
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    await getDb(env)
      .prepare(
        `UPDATE payment_recurring_payments
            SET next_collection_due_at = ?
          WHERE id = ?`
      )
      .bind(dueAt, recurringPaymentId)
      .run();
    await getDb(env)
      .prepare(
        `UPDATE payment_subscriptions
            SET next_collection_due_at = ?
          WHERE id = ?`
      )
      .bind(dueAt, activateBody.data.recurringPayment.subscriptionId)
      .run();
    const [expectedDestinationAta] = await findAssociatedTokenPda({
      owner: address(TEST_SOLANA_ADDRESSES.wallet2),
      tokenProgram: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      mint: address(DEVNET_USDC_MINT),
    });

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      { method: "POST", headers },
      env
    );

    expect(collectRes.status).toBe(200);
    const collectBody = (await collectRes.json()) as {
      data: {
        recurringPayment: {
          id: string;
          status: string;
          nextCollectionDueAt: string;
          destinationTokenAccount: string;
        };
        collectionAttempt: {
          id: string;
          transferId: string;
          status: string;
          signature: string;
          dueAt: string;
        };
        transfer: {
          id: string;
          status: string;
          signature: string;
          source: string;
          destination: string;
        };
      };
    };
    expect(collectBody.data.recurringPayment).toMatchObject({
      id: recurringPaymentId,
      status: "active",
      destinationTokenAccount: expectedDestinationAta,
    });
    expect(new Date(collectBody.data.recurringPayment.nextCollectionDueAt).getTime()).toBe(
      new Date(dueAt).getTime() + 24 * 60 * 60 * 1000
    );
    expect(collectBody.data.collectionAttempt).toMatchObject({
      status: "confirmed",
      signature: collectionSignature,
      dueAt,
    });
    const manualAttempt = await getDb(env)
      .prepare("SELECT metadata FROM payment_subscription_collection_attempts WHERE id = ?")
      .bind(collectBody.data.collectionAttempt.id)
      .first<{ metadata: { collectionSource?: string; initiatedByKeyId?: string } }>();
    expect(manualAttempt?.metadata).toMatchObject({
      collectionSource: "manual",
      initiatedByKeyId: TEST_API_KEY.id,
    });
    expect(collectBody.data.transfer).toMatchObject({
      id: collectBody.data.collectionAttempt.transferId,
      status: "confirmed",
      signature: collectionSignature,
      source: sourceSigner.address,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
  });

  it("does not advance billing when the confirmed pull amount differs", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const collectionSignature =
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      )
      .mockResolvedValueOnce(collectionSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activated.id)
      .run();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activated.subscriptionId)
      .run();
    getTransactionMock.mockImplementationOnce(async (_rpc, signature) => {
      const transaction = await recurringCollectionTransactionForSignature(signature);
      if (!transaction) {
        return null;
      }
      const instruction = transaction.instructions[0];
      if (!instruction?.data) {
        throw new Error("Expected recurring-payment transfer instruction data");
      }
      const decoded = subscriptionsProgram
        .getTransferSubscriptionInstructionDataDecoder()
        .decode(getBase58Codec().encode(instruction.data));
      const alteredData = subscriptionsProgram
        .getTransferSubscriptionInstructionDataEncoder()
        .encode({
          transferData: {
            ...decoded.transferData,
            amount: decoded.transferData.amount + 1n,
          },
        });
      return {
        ...transaction,
        instructions: [
          {
            ...instruction,
            data: getBase58Codec().decode(alteredData),
          },
        ],
      };
    });

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/collect`,
      { method: "POST", headers },
      env
    );

    expect(collectRes.status).toBe(409);
    const collectBody = (await collectRes.json()) as { error: { message: string } };
    expect(collectBody.error.message).toContain("does not prove");
    const recurringPayment = await getDb(env)
      .prepare("SELECT next_collection_due_at FROM payment_recurring_payments WHERE id = ?")
      .bind(activated.id)
      .first<{ next_collection_due_at: string }>();
    expect(recurringPayment?.next_collection_due_at).toBe(dueAt);
    const attempt = await getDb(env)
      .prepare(
        "SELECT status FROM payment_subscription_collection_attempts WHERE subscription_id = ?"
      )
      .bind(activated.subscriptionId)
      .first<{ status: string }>();
    expect(attempt?.status).toBe("processing");
  });

  it.each([
    { journaledRecord: "transfer", attemptHasSignature: false, transferHasSignature: true },
    { journaledRecord: "attempt", attemptHasSignature: true, transferHasSignature: false },
  ])(
    "recovers submitted recurring payment collection attempts from the $journaledRecord journal",
    async ({ attemptHasSignature, transferHasSignature }) => {
      const sourceSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      createOrgSignerMock.mockResolvedValue(sourceSigner);
      mockRecurringActivationRpc();
      const submittedSignature =
        "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13" as Signature;
      const signAndSendMock = vi
        .fn()
        .mockResolvedValueOnce(
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
        )
        .mockResolvedValueOnce(
          "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
        );
      createFeePaymentAdapterMock.mockReturnValue({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
        signAsFeePayer: vi.fn(),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
      const headers = {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
      };
      const recurringPaymentId = await createRecurringPaymentForActivation(headers);

      const activateRes = await app.request(
        `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
        { method: "POST", headers },
        env
      );
      expect(activateRes.status).toBe(200);
      const activateBody = (await activateRes.json()) as {
        data: { recurringPayment: { subscriptionId: string } };
      };
      const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
      const now = new Date().toISOString();
      const transferId = `xfr_${crypto.randomUUID()}`;
      const attemptId = `psca_${crypto.randomUUID()}`;
      await getDb(env)
        .prepare("UPDATE payment_recurring_payments SET next_collection_due_at = ? WHERE id = ?")
        .bind(dueAt, recurringPaymentId)
        .run();
      await getDb(env)
        .prepare("UPDATE payment_subscriptions SET next_collection_due_at = ? WHERE id = ?")
        .bind(dueAt, activateBody.data.recurringPayment.subscriptionId)
        .run();
      await getDb(env)
        .prepare(
          `INSERT INTO payment_transfers (
           id,
           organization_id,
           project_id,
           wallet_id,
           counterparty_id,
           source_address,
           destination_address,
           token,
           amount,
           memo,
           type,
           direction,
           status,
           provider_data,
           signature,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, (SELECT counterparty_id FROM payment_recurring_payments WHERE id = ?), ?, ?, ?, ?, NULL, ?, ?, ?, ?::jsonb, ?, ?, ?)`
        )
        .bind(
          transferId,
          TEST_ORG.id,
          TEST_PROJECT.id,
          TEST_WALLET_ID,
          recurringPaymentId,
          sourceSigner.address,
          TEST_SOLANA_ADDRESSES.wallet2,
          DEVNET_USDC_MINT,
          "25.00",
          "transfer",
          "outbound",
          "processing",
          JSON.stringify({ recurringPaymentId }),
          transferHasSignature ? submittedSignature : null,
          now,
          now
        )
        .run();
      await getDb(env)
        .prepare(
          `INSERT INTO payment_subscription_collection_attempts (
           id,
           organization_id,
           project_id,
           subscription_id,
           transfer_id,
           token,
           amount,
           due_at,
           attempted_at,
           status,
           signature,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
        )
        .bind(
          attemptId,
          TEST_ORG.id,
          TEST_PROJECT.id,
          activateBody.data.recurringPayment.subscriptionId,
          transferId,
          DEVNET_USDC_MINT,
          "25.00",
          dueAt,
          now,
          "processing",
          attemptHasSignature ? submittedSignature : null,
          JSON.stringify({ recurringPaymentId }),
          now,
          now
        )
        .run();
      const [expectedDestinationAta] = await findAssociatedTokenPda({
        owner: address(TEST_SOLANA_ADDRESSES.wallet2),
        tokenProgram: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        mint: address(DEVNET_USDC_MINT),
      });

      const collectRes = await app.request(
        `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
        { method: "POST", headers },
        env
      );

      expect(collectRes.status).toBe(200);
      const collectBody = (await collectRes.json()) as {
        data: {
          recurringPayment: { destinationTokenAccount: string; nextCollectionDueAt: string };
          collectionAttempt: { id: string; status: string; signature: string };
          transfer: { id: string; status: string; signature: string };
        };
      };
      expect(collectBody.data.recurringPayment.destinationTokenAccount).toBe(
        expectedDestinationAta
      );
      expect(collectBody.data.collectionAttempt).toMatchObject({
        id: attemptId,
        status: "confirmed",
        signature: submittedSignature,
      });
      expect(collectBody.data.transfer).toMatchObject({
        id: transferId,
        status: "confirmed",
        signature: submittedSignature,
      });
      expect(new Date(collectBody.data.recurringPayment.nextCollectionDueAt).getTime()).toBe(
        new Date(dueAt).getTime() + 24 * 60 * 60 * 1000
      );
      expect(signAndSendMock).toHaveBeenCalledTimes(2);
      expect(confirmTransactionMock).toHaveBeenCalledWith(
        expect.anything(),
        submittedSignature,
        expect.objectContaining({ commitment: "confirmed" })
      );
    }
  );

  it("does not let a delayed authorization preparation overwrite an active subscription", async () => {
    const counterpartyId = await seedCounterparty({
      externalId: `authorization_race_${crypto.randomUUID()}`,
    });
    const repo = createPostgresPaymentSubscriptionsRepository(getDb(env));
    const planId = `psp_${crypto.randomUUID()}`;
    const subscriptionId = `psub_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const trustedTokenAccount = TEST_SOLANA_ADDRESSES.wallet1;
    const delayedTokenAccount = TEST_SOLANA_ADDRESSES.wallet3;

    await repo.createPlan({
      id: planId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      ownerWalletId: TEST_WALLET_ID,
      ownerAddress: TEST_SOLANA_ADDRESSES.wallet1,
      token: DEVNET_USDC_MINT,
      amount: "25.00",
      periodHours: 24,
      programPlanId: "1004",
      planPda: null,
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
      pullerWalletId: null,
      pullerAddress: null,
      metadataUri: null,
      status: "active",
      createdBy: TEST_USER.id,
      createdAt: now,
      updatedAt: now,
    });
    await repo.createSubscription({
      id: subscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      planId,
      counterpartyId,
      subscriberAddress: TEST_SOLANA_ADDRESSES.wallet2,
      subscriberTokenAccount: null,
      subscriptionPda: null,
      subscriptionAuthorityAddress: null,
      authorizationSignature: null,
      status: "pending_authorization",
      currentPeriodStartAt: null,
      nextCollectionDueAt: null,
      createdBy: TEST_USER.id,
      createdAt: now,
      updatedAt: now,
    });

    let releaseMintLookup: (() => void) | undefined;
    let signalMintLookupReached: (() => void) | undefined;
    const mintLookupReached = new Promise<void>((resolve) => {
      signalMintLookupReached = resolve;
    });
    const mintLookupReleased = new Promise<void>((resolve) => {
      releaseMintLookup = resolve;
    });
    getAccountInfoMock.mockImplementationOnce(async () => {
      signalMintLookupReached?.();
      await mintLookupReleased;
      return {
        lamports: 4200000000n,
        owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      } as Awaited<ReturnType<typeof solanaRpc.getAccountInfo>>;
    });
    mockTokenSupplyDecimalsOnce();

    const preparePromise = app.request(
      `/v1/payments/subscriptions/${subscriptionId}/prepare-authorization`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedSubscriptionAuthorityInitId: "0",
          subscriberTokenAccount: delayedTokenAccount,
          expectedPlanCreatedAt: "1700000000",
        }),
      },
      env
    );

    await mintLookupReached;
    await repo.updateSubscription({
      subscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      subscriberTokenAccount: trustedTokenAccount,
      status: "active",
      currentPeriodStartAt: now,
      nextCollectionDueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
    });
    releaseMintLookup?.();

    const prepareRes = await preparePromise;
    expect(prepareRes.status).toBe(409);
    const persisted = await repo.getSubscriptionById({
      subscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
    });
    expect(persisted).toMatchObject({
      status: "active",
      subscriber_token_account: trustedTokenAccount,
    });
  });

  it("finalizes recovered recurring payment collections after cancellation", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const submittedSignature =
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      { method: "POST", headers },
      env
    );
    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: { recurringPayment: { subscriptionId: string } };
    };
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const transferId = `xfr_${crypto.randomUUID()}`;
    const attemptId = `psca_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare(
        `UPDATE payment_recurring_payments
            SET next_collection_due_at = ?,
                status = 'canceled'
          WHERE id = ?`
      )
      .bind(dueAt, recurringPaymentId)
      .run();
    await getDb(env)
      .prepare(
        `UPDATE payment_subscriptions
            SET next_collection_due_at = ?,
                status = 'canceled',
                canceled_at = ?
          WHERE id = ?`
      )
      .bind(dueAt, now, activateBody.data.recurringPayment.subscriptionId)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id,
           organization_id,
           project_id,
           wallet_id,
           counterparty_id,
           source_address,
           destination_address,
           token,
           amount,
           memo,
           type,
           direction,
           status,
           provider_data,
           signature,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, (SELECT counterparty_id FROM payment_recurring_payments WHERE id = ?), ?, ?, ?, ?, NULL, ?, ?, ?, ?::jsonb, ?, ?, ?)`
      )
      .bind(
        transferId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        recurringPaymentId,
        sourceSigner.address,
        TEST_SOLANA_ADDRESSES.wallet2,
        DEVNET_USDC_MINT,
        "25.00",
        "transfer",
        "outbound",
        "confirmed",
        JSON.stringify({
          recurringPaymentId,
          subscriptionId: activateBody.data.recurringPayment.subscriptionId,
          collectionDueAt: dueAt,
        }),
        submittedSignature,
        now,
        now
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_collection_attempts (
           id,
           organization_id,
           project_id,
           subscription_id,
           transfer_id,
           token,
           amount,
           due_at,
           attempted_at,
           status,
           signature,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        activateBody.data.recurringPayment.subscriptionId,
        transferId,
        DEVNET_USDC_MINT,
        "25.00",
        dueAt,
        now,
        "confirmed",
        submittedSignature,
        JSON.stringify({
          recurringPaymentId,
          subscriptionId: activateBody.data.recurringPayment.subscriptionId,
          collectionDueAt: dueAt,
        }),
        now,
        now
      )
      .run();

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      { method: "POST", headers },
      env
    );

    expect(collectRes.status).toBe(200);
    const collectBody = (await collectRes.json()) as {
      data: {
        recurringPayment: { status: string; nextCollectionDueAt: string };
        collectionAttempt: { id: string; status: string; signature: string };
        transfer: { id: string; status: string; signature: string };
      };
    };
    expect(collectBody.data.recurringPayment.status).toBe("canceled");
    expect(new Date(collectBody.data.recurringPayment.nextCollectionDueAt).getTime()).toBe(
      new Date(dueAt).getTime()
    );
    expect(collectBody.data.collectionAttempt).toMatchObject({
      id: attemptId,
      status: "confirmed",
      signature: submittedSignature,
    });
    expect(collectBody.data.transfer).toMatchObject({
      id: transferId,
      status: "confirmed",
      signature: submittedSignature,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("retries recurring payment collection after pre-submission crash", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const retrySignature =
      "4rNhfL5s9hQfCjVxrTQDAZECJ5M99kzF8JRgWEzZEijj73D4Jsiz82cgwxUc71vWR9NBdk2zX9qQREx9UvP4QREe" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      )
      .mockResolvedValueOnce(retrySignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      { method: "POST", headers },
      env
    );
    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: { recurringPayment: { subscriptionId: string } };
    };
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const staleAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const transferId = `xfr_${crypto.randomUUID()}`;
    const attemptId = `psca_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, recurringPaymentId)
      .run();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activateBody.data.recurringPayment.subscriptionId)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id,
           organization_id,
           project_id,
           wallet_id,
           counterparty_id,
           source_address,
           destination_address,
           token,
           amount,
           memo,
           type,
           direction,
           status,
           provider_data,
           signature,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, (SELECT counterparty_id FROM payment_recurring_payments WHERE id = ?), ?, ?, ?, ?, NULL, ?, ?, ?, ?::jsonb, ?, ?, ?)`
      )
      .bind(
        transferId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        recurringPaymentId,
        sourceSigner.address,
        TEST_SOLANA_ADDRESSES.wallet2,
        DEVNET_USDC_MINT,
        "25.00",
        "transfer",
        "outbound",
        "processing",
        JSON.stringify({
          recurringPaymentId,
          subscriptionId: activateBody.data.recurringPayment.subscriptionId,
          collectionDueAt: dueAt,
        }),
        null,
        staleAt,
        staleAt
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_collection_attempts (
           id,
           organization_id,
           project_id,
           subscription_id,
           transfer_id,
           token,
           amount,
           due_at,
           attempted_at,
           status,
           signature,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        activateBody.data.recurringPayment.subscriptionId,
        transferId,
        DEVNET_USDC_MINT,
        "25.00",
        dueAt,
        now,
        "processing",
        null,
        JSON.stringify({
          recurringPaymentId,
          subscriptionId: activateBody.data.recurringPayment.subscriptionId,
          collectionDueAt: dueAt,
        }),
        staleAt,
        staleAt
      )
      .run();

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      { method: "POST", headers },
      env
    );

    expect(collectRes.status).toBe(200);
    const collectBody = (await collectRes.json()) as {
      data: {
        collectionAttempt: { id: string; status: string; signature: string };
        transfer: { id: string; status: string; signature: string };
      };
    };
    expect(collectBody.data.collectionAttempt).toMatchObject({
      status: "confirmed",
      signature: retrySignature,
    });
    expect(collectBody.data.collectionAttempt.id).not.toBe(attemptId);
    expect(collectBody.data.transfer).toMatchObject({
      status: "confirmed",
      signature: retrySignature,
    });
    expect(collectBody.data.transfer.id).not.toBe(transferId);
    const staleAttempt = await getDb(env)
      .prepare(
        `SELECT status, error, metadata
           FROM payment_subscription_collection_attempts
          WHERE id = ?`
      )
      .bind(attemptId)
      .first<{ status: string; error: string | null; metadata: { retryAfterAt?: string } }>();
    expect(staleAttempt?.status).toBe("failed");
    expect(staleAttempt?.error).toContain("interrupted before submission");
    expect(staleAttempt?.metadata.retryAfterAt).toBeTruthy();
    const staleTransfer = await getDb(env)
      .prepare("SELECT status, error, signature FROM payment_transfers WHERE id = ?")
      .bind(transferId)
      .first<{ status: string; error: string | null; signature: string | null }>();
    expect(staleTransfer).toMatchObject({
      status: "failed",
      signature: null,
    });
    expect(staleTransfer?.error).toContain("interrupted before submission");
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
  });

  it("does not fail fresh transferless recurring payment attempts during recovery", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      { method: "POST", headers },
      env
    );
    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: { recurringPayment: { subscriptionId: string } };
    };
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const attemptId = `psca_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, recurringPaymentId)
      .run();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activateBody.data.recurringPayment.subscriptionId)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_collection_attempts (
           id,
           organization_id,
           project_id,
           subscription_id,
           transfer_id,
           token,
           amount,
           due_at,
           attempted_at,
           status,
           signature,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        activateBody.data.recurringPayment.subscriptionId,
        DEVNET_USDC_MINT,
        "25.00",
        dueAt,
        now,
        "processing",
        JSON.stringify({ recurringPaymentId }),
        now,
        now
      )
      .run();

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      { method: "POST", headers },
      env
    );

    expect(collectRes.status).toBe(409);
    const attempt = await getDb(env)
      .prepare(
        `SELECT status, transfer_id, error
           FROM payment_subscription_collection_attempts
          WHERE id = ?`
      )
      .bind(attemptId)
      .first<{ status: string; transfer_id: string | null; error: string | null }>();
    expect(attempt).toMatchObject({
      status: "processing",
      transfer_id: null,
      error: null,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("does not fail fresh unsigned recurring payment transfers during recovery", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      { method: "POST", headers },
      env
    );
    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: { recurringPayment: { subscriptionId: string } };
    };
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const transferId = `xfr_${crypto.randomUUID()}`;
    const attemptId = `psca_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, recurringPaymentId)
      .run();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activateBody.data.recurringPayment.subscriptionId)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id,
           organization_id,
           project_id,
           wallet_id,
           counterparty_id,
           source_address,
           destination_address,
           token,
           amount,
           memo,
           type,
           direction,
           status,
           provider_data,
           signature,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, (SELECT counterparty_id FROM payment_recurring_payments WHERE id = ?), ?, ?, ?, ?, NULL, ?, ?, ?, ?::jsonb, NULL, ?, ?)`
      )
      .bind(
        transferId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        recurringPaymentId,
        sourceSigner.address,
        TEST_SOLANA_ADDRESSES.wallet2,
        DEVNET_USDC_MINT,
        "25.00",
        "transfer",
        "outbound",
        "processing",
        JSON.stringify({
          recurringPaymentId,
          subscriptionId: activateBody.data.recurringPayment.subscriptionId,
          collectionDueAt: dueAt,
        }),
        now,
        now
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_collection_attempts (
           id,
           organization_id,
           project_id,
           subscription_id,
           transfer_id,
           token,
           amount,
           due_at,
           attempted_at,
           status,
           signature,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        activateBody.data.recurringPayment.subscriptionId,
        transferId,
        DEVNET_USDC_MINT,
        "25.00",
        dueAt,
        now,
        "processing",
        JSON.stringify({ recurringPaymentId }),
        now,
        now
      )
      .run();

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      { method: "POST", headers },
      env
    );

    expect(collectRes.status).toBe(409);
    const attempt = await getDb(env)
      .prepare(
        `SELECT status, signature, error
           FROM payment_subscription_collection_attempts
          WHERE id = ?`
      )
      .bind(attemptId)
      .first<{ status: string; signature: string | null; error: string | null }>();
    expect(attempt).toMatchObject({
      status: "processing",
      signature: null,
      error: null,
    });
    const transfer = await getDb(env)
      .prepare("SELECT status, signature, error FROM payment_transfers WHERE id = ?")
      .bind(transferId)
      .first<{ status: string; signature: string | null; error: string | null }>();
    expect(transfer).toMatchObject({
      status: "processing",
      signature: null,
      error: null,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("journals failed recovered recurring payment collection attempts and allows retry", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const submittedSignature =
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13" as Signature;
    const retrySignature =
      "4rNhfL5s9hQfCjVxrTQDAZECJ5M99kzF8JRgWEzZEijj73D4Jsiz82cgwxUc71vWR9NBdk2zX9qQREx9UvP4QREe" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      )
      .mockResolvedValueOnce(retrySignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      { method: "POST", headers },
      env
    );
    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: { recurringPayment: { subscriptionId: string } };
    };
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const transferId = `xfr_${crypto.randomUUID()}`;
    const attemptId = `psca_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, recurringPaymentId)
      .run();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activateBody.data.recurringPayment.subscriptionId)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id,
           organization_id,
           project_id,
           wallet_id,
           counterparty_id,
           source_address,
           destination_address,
           token,
           amount,
           memo,
           type,
           direction,
           status,
           provider_data,
           signature,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, (SELECT counterparty_id FROM payment_recurring_payments WHERE id = ?), ?, ?, ?, ?, NULL, ?, ?, ?, ?::jsonb, ?, ?, ?)`
      )
      .bind(
        transferId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        recurringPaymentId,
        sourceSigner.address,
        TEST_SOLANA_ADDRESSES.wallet2,
        DEVNET_USDC_MINT,
        "25.00",
        "transfer",
        "outbound",
        "processing",
        JSON.stringify({
          recurringPaymentId,
          subscriptionId: activateBody.data.recurringPayment.subscriptionId,
          collectionDueAt: dueAt,
        }),
        submittedSignature,
        now,
        now
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_collection_attempts (
           id,
           organization_id,
           project_id,
           subscription_id,
           transfer_id,
           token,
           amount,
           due_at,
           attempted_at,
           status,
           signature,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        activateBody.data.recurringPayment.subscriptionId,
        transferId,
        DEVNET_USDC_MINT,
        "25.00",
        dueAt,
        now,
        "processing",
        submittedSignature,
        JSON.stringify({ recurringPaymentId }),
        now,
        now
      )
      .run();
    confirmTransactionMock.mockImplementation(async (_rpc, signature) => ({
      signature,
      slot: 101n,
      confirmationStatus: "confirmed",
      err: signature === submittedSignature ? { InstructionError: [0, "Custom"] } : null,
    }));

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      { method: "POST", headers },
      env
    );

    expect(collectRes.status).toBe(200);
    const collectBody = (await collectRes.json()) as {
      data: {
        collectionAttempt: { id: string; status: string; signature: string };
        transfer: { status: string; signature: string };
      };
    };
    const failedAttempt = await getDb(env)
      .prepare(
        `SELECT status, error, metadata
           FROM payment_subscription_collection_attempts
          WHERE id = ?`
      )
      .bind(attemptId)
      .first<{ status: string; error: string | null; metadata: { retryAfterAt?: string } }>();
    expect(failedAttempt?.status).toBe("failed");
    expect(failedAttempt?.error).toContain("collection failed on-chain");
    expect(failedAttempt?.metadata.retryAfterAt).toBeTruthy();
    const failedTransfer = await getDb(env)
      .prepare("SELECT status, error, signature FROM payment_transfers WHERE id = ?")
      .bind(transferId)
      .first<{ status: string; error: string | null; signature: string | null }>();
    expect(failedTransfer).toMatchObject({
      status: "failed",
      signature: submittedSignature,
    });
    expect(failedTransfer?.error).toContain("collection failed on-chain");
    expect(collectBody.data.collectionAttempt).toMatchObject({
      status: "confirmed",
      signature: retrySignature,
    });
    expect(collectBody.data.collectionAttempt.id).not.toBe(attemptId);
    expect(collectBody.data.transfer).toMatchObject({
      status: "confirmed",
      signature: retrySignature,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
  });

  it("recovers confirmed collection transfers without reopening the due period", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const submittedSignature =
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      { method: "POST", headers },
      env
    );
    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: { recurringPayment: { subscriptionId: string } };
    };
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const transferId = `xfr_${crypto.randomUUID()}`;
    const attemptId = `psca_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, recurringPaymentId)
      .run();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activateBody.data.recurringPayment.subscriptionId)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id,
           organization_id,
           project_id,
           wallet_id,
           counterparty_id,
           source_address,
           destination_address,
           token,
           amount,
           memo,
           type,
           direction,
           status,
           provider_data,
           signature,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, (SELECT counterparty_id FROM payment_recurring_payments WHERE id = ?), ?, ?, ?, ?, NULL, ?, ?, ?, ?::jsonb, ?, ?, ?)`
      )
      .bind(
        transferId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        recurringPaymentId,
        sourceSigner.address,
        TEST_SOLANA_ADDRESSES.wallet2,
        DEVNET_USDC_MINT,
        "25.00",
        "transfer",
        "outbound",
        "confirmed",
        JSON.stringify({
          recurringPaymentId,
          subscriptionId: activateBody.data.recurringPayment.subscriptionId,
          collectionDueAt: dueAt,
        }),
        submittedSignature,
        now,
        now
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_collection_attempts (
           id,
           organization_id,
           project_id,
           subscription_id,
           transfer_id,
           token,
           amount,
           due_at,
           attempted_at,
           status,
           signature,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        activateBody.data.recurringPayment.subscriptionId,
        transferId,
        DEVNET_USDC_MINT,
        "25.00",
        dueAt,
        now,
        "processing",
        submittedSignature,
        JSON.stringify({ recurringPaymentId }),
        now,
        now
      )
      .run();
    confirmTransactionMock.mockRejectedValue(
      new Error("Transaction history expired from the status cache")
    );
    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      { method: "POST", headers },
      env
    );

    expect(collectRes.status).toBe(200);
    const collectBody = (await collectRes.json()) as {
      data: {
        recurringPayment: { nextCollectionDueAt: string };
        collectionAttempt: { id: string; status: string; signature: string };
        transfer: { id: string; status: string; signature: string };
      };
    };
    expect(collectBody.data.collectionAttempt).toMatchObject({
      id: attemptId,
      status: "confirmed",
      signature: submittedSignature,
    });
    expect(collectBody.data.transfer).toMatchObject({
      id: transferId,
      status: "confirmed",
      signature: submittedSignature,
    });
    expect(new Date(collectBody.data.recurringPayment.nextCollectionDueAt).getTime()).toBe(
      new Date(dueAt).getTime() + 24 * 60 * 60 * 1000
    );
    expect(confirmTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      submittedSignature,
      expect.objectContaining({ commitment: "confirmed" })
    );
    const attempt = await getDb(env)
      .prepare("SELECT status, error FROM payment_subscription_collection_attempts WHERE id = ?")
      .bind(attemptId)
      .first<{ status: string; error: string | null }>();
    expect(attempt).toMatchObject({ status: "confirmed", error: null });
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("rejects early recurring payment collection", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      { method: "POST", headers },
      env
    );
    expect(activateRes.status).toBe(200);

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      { method: "POST", headers },
      env
    );

    expect(collectRes.status).toBe(400);
    const collectBody = (await collectRes.json()) as { error: { message: string } };
    expect(collectBody.error.message).toContain("not due yet");
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
    const attempts = await getDb(env)
      .prepare("SELECT id FROM payment_subscription_collection_attempts")
      .all<{ id: string }>();
    expect(attempts.results).toHaveLength(0);
  });

  it("journals failed pre-submission recurring payment collection attempts", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      { method: "POST", headers },
      env
    );
    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: { recurringPayment: { subscriptionId: string } };
    };
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, recurringPaymentId)
      .run();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activateBody.data.recurringPayment.subscriptionId)
      .run();
    createOrgSignerMock.mockRejectedValueOnce(new Error("collection signer unavailable"));

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      { method: "POST", headers },
      env
    );

    expect(collectRes.status).toBe(500);
    const attempts = await getDb(env)
      .prepare(
        `SELECT status, error, metadata, transfer_id
           FROM payment_subscription_collection_attempts
          WHERE subscription_id = ?`
      )
      .bind(activateBody.data.recurringPayment.subscriptionId)
      .all<{
        status: string;
        error: string | null;
        metadata: { retryAfterAt?: string };
        transfer_id: string | null;
      }>();
    expect(attempts.results[0]?.status).toBe("failed");
    expect(attempts.results[0]?.error).toContain("collection signer unavailable");
    expect(attempts.results[0]?.metadata.retryAfterAt).toBeTruthy();
    expect(attempts.results[0]?.transfer_id).toMatch(/^xfr_/);
    const transfer = await getDb(env)
      .prepare("SELECT status, error, signature FROM payment_transfers WHERE id = ?")
      .bind(attempts.results[0]?.transfer_id)
      .first<{ status: string; error: string | null; signature: string | null }>();
    expect(transfer).toMatchObject({
      status: "failed",
      signature: null,
    });
    expect(transfer?.error).toContain("collection signer unavailable");
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("journals failed activation attempts and allows activation retry", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock
      .mockRejectedValueOnce(new Error("signer temporarily unavailable"))
      .mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const counterpartyId = await seedCounterparty({
      externalId: "recurring_activation_recovery_counterparty",
    });
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const createRes = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          sourceWalletId: TEST_WALLET_ID,
          counterpartyId,
          counterpartyAccountId,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 24,
        }),
      },
      env
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      data: { recurringPayment: { id: string } };
    };

    const failedRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      { method: "POST", headers },
      env
    );

    expect(failedRes.status).toBe(500);
    const getAfterFailureRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    expect(getAfterFailureRes.status).toBe(200);
    const getAfterFailureBody = (await getAfterFailureRes.json()) as {
      data: { recurringPayment: { status: string } };
    };
    expect(getAfterFailureBody.data.recurringPayment.status).toBe("pending_activation");

    const attempts = await getDb(env)
      .prepare(
        `SELECT status, stage, error
           FROM payment_recurring_payment_activation_attempts
          WHERE recurring_payment_id = ?
          ORDER BY created_at DESC`
      )
      .bind(createBody.data.recurringPayment.id)
      .all<{ status: string; stage: string; error: string | null }>();
    expect(attempts.results[0]).toMatchObject({
      status: "failed",
      stage: "create_plan",
    });
    expect(attempts.results[0]?.error).toContain("signer temporarily unavailable");

    const retryRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      { method: "POST", headers },
      env
    );

    expect(retryRes.status).toBe(200);
    const retryBody = (await retryRes.json()) as {
      data: { recurringPayment: { status: string } };
    };
    expect(retryBody.data.recurringPayment.status).toBe("active");
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("recovers stale activating recurring payments without recreating the plan", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const authorizationSignature =
      "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature;
    const signAndSendMock = vi.fn().mockResolvedValue(authorizationSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const counterpartyId = await seedCounterparty({
      externalId: "recurring_activation_stale_counterparty",
    });
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const createRes = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          sourceWalletId: TEST_WALLET_ID,
          counterpartyId,
          counterpartyAccountId,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 24,
        }),
      },
      env
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      data: { recurringPayment: { id: string } };
    };
    const planId = `psp_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_plans (
           id,
           organization_id,
           project_id,
           owner_wallet_id,
           owner_address,
           token,
           amount,
           period_hours,
           program_plan_id,
           status,
           created_by,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        planId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        sourceSigner.address,
        DEVNET_USDC_MINT,
        "25.00",
        24,
        "1001",
        "active",
        TEST_USER.id,
        now,
        now
      )
      .run();
    await getDb(env)
      .prepare(
        `UPDATE payment_recurring_payments
            SET status = 'activating',
                plan_id = ?,
                plan_created_at = ?,
                plan_creation_signature = ?,
                updated_at = ?
          WHERE id = ?`
      )
      .bind(
        planId,
        "1770000000",
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy",
        now,
        createBody.data.recurringPayment.id
      )
      .run();
    const attemptId = `prpa_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_payment_activation_attempts (
           id,
           organization_id,
           project_id,
           recurring_payment_id,
           status,
           stage,
           plan_creation_signature,
           authorization_signature,
           error,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        createBody.data.recurringPayment.id,
        "processing",
        "create_plan",
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy",
        null,
        null,
        "{}",
        now,
        now
      )
      .run();

    const freshRetryRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      { method: "POST", headers },
      env
    );
    expect(freshRetryRes.status).toBe(409);

    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET updated_at = ? WHERE id = ?")
      .bind(
        new Date(Date.now() - 16 * 60 * 1000).toISOString(),
        createBody.data.recurringPayment.id
      )
      .run();

    const staleRetryRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      { method: "POST", headers },
      env
    );

    expect(staleRetryRes.status).toBe(200);
    const staleRetryBody = (await staleRetryRes.json()) as {
      data: { recurringPayment: { status: string; authorizationSignature: string } };
    };
    expect(staleRetryBody.data.recurringPayment).toMatchObject({
      status: "active",
      authorizationSignature,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(1);
    const recoveredAttempts = await getDb(env)
      .prepare(
        `SELECT id, status, stage, plan_creation_signature, authorization_signature
           FROM payment_recurring_payment_activation_attempts
          WHERE recurring_payment_id = ?
          ORDER BY created_at DESC`
      )
      .bind(createBody.data.recurringPayment.id)
      .all<{
        id: string;
        status: string;
        stage: string;
        plan_creation_signature: string | null;
        authorization_signature: string | null;
      }>();
    expect(recoveredAttempts.results).toHaveLength(1);
    expect(recoveredAttempts.results[0]).toMatchObject({
      id: attemptId,
      status: "confirmed",
      stage: "finalize",
      authorization_signature: authorizationSignature,
    });
  });

  it("recovers stale authorized recurring payments without re-confirming old signatures", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    confirmTransactionMock.mockRejectedValue(new Error("transaction history expired"));
    const signAndSendMock = vi.fn();
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const counterpartyId = await seedCounterparty({
      externalId: `recurring_activation_authorized_stale_${crypto.randomUUID()}`,
    });
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const createRes = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          sourceWalletId: TEST_WALLET_ID,
          counterpartyId,
          counterpartyAccountId,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 24,
        }),
      },
      env
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      data: { recurringPayment: { id: string } };
    };
    const planId = `psp_${crypto.randomUUID()}`;
    const subscriptionId = `psub_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const staleUpdatedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const planCreationSignature =
      "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature;
    const authorizationSignature =
      "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature;

    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_plans (
           id,
           organization_id,
           project_id,
           owner_wallet_id,
           owner_address,
           token,
           amount,
           period_hours,
           program_plan_id,
           status,
           created_by,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        planId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        sourceSigner.address,
        DEVNET_USDC_MINT,
        "25.00",
        24,
        "1002",
        "active",
        TEST_USER.id,
        now,
        now
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscriptions (
           id,
           organization_id,
           project_id,
           plan_id,
           counterparty_id,
           subscriber_address,
           authorization_signature,
           status,
           created_by,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        subscriptionId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        planId,
        counterpartyId,
        sourceSigner.address,
        authorizationSignature,
        "pending_authorization",
        TEST_USER.id,
        now,
        now
      )
      .run();
    await getDb(env)
      .prepare(
        `UPDATE payment_recurring_payments
            SET status = 'activating',
                plan_id = ?,
                subscription_id = ?,
                plan_created_at = ?,
                plan_creation_signature = ?,
                authorization_signature = ?,
                updated_at = ?
          WHERE id = ?`
      )
      .bind(
        planId,
        subscriptionId,
        "1770000000",
        planCreationSignature,
        authorizationSignature,
        staleUpdatedAt,
        createBody.data.recurringPayment.id
      )
      .run();

    const staleRetryRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      { method: "POST", headers },
      env
    );

    expect(staleRetryRes.status).toBe(200);
    const staleRetryBody = (await staleRetryRes.json()) as {
      data: { recurringPayment: { status: string; authorizationSignature: string } };
    };
    expect(staleRetryBody.data.recurringPayment).toMatchObject({
      status: "active",
      authorizationSignature,
    });
    expect(confirmTransactionMock).not.toHaveBeenCalled();
    expect(signAndSendMock).not.toHaveBeenCalled();
  });

  it("journals failed on-chain activation attempts and retries with a fresh signature", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    mockDistinctRecentBlockhashes();
    const failedPlanSignature =
      "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature;
    const retryPlanSignature =
      "3eWxmHfS3EPf7nmtdDQ6CTwWqCnX2bAdtc9h1kReBLbqjP99kphnf3UhpSGA8qpmkHxnhqsWyVbRoQY2yagRZkzp" as Signature;
    const authorizationSignature =
      "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(failedPlanSignature)
      .mockResolvedValueOnce(retryPlanSignature)
      .mockResolvedValueOnce(authorizationSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    confirmTransactionMock
      .mockResolvedValueOnce({
        signature: failedPlanSignature,
        slot: 100n,
        confirmationStatus: "confirmed",
        err: { InstructionError: [0, "Custom"] },
      } as Awaited<ReturnType<typeof solanaRpc.confirmTransaction>>)
      .mockResolvedValue({
        signature: retryPlanSignature,
        slot: 101n,
        confirmationStatus: "confirmed",
        err: null,
      } as Awaited<ReturnType<typeof solanaRpc.confirmTransaction>>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const counterpartyId = await seedCounterparty({
      externalId: "recurring_activation_onchain_failure_counterparty",
    });
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const createRes = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          sourceWalletId: TEST_WALLET_ID,
          counterpartyId,
          counterpartyAccountId,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 24,
        }),
      },
      env
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      data: { recurringPayment: { id: string } };
    };

    const failedRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      { method: "POST", headers },
      env
    );

    expect(failedRes.status).toBe(400);
    const getAfterFailureRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    const getAfterFailureBody = (await getAfterFailureRes.json()) as {
      data: { recurringPayment: { status: string; planCreationSignature: string | null } };
    };
    expect(getAfterFailureBody.data.recurringPayment).toMatchObject({
      status: "pending_activation",
      planCreationSignature: null,
    });

    const attempts = await getDb(env)
      .prepare(
        `SELECT status, stage, error
           FROM payment_recurring_payment_activation_attempts
          WHERE recurring_payment_id = ?
          ORDER BY created_at DESC`
      )
      .bind(createBody.data.recurringPayment.id)
      .all<{ status: string; stage: string; error: string | null }>();
    expect(attempts.results[0]).toMatchObject({
      status: "failed",
      stage: "create_plan",
      error: "Recurring payment activation failed on-chain",
    });

    const retryRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      { method: "POST", headers },
      env
    );

    expect(retryRes.status).toBe(200);
    const retryBody = (await retryRes.json()) as {
      data: { recurringPayment: { status: string; planCreationSignature: string } };
    };
    expect(retryBody.data.recurringPayment).toMatchObject({
      status: "active",
      planCreationSignature: retryPlanSignature,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
  });

  it("clears failed authorization signatures when finalization cannot find the subscription", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    mockDistinctRecentBlockhashes();
    fetchMaybeSubscriptionDelegationMock
      .mockResolvedValueOnce({
        exists: false,
        address: address(TEST_SOLANA_ADDRESSES.wallet3),
      } as Awaited<ReturnType<typeof subscriptionsProgram.fetchMaybeSubscriptionDelegation>>)
      .mockResolvedValue({
        exists: true,
        address: address(TEST_SOLANA_ADDRESSES.wallet3),
        data: {},
      } as Awaited<ReturnType<typeof subscriptionsProgram.fetchMaybeSubscriptionDelegation>>);
    const planSignature =
      "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature;
    const failedAuthorizationSignature =
      "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature;
    const retryAuthorizationSignature =
      "3eWxmHfS3EPf7nmtdDQ6CTwWqCnX2bAdtc9h1kReBLbqjP99kphnf3UhpSGA8qpmkHxnhqsWyVbRoQY2yagRZkzp" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(planSignature)
      .mockResolvedValueOnce(failedAuthorizationSignature)
      .mockResolvedValueOnce(retryAuthorizationSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const counterpartyId = await seedCounterparty({
      externalId: "recurring_activation_missing_delegation_counterparty",
    });
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const createRes = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          sourceWalletId: TEST_WALLET_ID,
          counterpartyId,
          counterpartyAccountId,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 24,
        }),
      },
      env
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      data: { recurringPayment: { id: string } };
    };

    const failedRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      { method: "POST", headers },
      env
    );

    expect(failedRes.status).toBe(400);
    const getAfterFailureRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    const getAfterFailureBody = (await getAfterFailureRes.json()) as {
      data: {
        recurringPayment: {
          status: string;
          planCreationSignature: string | null;
          authorizationSignature: string | null;
        };
      };
    };
    expect(getAfterFailureBody.data.recurringPayment).toMatchObject({
      status: "pending_activation",
      planCreationSignature: planSignature,
      authorizationSignature: null,
    });

    const attempts = await getDb(env)
      .prepare(
        `SELECT status, stage, error
           FROM payment_recurring_payment_activation_attempts
          WHERE recurring_payment_id = ?
          ORDER BY created_at DESC`
      )
      .bind(createBody.data.recurringPayment.id)
      .all<{ status: string; stage: string; error: string | null }>();
    expect(attempts.results[0]).toMatchObject({
      status: "failed",
      stage: "finalize",
      error: "Subscription authorization was not found on-chain",
    });

    const retryRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      { method: "POST", headers },
      env
    );

    expect(retryRes.status).toBe(200);
    const retryBody = (await retryRes.json()) as {
      data: {
        recurringPayment: {
          status: string;
          planCreationSignature: string;
          authorizationSignature: string;
        };
      };
    };
    expect(retryBody.data.recurringPayment).toMatchObject({
      status: "active",
      planCreationSignature: planSignature,
      authorizationSignature: retryAuthorizationSignature,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
  });

  it("requires owner wallet access when updating subscription plans", async () => {
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };

    const planRes = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          ownerWalletId: TEST_WALLET_ID,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 720,
        }),
      },
      env
    );
    expect(planRes.status).toBe(201);
    const planBody = (await planRes.json()) as { data: { subscriptionPlan: { id: string } } };

    await seedCachedKey({
      walletBindings: [{ walletId: "wal_other_wallet", permissions: ["payments:write"] }],
    });

    const updateRes = await app.request(
      `/v1/payments/subscription-plans/${planBody.data.subscriptionPlan.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: "archived" }),
      },
      env
    );

    expect(updateRes.status).toBe(403);
    const updateBody = (await updateRes.json()) as { error: { code: string; message: string } };
    expect(updateBody.error.code).toBe("FORBIDDEN");
    expect(updateBody.error.message).toContain("requested wallet");
  });

  it("rejects archived counterparties when creating subscriptions", async () => {
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };

    const counterpartyRes = await app.request(
      "/v1/counterparties",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          externalId: "subscription_archived_counterparty",
          entityType: "individual",
          displayName: "Archived Subscription Counterparty",
          email: "subscription-archived-counterparty@example.com",
          identity: TEST_COUNTERPARTY_IDENTITY,
        }),
      },
      env
    );
    expect(counterpartyRes.status).toBe(201);
    const counterpartyBody = (await counterpartyRes.json()) as {
      data: { counterparty: { id: string } };
    };

    const planRes = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          ownerWalletId: TEST_WALLET_ID,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 720,
        }),
      },
      env
    );
    expect(planRes.status).toBe(201);
    const planBody = (await planRes.json()) as { data: { subscriptionPlan: { id: string } } };

    const archiveRes = await app.request(
      `/v1/counterparties/${counterpartyBody.data.counterparty.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
      },
      env
    );
    expect(archiveRes.status).toBe(204);

    const subscriptionRes = await app.request(
      "/v1/payments/subscriptions",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          planId: planBody.data.subscriptionPlan.id,
          counterpartyId: counterpartyBody.data.counterparty.id,
          subscriberAddress: TEST_SOLANA_ADDRESSES.wallet2,
        }),
      },
      env
    );

    expect(subscriptionRes.status).toBe(404);
    const subscriptionBody = (await subscriptionRes.json()) as {
      error: { code: string; message: string };
    };
    expect(subscriptionBody.error.code).toBe("NOT_FOUND");
    expect(subscriptionBody.error.message).toContain("Counterparty not found");
  });

  it("does not expose client-controlled subscription or collection-attempt state", async () => {
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };

    const counterpartyRes = await app.request(
      "/v1/counterparties",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          externalId: "subscription_wallet_scope_counterparty",
          entityType: "individual",
          displayName: "Wallet Scope Subscription Counterparty",
          email: "subscription-wallet-scope-counterparty@example.com",
          identity: TEST_COUNTERPARTY_IDENTITY,
        }),
      },
      env
    );
    expect(counterpartyRes.status).toBe(201);
    const counterpartyBody = (await counterpartyRes.json()) as {
      data: { counterparty: { id: string } };
    };

    const planRes = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          ownerWalletId: TEST_WALLET_ID,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 720,
          status: "active",
        }),
      },
      env
    );
    expect(planRes.status).toBe(201);
    const planBody = (await planRes.json()) as { data: { subscriptionPlan: { id: string } } };

    const forgedSubscriptionRes = await app.request(
      "/v1/payments/subscriptions",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          planId: planBody.data.subscriptionPlan.id,
          counterpartyId: counterpartyBody.data.counterparty.id,
          subscriberAddress: TEST_SOLANA_ADDRESSES.wallet2,
          authorizationSignature: "client-controlled-signature",
          nextCollectionDueAt: new Date().toISOString(),
          status: "active",
        }),
      },
      env
    );
    expect(forgedSubscriptionRes.status).toBe(400);

    const subscriptionRes = await app.request(
      "/v1/payments/subscriptions",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          planId: planBody.data.subscriptionPlan.id,
          counterpartyId: counterpartyBody.data.counterparty.id,
          subscriberAddress: TEST_SOLANA_ADDRESSES.wallet2,
        }),
      },
      env
    );
    expect(subscriptionRes.status).toBe(201);
    const subscriptionBody = (await subscriptionRes.json()) as {
      data: { subscription: { id: string } };
    };

    const updateSubscriptionRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionBody.data.subscription.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: "paused" }),
      },
      env
    );
    expect(updateSubscriptionRes.status).toBe(404);

    const attemptRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionBody.data.subscription.id}/collection-attempts`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ status: "processing" }),
      },
      env
    );
    expect(attemptRes.status).toBe(404);
  });

  it("exercises the recurring subscription lifecycle through SDP API routes", async () => {
    const authHeaders = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
    };
    const jsonHeaders = {
      ...authHeaders,
      "Content-Type": "application/json",
    };
    const subscriberTokenAccount = TEST_SOLANA_ADDRESSES.wallet3;
    const currentPeriodStartAt = "2026-01-01T00:00:00.000Z";
    const nextCollectionDueAt = "2026-02-01T00:00:00.000Z";

    const counterpartyRes = await app.request(
      "/v1/counterparties",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          externalId: "subscription_counterparty_001",
          entityType: "individual",
          displayName: "Subscription API Counterparty",
          email: "subscription-counterparty@example.com",
          identity: TEST_COUNTERPARTY_IDENTITY,
        }),
      },
      env
    );

    expect(counterpartyRes.status).toBe(201);
    const counterpartyBody = (await counterpartyRes.json()) as {
      data: { counterparty: { id: string; status: string } };
    };
    const counterpartyId = counterpartyBody.data.counterparty.id;
    expect(counterpartyBody.data.counterparty.status).toBe("active");

    const planRes = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          ownerWalletId: TEST_WALLET_ID,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 720,
          destinationAddress: TEST_SOLANA_ADDRESSES.wallet3,
          metadataUri: "https://sdp.dev/plan.json",
        }),
      },
      env
    );

    expect(planRes.status).toBe(201);
    const planBody = (await planRes.json()) as {
      data: {
        subscriptionPlan: {
          id: string;
          ownerWalletId: string;
          ownerAddress: string;
          amount: string;
          periodHours: number;
          programPlanId: string;
          planPda: string | null;
          status: string;
          metadataUri: string | null;
        };
      };
    };
    const planId = planBody.data.subscriptionPlan.id;
    expect(planBody.data.subscriptionPlan).toMatchObject({
      ownerWalletId: TEST_WALLET_ID,
      ownerAddress: TEST_SOLANA_ADDRESSES.wallet1,
      amount: "25.00",
      periodHours: 720,
      status: "draft",
      metadataUri: "https://sdp.dev/plan.json",
    });
    expect(planBody.data.subscriptionPlan.programPlanId).toMatch(/^\d+$/);

    const duplicatePlanRes = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          ownerWalletId: TEST_WALLET_ID,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 720,
          programPlanId: planBody.data.subscriptionPlan.programPlanId,
        }),
      },
      env
    );
    expect(duplicatePlanRes.status).toBe(409);

    const draftPlansRes = await app.request(
      "/v1/payments/subscription-plans?status=draft",
      {
        headers: authHeaders,
      },
      env
    );

    expect(draftPlansRes.status).toBe(200);
    const draftPlansBody = (await draftPlansRes.json()) as {
      data: { subscriptionPlans: Array<{ id: string }>; total: number };
    };
    expect(draftPlansBody.data.subscriptionPlans.map((plan) => plan.id)).toContain(planId);
    expect(draftPlansBody.data.total).toBe(1);

    const updatePlanRes = await app.request(
      `/v1/payments/subscription-plans/${planId}`,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({
          metadataUri: "https://sdp.dev/plan-active.json",
          pullerWalletId: TEST_WALLET_ID,
          status: "active",
        }),
      },
      env
    );

    expect(updatePlanRes.status).toBe(200);
    const updatePlanBody = (await updatePlanRes.json()) as {
      data: {
        subscriptionPlan: {
          id: string;
          pullerWalletId: string | null;
          pullerAddress: string | null;
          metadataUri: string | null;
          status: string;
        };
      };
    };
    expect(updatePlanBody.data.subscriptionPlan).toMatchObject({
      id: planId,
      pullerWalletId: TEST_WALLET_ID,
      pullerAddress: TEST_SOLANA_ADDRESSES.wallet1,
      metadataUri: "https://sdp.dev/plan-active.json",
      status: "active",
    });

    const getPlanRes = await app.request(
      `/v1/payments/subscription-plans/${planId}`,
      {
        headers: authHeaders,
      },
      env
    );

    expect(getPlanRes.status).toBe(200);
    const getPlanBody = (await getPlanRes.json()) as {
      data: { subscriptionPlan: { id: string; status: string } };
    };
    expect(getPlanBody.data.subscriptionPlan).toMatchObject({
      id: planId,
      status: "active",
    });

    mockTokenSupplyDecimalsOnce();
    const preparePlanRes = await app.request(
      `/v1/payments/subscription-plans/${planId}/prepare-create`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          destinations: [TEST_SOLANA_ADDRESSES.wallet3],
          endTs: "1770000000",
          metadataUri: "https://sdp.dev/plan-chain.json",
          pullers: [TEST_SOLANA_ADDRESSES.wallet1],
        }),
      },
      env
    );

    expect(preparePlanRes.status).toBe(200);
    const preparePlanBody = (await preparePlanRes.json()) as {
      data: {
        planPda: string;
        subscriptionPlan: { id: string; planPda: string | null };
        preparedTransaction: {
          serialized: string;
          blockhash: string;
          lastValidBlockHeight: string;
          requiredSigners: string[];
        };
      };
    };
    expect(preparePlanBody.data.planPda).toBeTruthy();
    expect(preparePlanBody.data.subscriptionPlan.id).toBe(planId);
    expect(preparePlanBody.data.subscriptionPlan.planPda).toBe(preparePlanBody.data.planPda);
    expectPreparedSubscriptionTransaction(preparePlanBody.data.preparedTransaction, [
      TEST_SOLANA_ADDRESSES.wallet1,
      "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv",
    ]);

    const activePlansRes = await app.request(
      "/v1/payments/subscription-plans?status=active",
      {
        headers: authHeaders,
      },
      env
    );

    expect(activePlansRes.status).toBe(200);
    const activePlansBody = (await activePlansRes.json()) as {
      data: { subscriptionPlans: Array<{ id: string; planPda: string | null }>; total: number };
    };
    expect(activePlansBody.data.subscriptionPlans).toContainEqual(
      expect.objectContaining({ id: planId, planPda: preparePlanBody.data.planPda })
    );

    const subscriptionRes = await app.request(
      "/v1/payments/subscriptions",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          planId,
          counterpartyId,
          subscriberAddress: TEST_SOLANA_ADDRESSES.wallet2,
        }),
      },
      env
    );

    expect(subscriptionRes.status).toBe(201);
    const subscriptionBody = (await subscriptionRes.json()) as {
      data: {
        subscription: {
          id: string;
          planId: string;
          counterpartyId: string;
          subscriberAddress: string;
          subscriberTokenAccount: string | null;
          subscriptionPda: string | null;
          subscriptionAuthorityAddress: string | null;
          status: string;
          nextCollectionDueAt: string | null;
        };
      };
    };
    const subscriptionId = subscriptionBody.data.subscription.id;
    expect(subscriptionBody.data.subscription).toMatchObject({
      planId,
      counterpartyId,
      subscriberAddress: TEST_SOLANA_ADDRESSES.wallet2,
      subscriberTokenAccount: null,
      subscriptionPda: null,
      subscriptionAuthorityAddress: null,
      status: "pending_authorization",
    });
    expect(subscriptionBody.data.subscription.nextCollectionDueAt).toBeNull();

    const listSubscriptionsRes = await app.request(
      `/v1/payments/subscriptions?planId=${planId}&counterpartyId=${counterpartyId}&status=pending_authorization`,
      {
        headers: authHeaders,
      },
      env
    );

    expect(listSubscriptionsRes.status).toBe(200);
    const listSubscriptionsBody = (await listSubscriptionsRes.json()) as {
      data: { subscriptions: Array<{ id: string }>; total: number };
    };
    expect(listSubscriptionsBody.data.subscriptions.map((subscription) => subscription.id)).toEqual(
      [subscriptionId]
    );
    expect(listSubscriptionsBody.data.total).toBe(1);

    const getSubscriptionRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}`,
      {
        headers: authHeaders,
      },
      env
    );

    expect(getSubscriptionRes.status).toBe(200);
    const getSubscriptionBody = (await getSubscriptionRes.json()) as {
      data: { subscription: { id: string; status: string } };
    };
    expect(getSubscriptionBody.data.subscription).toMatchObject({
      id: subscriptionId,
      status: "pending_authorization",
    });

    mockTokenSupplyDecimalsOnce();
    const prepareAuthorizationRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/prepare-authorization`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          expectedSubscriptionAuthorityInitId: "0",
          subscriberTokenAccount,
          expectedPlanCreatedAt: "1700000000",
        }),
      },
      env
    );

    expect(prepareAuthorizationRes.status).toBe(200);
    const prepareAuthorizationBody = (await prepareAuthorizationRes.json()) as {
      data: {
        subscriptionAuthorityAddress: string;
        subscriptionPda: string;
        subscription: {
          id: string;
          subscriberTokenAccount: string | null;
          subscriptionAuthorityAddress: string | null;
          subscriptionPda: string | null;
        };
        preparedTransaction: {
          serialized: string;
          blockhash: string;
          lastValidBlockHeight: string;
          requiredSigners: string[];
        };
      };
    };
    expect(prepareAuthorizationBody.data.subscription).toMatchObject({
      id: subscriptionId,
      subscriberTokenAccount,
      subscriptionAuthorityAddress: prepareAuthorizationBody.data.subscriptionAuthorityAddress,
      subscriptionPda: prepareAuthorizationBody.data.subscriptionPda,
    });
    expectPreparedSubscriptionTransaction(prepareAuthorizationBody.data.preparedTransaction, [
      TEST_SOLANA_ADDRESSES.wallet2,
      "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv",
    ]);

    const activateSubscriptionRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}`,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({
          authorizationSignature: "sig_subscription_authorization_test",
          currentPeriodStartAt,
          nextCollectionDueAt,
          status: "active",
        }),
      },
      env
    );

    expect(activateSubscriptionRes.status).toBe(404);
    await getDb(env)
      .prepare(
        `UPDATE payment_subscriptions
            SET authorization_signature = ?,
                current_period_start_at = ?,
                next_collection_due_at = ?,
                status = 'active'
          WHERE id = ?`
      )
      .bind(
        "sig_subscription_authorization_test",
        currentPeriodStartAt,
        nextCollectionDueAt,
        subscriptionId
      )
      .run();

    const dueSubscriptionsRes = await app.request(
      `/v1/payments/subscriptions?status=active&dueBefore=${encodeURIComponent("2026-02-02T00:00:00.000Z")}`,
      {
        headers: authHeaders,
      },
      env
    );

    expect(dueSubscriptionsRes.status).toBe(200);
    const dueSubscriptionsBody = (await dueSubscriptionsRes.json()) as {
      data: { subscriptions: Array<{ id: string }>; total: number };
    };
    expect(dueSubscriptionsBody.data.subscriptions.map((subscription) => subscription.id)).toEqual([
      subscriptionId,
    ]);
    expect(dueSubscriptionsBody.data.total).toBe(1);

    const prepareCancelRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/prepare-cancel`,
      {
        method: "POST",
        headers: authHeaders,
      },
      env
    );

    expect(prepareCancelRes.status).toBe(200);
    const prepareCancelBody = (await prepareCancelRes.json()) as {
      data: {
        subscription: { id: string };
        preparedTransaction: {
          serialized: string;
          blockhash: string;
          lastValidBlockHeight: string;
          requiredSigners: string[];
        };
      };
    };
    expect(prepareCancelBody.data.subscription.id).toBe(subscriptionId);
    expectPreparedSubscriptionTransaction(prepareCancelBody.data.preparedTransaction, [
      TEST_SOLANA_ADDRESSES.wallet2,
      "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv",
    ]);

    const prepareResumeRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/prepare-resume`,
      {
        method: "POST",
        headers: authHeaders,
      },
      env
    );

    expect(prepareResumeRes.status).toBe(200);
    const prepareResumeBody = (await prepareResumeRes.json()) as {
      data: {
        subscription: { id: string };
        preparedTransaction: {
          serialized: string;
          blockhash: string;
          lastValidBlockHeight: string;
          requiredSigners: string[];
        };
      };
    };
    expect(prepareResumeBody.data.subscription.id).toBe(subscriptionId);
    expectPreparedSubscriptionTransaction(prepareResumeBody.data.preparedTransaction, [
      TEST_SOLANA_ADDRESSES.wallet2,
      "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv",
    ]);

    const amountOverrideRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/prepare-collection`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          amount: "10.50",
          receiverTokenAccount: TEST_SOLANA_ADDRESSES.wallet3,
        }),
      },
      env
    );
    expect(amountOverrideRes.status).toBe(400);

    mockTokenSupplyDecimalsOnce();
    const prepareCollectionRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/prepare-collection`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ receiverTokenAccount: TEST_SOLANA_ADDRESSES.wallet3 }),
      },
      env
    );

    expect(prepareCollectionRes.status).toBe(200);
    const prepareCollectionBody = (await prepareCollectionRes.json()) as {
      data: {
        subscription: { id: string };
        preparedTransaction: {
          serialized: string;
          blockhash: string;
          lastValidBlockHeight: string;
          requiredSigners: string[];
        };
      };
    };
    expect(prepareCollectionBody.data.subscription.id).toBe(subscriptionId);
    expectPreparedSubscriptionTransaction(prepareCollectionBody.data.preparedTransaction, [
      TEST_SOLANA_ADDRESSES.wallet1,
      "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv",
    ]);

    const attemptRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/collection-attempts`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          amount: "10.50",
          attemptedAt: "2026-02-01T00:01:00.000Z",
          dueAt: nextCollectionDueAt,
          metadata: { source: "api-lifecycle-test" },
          signature: "sig_collection_attempt_test",
          status: "processing",
        }),
      },
      env
    );

    expect(attemptRes.status).toBe(404);

    const attemptsRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/collection-attempts?status=processing`,
      {
        headers: authHeaders,
      },
      env
    );

    expect(attemptsRes.status).toBe(200);
    const attemptsBody = (await attemptsRes.json()) as {
      data: {
        collectionAttempts: Array<{ id: string; subscriptionId: string; status: string }>;
        total: number;
      };
    };
    expect(attemptsBody.data.collectionAttempts).toEqual([]);
    expect(attemptsBody.data.total).toBe(0);
  });
});
