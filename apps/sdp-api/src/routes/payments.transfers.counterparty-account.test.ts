import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { seedProjectCryptoWalletCounterparty } from "@/test/helpers/counterparties";
import { env } from "@/test/helpers/env";
import {
  installPaymentsRouteTestHooks,
  sendTransactionMock,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PRODUCTION_PROJECT_ID,
  TEST_PROJECT,
  TEST_USER,
} from "@/test/helpers/payments-routes";
import {
  countTransferRows,
  postTransfer,
  readTransferResponse,
  readTransferRow,
} from "@/test/helpers/payments-transfers";

const DESTINATION_ACCOUNT = {
  projectId: TEST_PROJECT.id,
  walletAddress: TEST_SOLANA_ADDRESSES.wallet2,
};

async function seedAccount(
  name: string,
  placement: { projectId: string; walletAddress: string }
): Promise<string> {
  const counterpartyAccountId = `counterparty_account_${name}`;
  await seedProjectCryptoWalletCounterparty(getDb(env), {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    counterpartyId: `cpty_${name}`,
    counterpartyAccountId,
    ...placement,
  });
  return counterpartyAccountId;
}

function accountTransfer(counterpartyAccountId: string) {
  return {
    sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
    destination: TEST_SOLANA_ADDRESSES.wallet2,
    counterpartyAccountId,
    token: "SOL",
    amount: "1",
  };
}

describe("Payments routes — transfers to a counterparty account", () => {
  installPaymentsRouteTestHooks();
  installClusterRpcStub();

  it("records the account's counterparty and replays it after the counterparty is archived", async () => {
    const body = accountTransfer(await seedAccount("xfer_bound", DESTINATION_ACCOUNT));

    const first = await postTransfer(body, { idempotencyKey: "xfer-bound-key" });
    expect(first.status).toBe(200);
    const transfer = (await readTransferResponse(first)).data.transfer;
    expect(transfer.counterpartyId).toBe("cpty_xfer_bound");
    expect((await readTransferRow(transfer.id)).counterparty_id).toBe("cpty_xfer_bound");

    await getDb(env).execute("UPDATE counterparties SET status = 'archived' WHERE id = ?", [
      "cpty_xfer_bound",
    ]);
    const replay = await postTransfer(body, { idempotencyKey: "xfer-bound-key" });

    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect((await readTransferResponse(replay)).data.transfer.id).toBe(transfer.id);
    expect(sendTransactionMock).toHaveBeenCalledOnce();
  });

  it("refuses an account from another project as not found", async () => {
    const accountId = await seedAccount("xfer_other_project", {
      ...DESTINATION_ACCOUNT,
      projectId: TEST_PRODUCTION_PROJECT_ID,
    });

    const response = await postTransfer(accountTransfer(accountId), {});

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Counterparty account not found" },
      meta: { requestId: expect.any(String) },
    });
  });

  it("refuses an account whose address is not the destination", async () => {
    const accountId = await seedAccount("xfer_mismatch", {
      ...DESTINATION_ACCOUNT,
      walletAddress: TEST_SOLANA_ADDRESSES.wallet3,
    });

    const response = await postTransfer(accountTransfer(accountId), {});

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "CONFLICT",
        message: "counterparty account address does not match destination",
      },
      meta: { requestId: expect.any(String) },
    });
    expect(await countTransferRows()).toBe(0);
    expect(sendTransactionMock).not.toHaveBeenCalled();
  });

  it("refuses a counterparty account combined with a transferId", async () => {
    const body = accountTransfer(await seedAccount("xfer_with_transfer_id", DESTINATION_ACCOUNT));
    const transferId = (await readTransferResponse(await postTransfer(body, {}))).data.transfer.id;

    const response = await postTransfer({ ...body, transferId }, {});

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "counterpartyAccountId cannot be combined with transferId",
      },
      meta: { requestId: expect.any(String) },
    });
  });

  it("refuses the same Idempotency-Key naming a different counterparty account", async () => {
    const firstAccountId = await seedAccount("xfer_reuse_first", DESTINATION_ACCOUNT);
    const secondAccountId = await seedAccount("xfer_reuse_second", DESTINATION_ACCOUNT);
    const idempotencyKey = "xfer-reuse-key";
    expect((await postTransfer(accountTransfer(firstAccountId), { idempotencyKey })).status).toBe(
      200
    );

    const reused = await postTransfer(accountTransfer(secondAccountId), { idempotencyKey });

    expect(reused.status).toBe(422);
    expect(await reused.json()).toEqual({
      error: {
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "This Idempotency-Key was already used for a different request",
      },
      meta: { requestId: expect.any(String) },
    });
    expect(sendTransactionMock).toHaveBeenCalledOnce();
  });
});
