import { describe, expect, it } from "vitest";
import { createToken, createTokenTransaction } from "@/test/helpers/factories";
import { toPublicToken, toPublicTokenTransaction } from "./public-response";

describe("Issuance public responses", () => {
  it("omits internal wallet identity mirrors", () => {
    const token = toPublicToken({
      ...createToken({ signingCustodyWalletId: "cwlt_deploy" }),
      signingWalletId: "privy_provider_wallet",
    });
    const transaction = toPublicTokenTransaction(
      createTokenTransaction({ custodyWalletId: "cwlt_signer" })
    );

    expect(token).toMatchObject({ signingCustodyWalletId: "cwlt_deploy" });
    expect(token).not.toHaveProperty("signingWalletId");
    expect(transaction).not.toHaveProperty("custodyWalletId");
  });
});
