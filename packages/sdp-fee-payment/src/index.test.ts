import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createFeePaymentAdapter,
  createKoraAdapter,
  defaultFeePaymentCluster,
  isFeePaymentConfiguredForCluster,
  resolveKoraEndpoint,
} from "./index";
import type { FeePaymentEnv } from "./port";

describe("resolveKoraEndpoint", () => {
  const bothClusters: FeePaymentEnv = {
    SOLANA_NETWORK: "devnet",
    KORA_DEVNET_URL: "https://kora-devnet.mock.invalid",
    KORA_DEVNET_API_KEY: "devnet-key",
    KORA_DEVNET_CLOUD_RUN_AUDIENCE: "https://kora-devnet.mock.invalid",
    KORA_MAINNET_URL: " https://kora-mainnet.mock.invalid ",
    KORA_MAINNET_API_KEY: "mainnet-key",
  };

  it("reads each cluster's own trio and nothing from the other's", () => {
    assert.deepEqual(resolveKoraEndpoint(bothClusters, "devnet"), {
      rpcUrl: "https://kora-devnet.mock.invalid",
      apiKey: "devnet-key",
      identityTokenAudience: "https://kora-devnet.mock.invalid",
    });
    assert.deepEqual(resolveKoraEndpoint(bothClusters, "mainnet-beta"), {
      rpcUrl: "https://kora-mainnet.mock.invalid",
      apiKey: "mainnet-key",
      identityTokenAudience: undefined,
    });
  });

  it("resolves the SOLANA_NETWORK cluster when no cluster is named", () => {
    const mainnetProcess: FeePaymentEnv = { ...bothClusters, SOLANA_NETWORK: "mainnet-beta" };
    assert.equal(defaultFeePaymentCluster(mainnetProcess), "mainnet-beta");
    assert.deepEqual(
      resolveKoraEndpoint(mainnetProcess),
      resolveKoraEndpoint(mainnetProcess, "mainnet-beta")
    );
  });

  it("answers null for a cluster without its URL, whatever else that cluster has", () => {
    const devnetOnly: FeePaymentEnv = {
      SOLANA_NETWORK: "devnet",
      KORA_DEVNET_URL: "https://kora-devnet.mock.invalid",
      KORA_MAINNET_URL: "   ",
      KORA_MAINNET_API_KEY: "mainnet-key",
      KORA_MAINNET_CLOUD_RUN_AUDIENCE: "https://kora-mainnet.mock.invalid",
    };
    assert.equal(resolveKoraEndpoint(devnetOnly, "mainnet-beta"), null);
    assert.equal(isFeePaymentConfiguredForCluster(devnetOnly, "mainnet-beta"), false);
    assert.equal(isFeePaymentConfiguredForCluster(devnetOnly, "devnet"), true);
    assert.equal(resolveKoraEndpoint({}, "devnet"), null);
  });
});

describe("createFeePaymentAdapter", () => {
  it("fails closed for a cluster with no paymaster", () => {
    const env: FeePaymentEnv = {
      SOLANA_NETWORK: "devnet",
      KORA_DEVNET_URL: "https://kora-devnet.mock.invalid",
    };
    assert.throws(
      () => createKoraAdapter(env, "sdp:v1:test", "mainnet-beta"),
      /Kora is not configured for mainnet-beta: set KORA_MAINNET_URL/
    );
    assert.throws(
      () =>
        createFeePaymentAdapter(
          { ...env, FEE_PAYMENT_PROVIDER: "native" },
          "sdp:v1:test",
          "mainnet-beta"
        ),
      /native fee payer serves devnet only/
    );
  });

  it("builds a Kora adapter for a cluster that has one", () => {
    const env: FeePaymentEnv = {
      SOLANA_NETWORK: "devnet",
      KORA_DEVNET_URL: "https://kora-devnet.mock.invalid",
      KORA_MAINNET_URL: "https://kora-mainnet.mock.invalid",
    };
    assert.equal(createFeePaymentAdapter(env, "sdp:v1:test", "mainnet-beta").providerId, "kora");
    assert.equal(createFeePaymentAdapter(env, "sdp:v1:test").providerId, "kora");
  });
});
