import { describe, expect, it } from "vitest";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { countStoredIdempotencyKeys } from "@/test/helpers/idempotency-records";
import {
  createOrgSignerForCustodyWalletMock,
  installPaymentsRouteTestHooks,
  seedProjectPrivyWallet,
  TEST_ORG,
  TEST_PRODUCTION_PROJECT_ID,
  TEST_USER,
} from "@/test/helpers/payments-routes";
import { countTransferRows, postTransfer } from "@/test/helpers/payments-transfers";

describe("Payments routes — custody wallets of another project", () => {
  installPaymentsRouteTestHooks();

  it("refuses another project's wallet as a transfer source before claiming the key", async () => {
    await seedProjectPrivyWallet({
      organizationId: TEST_ORG.id,
      projectId: TEST_PRODUCTION_PROJECT_ID,
      createdBy: TEST_USER.id,
      custodyWalletId: "cwlt_payments_other_project",
      publicKey: TEST_SOLANA_ADDRESSES.wallet3,
    });

    const response = await postTransfer(
      {
        sourceCustodyWalletId: "cwlt_payments_other_project",
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.001",
      },
      { idempotencyKey: "payments-other-project" }
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Wallet not found. Verify the wallet identifier supplied to this endpoint.",
      },
      meta: { requestId: expect.any(String) },
    });
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
    expect(await countTransferRows()).toBe(0);
    expect(await countStoredIdempotencyKeys("payments-other-project")).toBe(0);
  });
});
