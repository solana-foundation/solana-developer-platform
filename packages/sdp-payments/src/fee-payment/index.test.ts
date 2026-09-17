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

/**
 * One API process serves both clusters, and each cluster has its own Kora with
 * its own signer, policy and credentials. These pin the selection rule: the
 * unsuffixed trio serves only the process's `SOLANA_NETWORK` cluster, a
 * `KORA_*_<CLUSTER>` trio serves its cluster explicitly and borrows nothing,
 * and a cluster with neither answers null so callers fall back to wallet-pays.
 */
describe("resolveKoraEndpoint", () => {
  const devnetDefault: FeePaymentEnv = {
    SOLANA_NETWORK: "devnet",
    KORA_RPC_URL: "https://kora-devnet.example",
    KORA_API_KEY: "devnet-key",
    KORA_CLOUD_RUN_AUDIENCE: "https://kora-devnet.example",
  };

  it("serves the process default cluster from the unsuffixed trio", () => {
    assert.equal(defaultFeePaymentCluster(devnetDefault), "devnet");
    assert.deepEqual(resolveKoraEndpoint(devnetDefault, "devnet"), {
      rpcUrl: "https://kora-devnet.example",
      apiKey: "devnet-key",
      identityTokenAudience: "https://kora-devnet.example",
    });
    assert.deepEqual(
      resolveKoraEndpoint(devnetDefault),
      resolveKoraEndpoint(devnetDefault, "devnet")
    );
  });

  it("answers null for the other cluster until it has its own trio", () => {
    assert.equal(resolveKoraEndpoint(devnetDefault, "mainnet-beta"), null);
    assert.equal(isFeePaymentConfiguredForCluster(devnetDefault, "mainnet-beta"), false);
    assert.equal(isFeePaymentConfiguredForCluster(devnetDefault, "devnet"), true);
  });

  it("serves a per-cluster trio on its own, never borrowing the default's key or audience", () => {
    const env: FeePaymentEnv = {
      ...devnetDefault,
      KORA_RPC_URL_MAINNET: " https://kora-mainnet.example ",
      KORA_API_KEY_MAINNET: "mainnet-key",
    };
    assert.deepEqual(resolveKoraEndpoint(env, "mainnet-beta"), {
      rpcUrl: "https://kora-mainnet.example",
      apiKey: "mainnet-key",
      identityTokenAudience: undefined,
    });
    assert.equal(resolveKoraEndpoint(env, "devnet")?.apiKey, "devnet-key");
  });

  it("lets a per-cluster trio override the default cluster too", () => {
    const env: FeePaymentEnv = {
      ...devnetDefault,
      KORA_RPC_URL_DEVNET: "https://kora-devnet-2.example",
    };
    assert.deepEqual(resolveKoraEndpoint(env, "devnet"), {
      rpcUrl: "https://kora-devnet-2.example",
      apiKey: undefined,
      identityTokenAudience: undefined,
    });
  });

  it("follows SOLANA_NETWORK for which cluster the unsuffixed trio serves", () => {
    const env: FeePaymentEnv = {
      SOLANA_NETWORK: "mainnet-beta",
      KORA_RPC_URL: "https://kora.example",
    };
    assert.equal(resolveKoraEndpoint(env, "mainnet-beta")?.rpcUrl, "https://kora.example");
    assert.equal(resolveKoraEndpoint(env, "devnet"), null);
  });

  it("falls back to the published devnet Kora only for the default cluster", () => {
    assert.equal(resolveKoraEndpoint({}, "devnet")?.rpcUrl, "https://kora-devnet.solana.com");
    assert.equal(resolveKoraEndpoint({}, "mainnet-beta"), null);
  });
});

describe("createFeePaymentAdapter", () => {
  it("fails closed for a cluster with no paymaster", () => {
    const env: FeePaymentEnv = {
      SOLANA_NETWORK: "devnet",
      KORA_RPC_URL: "https://kora-devnet.example",
    };
    assert.throws(
      () => createKoraAdapter(env, "sdp:v1:test", "mainnet-beta"),
      /Kora is not configured for mainnet-beta/
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
      KORA_RPC_URL: "https://kora-devnet.example",
      KORA_RPC_URL_MAINNET: "https://kora-mainnet.example",
    };
    assert.equal(createFeePaymentAdapter(env, "sdp:v1:test", "mainnet-beta").providerId, "kora");
    assert.equal(createFeePaymentAdapter(env, "sdp:v1:test").providerId, "kora");
  });
});
