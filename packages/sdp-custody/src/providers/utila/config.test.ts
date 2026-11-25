import { describe, expect, it } from "vitest";
import { buildKeychainUtilaConfig } from "./config";

describe("buildKeychainUtilaConfig", () => {
  it("carries the caller's cluster to the signer config", () => {
    const config = buildKeychainUtilaConfig(
      {
        UTILA_SERVICE_ACCOUNT_EMAIL: "signer@utila.example.test",
        UTILA_SERVICE_ACCOUNT_PRIVATE_KEY: "synthetic-utila-private-key",
        UTILA_VAULT_ID: "vault_utila_config_test",
      },
      { cluster: "mainnet-beta" }
    );

    expect(config.cluster).toBe("mainnet-beta");
  });
});
