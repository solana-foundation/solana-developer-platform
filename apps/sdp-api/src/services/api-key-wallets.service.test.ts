import { expect, it } from "vitest";
import { hydrateApiKeyWalletAuthorization } from "./api-key-wallets.service";

it("hydrates exact selected-wallet authorization for API-key readers", () => {
  expect(
    hydrateApiKeyWalletAuthorization(
      [
        {
          wallet_id: "wallet_exact",
          custody_wallet_id: "cwlt_exact",
          permissions: JSON.stringify(["payments:write"]),
        },
      ],
      "wallet_exact"
    )
  ).toEqual({
    walletScope: "selected",
    signingWalletId: "wallet_exact",
    signingWalletIds: ["wallet_exact"],
    walletBindings: [
      {
        walletId: "wallet_exact",
        custodyWalletId: "cwlt_exact",
        permissions: ["payments:write"],
      },
    ],
  });
});
