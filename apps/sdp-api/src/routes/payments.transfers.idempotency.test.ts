import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { blockhash, getSignatureFromTransaction, getTransactionDecoder } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import * as paymentsRepository from "@/db/repositories/payments.repository.postgres";
import { app } from "@/index";
import { requestFingerprint } from "@/middleware/idempotency";
import { canonicalizePaymentBody } from "@/routes/payments/fingerprint";
import { walletTransferSchema } from "@/routes/payments/transfers/schemas";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { seedProjectCryptoWalletCounterparty } from "@/test/helpers/counterparties";
import { deferred } from "@/test/helpers/deferred";
import { env } from "@/test/helpers/env";
import { countStoredIdempotencyKeys } from "@/test/helpers/idempotency-records";
import {
  createOrgSignerForCustodyWalletMock,
  getRecentBlockhashMock,
  installPaymentsRouteTestHooks,
  seedCachedKey,
  sendTransactionMock,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_USER,
} from "@/test/helpers/payments-routes";
import {
  countTransferRows,
  postTransfer,
  readErrorResponse,
  readTransferResponse,
  readTransferRow,
} from "@/test/helpers/payments-transfers";

const SOL_TRANSFER = {
  sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
  destination: TEST_SOLANA_ADDRESSES.wallet2,
  token: "SOL",
  amount: "1",
};

describe("Payments routes — transfer idempotency", () => {
  installPaymentsRouteTestHooks();
  installClusterRpcStub();

  it("replays a transfer when the same Idempotency-Key + body is retried", async () => {
    const first = await postTransfer(SOL_TRANSFER, { idempotencyKey: "xfer-key-1" });
    const second = await postTransfer(SOL_TRANSFER, { idempotencyKey: "xfer-key-1" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
    const firstBody = await readTransferResponse(first);
    expect((await readTransferResponse(second)).data).toEqual(firstBody.data);
    expect(sendTransactionMock).toHaveBeenCalledOnce();
    expect(await countTransferRows()).toBe(1);
  });

  it("rejects the same Idempotency-Key with a different body", async () => {
    const first = await postTransfer(SOL_TRANSFER, { idempotencyKey: "xfer-key-2" });
    expect(first.status).toBe(200);

    const conflict = await postTransfer(
      { ...SOL_TRANSFER, amount: "2" },
      { idempotencyKey: "xfer-key-2" }
    );

    expect(conflict.status).toBe(422);
    expect((await readErrorResponse(conflict)).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(sendTransactionMock).toHaveBeenCalledOnce();
    expect(await countTransferRows()).toBe(1);
  });

  it("executes once when two requests race on the same Idempotency-Key", async () => {
    const firstAtSend = deferred<void>();
    const releaseFirst = deferred<void>();
    sendTransactionMock.mockImplementationOnce(async (_rpc, transactionBytes) => {
      firstAtSend.resolve();
      await releaseFirst.promise;
      return getSignatureFromTransaction(getTransactionDecoder().decode(transactionBytes));
    });

    const first = postTransfer(SOL_TRANSFER, { idempotencyKey: "xfer-race-key" });
    await firstAtSend.promise;
    const concurrent = await postTransfer(SOL_TRANSFER, { idempotencyKey: "xfer-race-key" });
    releaseFirst.resolve();
    const winner = await first;

    expect(concurrent.status).toBe(409);
    expect((await readErrorResponse(concurrent)).error.code).toBe("IDEMPOTENCY_KEY_IN_FLIGHT");
    expect(winner.status).toBe(200);
    const retry = await postTransfer(SOL_TRANSFER, { idempotencyKey: "xfer-race-key" });
    expect(retry.status).toBe(200);
    expect(retry.headers.get("Idempotent-Replayed")).toBe("true");
    expect((await readTransferResponse(retry)).data).toEqual(
      (await readTransferResponse(winner)).data
    );
    expect(sendTransactionMock).toHaveBeenCalledOnce();
    expect(await countTransferRows()).toBe(1);
  });

  it("refuses a transfer without an Idempotency-Key before anything runs", async () => {
    const response = await postTransfer(SOL_TRANSFER, { idempotencyKey: null });

    expect(response.status).toBe(400);
    expect((await readErrorResponse(response)).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
    expect(await countTransferRows()).toBe(0);
  });

  it("replays a retry that only re-spells the amount or names the token by its mint", async () => {
    const first = await postTransfer(
      { ...SOL_TRANSFER, token: "SOL", amount: "1.0" },
      { idempotencyKey: "xfer-spelling" }
    );
    expect(first.status).toBe(200);

    const respelled = await postTransfer(
      { ...SOL_TRANSFER, token: SOL_MINT, amount: "1" },
      { idempotencyKey: "xfer-spelling" }
    );

    expect(respelled.status).toBe(200);
    expect(respelled.headers.get("Idempotent-Replayed")).toBe("true");
    expect((await readTransferResponse(respelled)).data).toEqual(
      (await readTransferResponse(first)).data
    );
    expect(sendTransactionMock).toHaveBeenCalledOnce();
    expect(await countTransferRows()).toBe(1);
  });

  it.each(["1", "2"])(
    "checks the previous fingerprint after losing an insert, retry amount %s",
    async (amount) => {
      const key = "pre-rename-insert-race";
      const first = await postTransfer(SOL_TRANSFER, { idempotencyKey: key });
      expect(first.status).toBe(200);
      const original = await readTransferResponse(first);
      const fingerprint = requestFingerprint({
        operation: "POST /v1/payments/transfers",
        params: {},
        query: {},
        body: canonicalizePaymentBody(walletTransferSchema.parse(SOL_TRANSFER)),
      });
      await getDb(env).execute(
        "UPDATE payment_transfers SET idempotency_fingerprint = ? WHERE id = ?",
        [fingerprint, original.data.transfer.id]
      );
      await getDb(env).execute("DELETE FROM idempotency_keys WHERE idempotency_key = ?", [key]);
      // The first lookup misses the winner, which becomes visible at the unique
      // insert conflict. Both insertion and conflict recovery use the real DB.
      const actual = paymentsRepository.createPostgresPaymentsRepository;
      let lookups = 0;
      const factory = vi
        .spyOn(paymentsRepository, "createPostgresPaymentsRepository")
        .mockImplementation((...args) => {
          const repository = actual(...args);
          return {
            ...repository,
            findTransferByIdempotency: async (input) => {
              lookups += 1;
              return lookups === 1 ? null : repository.findTransferByIdempotency(input);
            },
          };
        });
      try {
        const retry = await postTransfer({ ...SOL_TRANSFER, amount }, { idempotencyKey: key });
        if (amount === "1") {
          expect(retry.status).toBe(200);
          expect((await readTransferResponse(retry)).data.transfer.id).toBe(
            original.data.transfer.id
          );
        } else {
          expect(retry.status).toBe(422);
          expect((await readErrorResponse(retry)).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
        }
        expect(lookups).toBe(2);
        expect(await countTransferRows()).toBe(1);
        expect(sendTransactionMock).toHaveBeenCalledOnce();
      } finally {
        factory.mockRestore();
      }
    }
  );

  it("binds the domain row to its credential: past the key record, the same credential replays and another runs as new", async () => {
    const otherKey = {
      id: "key_payments_other",
      raw: "sk_test_payments_other",
      prefix: "sk_test_oth",
    };
    await seedProjectApiKey(getDb(env), env, {
      key: otherKey,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      createdBy: TEST_USER.id,
      grants: ALL_API_KEY_GRANTS,
    });
    const expireKeyRecords = () =>
      getDb(env).execute(
        "UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE idempotency_key = ?",
        ["xfer-shared-key"]
      );

    const first = await postTransfer(SOL_TRANSFER, { idempotencyKey: "xfer-shared-key" });
    expect(first.status).toBe(200);
    const firstBody = await readTransferResponse(first);
    await expireKeyRecords();

    const sameCredential = await postTransfer(SOL_TRANSFER, { idempotencyKey: "xfer-shared-key" });
    expect(sameCredential.status).toBe(200);
    expect(sameCredential.headers.get("Idempotent-Replayed")).toBe("true");
    expect((await readTransferResponse(sameCredential)).data).toEqual(firstBody.data);
    expect(await countTransferRows()).toBe(1);
    await expireKeyRecords();

    // A new transfer signs new bytes: a fresh blockhash keeps its signature distinct.
    getRecentBlockhashMock.mockResolvedValue({
      blockhash: blockhash(TEST_SOLANA_ADDRESSES.wallet3),
      lastValidBlockHeight: 1000n,
    });
    const otherCredential = await postTransfer(SOL_TRANSFER, {
      idempotencyKey: "xfer-shared-key",
      auth: { kind: "api_key", raw: otherKey.raw },
    });
    expect(otherCredential.status).toBe(200);
    expect(otherCredential.headers.get("Idempotent-Replayed")).toBeNull();
    const otherId = (await readTransferResponse(otherCredential)).data.transfer.id;
    expect(otherId).not.toBe(firstBody.data.transfer.id);
    expect((await readTransferRow(firstBody.data.transfer.id)).initiated_by_principal).toEqual({
      kind: "api_key",
      apiKeyId: TEST_API_KEY.id,
    });
    expect((await readTransferRow(otherId)).initiated_by_principal).toEqual({
      kind: "api_key",
      apiKeyId: otherKey.id,
    });
    expect(sendTransactionMock).toHaveBeenCalledTimes(2);
    expect(await countTransferRows()).toBe(2);
  });

  it("replays a transfer to an archived contact account and refuses a new one", async () => {
    const counterpartyId = "cpty_archive_transfer";
    const counterpartyAccountId = "cpacct_archive_transfer";
    await seedProjectCryptoWalletCounterparty(getDb(env), {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      createdBy: TEST_USER.id,
      counterpartyId,
      counterpartyAccountId,
      walletAddress: TEST_SOLANA_ADDRESSES.wallet2,
    });
    const body = { ...SOL_TRANSFER, counterpartyAccountId };
    const first = await postTransfer(body, { idempotencyKey: "before-archive" });
    expect(first.status).toBe(200);
    const original = await readTransferResponse(first);
    const archived = await app.request(
      `/v1/counterparties/${counterpartyId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Idempotency-Key": "archive-contact",
        },
      },
      env
    );
    expect(archived.status).toBe(204);

    const replay = await postTransfer(body, { idempotencyKey: "before-archive" });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect((await readTransferResponse(replay)).data).toEqual(original.data);

    const fresh = await postTransfer(body, { idempotencyKey: "after-archive" });
    expect(fresh.status).toBe(404);
    expect((await readErrorResponse(fresh)).error.code).toBe("NOT_FOUND");
    expect(sendTransactionMock).toHaveBeenCalledOnce();
    expect(await countTransferRows()).toBe(1);
  });

  it("refuses an unknown ramp transferId without storing the refusal under the key", async () => {
    const response = await postTransfer(
      { ...SOL_TRANSFER, transferId: "ptx_missing_ramp_deposit" },
      { idempotencyKey: "xfer-missing-ramp" }
    );

    expect(response.status).toBe(404);
    expect((await readErrorResponse(response)).error.code).toBe("NOT_FOUND");
    expect(await countStoredIdempotencyKeys("xfer-missing-ramp")).toBe(0);
    expect(await countTransferRows()).toBe(0);
  });

  it("refuses a transfer from a wallet outside the key's scope before writing anything", async () => {
    await seedCachedKey({ walletScope: "selected", walletIds: [] });

    const refused = await postTransfer(SOL_TRANSFER, { idempotencyKey: "xfer-out-of-scope" });

    expect(refused.status).toBe(403);
    expect((await readErrorResponse(refused)).error).toMatchObject({
      code: "FORBIDDEN",
      details: { reason: "wallet_out_of_scope" },
    });
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
    expect(await countTransferRows()).toBe(0);
    expect(await countStoredIdempotencyKeys("xfer-out-of-scope")).toBe(0);

    // Nothing was stored, so the same key runs once the scope allows the wallet.
    await seedCachedKey({ walletIds: [TEST_CUSTODY_WALLET_ID] });
    const allowed = await postTransfer(SOL_TRANSFER, { idempotencyKey: "xfer-out-of-scope" });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Idempotent-Replayed")).toBeNull();
  });
});
