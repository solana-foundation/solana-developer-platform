import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { env } from "@/test/helpers/env";
import {
  createOrgSignerForCustodyWalletMock,
  installPaymentsRouteTestHooks,
  seedCachedKey,
  TEST_API_KEY,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";

// HOO-2099: the custody signer refuses a wallet outside a selected key's
// scope; authorize refuses it first, so a refused signer check stores no
// Idempotency-Key answer that would replay the refusal after a scope fix.
describe("signer check wallet scope", () => {
  installPaymentsRouteTestHooks();

  it("refuses a wallet outside the key's scope before claiming the key", async () => {
    await seedCachedKey({ walletScope: "selected", walletIds: [] });

    const response = await app.request(
      "/v1/wallets/signer-check",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "signer-check-out-of-scope",
        },
        body: JSON.stringify({ walletId: TEST_WALLET_ID }),
      },
      env
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { details: { reason: "wallet_out_of_scope" } },
    });
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
    const keys = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS count FROM idempotency_keys WHERE idempotency_key = ?")
      .bind("signer-check-out-of-scope")
      .first<{ count: number }>();
    expect(keys).toEqual({ count: 0 });
  });
});
