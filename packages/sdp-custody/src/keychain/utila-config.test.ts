import { describe, expect, it } from "vitest";
import { buildKeychainUtilaConfig } from "./utila-config";

describe("buildKeychainUtilaConfig", () => {
  it("takes the network from the cluster when neither the config nor env names one", () => {
    const config = buildKeychainUtilaConfig(
      {
        UTILA_SERVICE_ACCOUNT_EMAIL: "signer@utila.example.test",
        UTILA_SERVICE_ACCOUNT_PRIVATE_KEY: "synthetic-utila-private-key",
        UTILA_VAULT_ID: "vault_utila_config_test",
      },
      { cluster: "mainnet-beta" }
    );

    expect(config.network).toBe("networks/solana-mainnet");
  });
});
