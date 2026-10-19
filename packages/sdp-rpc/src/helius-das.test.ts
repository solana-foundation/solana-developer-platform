import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { SolanaCluster } from "@sdp/types/well-known-tokens";
import { fetchHeliusDas, isHeliusDasConfigured } from "./helius-das";
import { runInClusterScope } from "./scope";

const HELIUS_DAS_ENV_KEYS = [
  "SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL",
  "SOLANA_RPC_HELIUS_MAINNET_API_KEY_URL",
] as const;

type HeliusDasEnvKey = (typeof HELIUS_DAS_ENV_KEYS)[number];

const HELIUS_DAS_URLS = {
  SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: "https://devnet.helius-das.sdp.test/?api-key=devnet",
  SOLANA_RPC_HELIUS_MAINNET_API_KEY_URL: "https://mainnet.helius-das.sdp.test/?api-key=mainnet",
} as const satisfies Record<HeliusDasEnvKey, string>;

const CLUSTER_CASES = [
  {
    environment: "sandbox",
    cluster: "devnet",
    envKey: "SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL",
    otherEnvKey: "SOLANA_RPC_HELIUS_MAINNET_API_KEY_URL",
  },
  {
    environment: "production",
    cluster: "mainnet-beta",
    envKey: "SOLANA_RPC_HELIUS_MAINNET_API_KEY_URL",
    otherEnvKey: "SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL",
  },
] as const satisfies readonly {
  environment: SdpEnvironment;
  cluster: SolanaCluster;
  envKey: HeliusDasEnvKey;
  otherEnvKey: HeliusDasEnvKey;
}[];

const DAS_REQUEST_INIT: RequestInit = {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: "das_test", method: "getAssetBatch", params: {} }),
};

let ambientHeliusEnv: Map<HeliusDasEnvKey, string | undefined> = new Map();

function inScope<TResult>(environment: SdpEnvironment, operation: () => TResult): TResult {
  return runInClusterScope({ projectId: null, environment }, operation);
}

function stubFetch(response: Response) {
  return mock.method(globalThis, "fetch", async () => response);
}

describe("Helius DAS on the scope's cluster", () => {
  beforeEach(() => {
    ambientHeliusEnv = new Map(HELIUS_DAS_ENV_KEYS.map((envKey) => [envKey, process.env[envKey]]));
    for (const envKey of HELIUS_DAS_ENV_KEYS) {
      delete process.env[envKey];
    }
  });

  afterEach(() => {
    mock.restoreAll();
    for (const [envKey, value] of ambientHeliusEnv) {
      if (value === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = value;
      }
    }
  });

  for (const { environment, cluster, envKey } of CLUSTER_CASES) {
    it(`sends a ${environment} DAS request to the ${cluster} Helius endpoint`, async () => {
      Object.assign(process.env, HELIUS_DAS_URLS);
      const response = Response.json({ jsonrpc: "2.0", id: "das_test", result: [] });
      const fetchMock = stubFetch(response);

      assert.equal(
        inScope(environment, () => isHeliusDasConfigured()),
        true
      );
      assert.equal(await inScope(environment, () => fetchHeliusDas(DAS_REQUEST_INIT)), response);
      assert.deepEqual(
        fetchMock.mock.calls.map((call) => call.arguments),
        [[HELIUS_DAS_URLS[envKey], DAS_REQUEST_INIT]]
      );
    });
  }

  for (const { environment, cluster, otherEnvKey } of CLUSTER_CASES) {
    it(`refuses a ${environment} DAS request when only the other cluster has a Helius endpoint`, async () => {
      process.env[otherEnvKey] = HELIUS_DAS_URLS[otherEnvKey];
      const fetchMock = stubFetch(Response.json({ jsonrpc: "2.0", id: "das_test", result: [] }));

      assert.equal(
        inScope(environment, () => isHeliusDasConfigured()),
        false
      );
      await assert.rejects(
        inScope(environment, async () => fetchHeliusDas(DAS_REQUEST_INIT)),
        {
          name: "SdpRpcError",
          code: "RPC_NOT_CONFIGURED",
          details: { cluster },
        }
      );
      assert.equal(fetchMock.mock.callCount(), 0);
    });
  }

  it("refuses to resolve a Helius endpoint outside a cluster scope", async () => {
    Object.assign(process.env, HELIUS_DAS_URLS);
    const fetchMock = stubFetch(Response.json({ jsonrpc: "2.0", id: "das_test", result: [] }));

    assert.throws(() => isHeliusDasConfigured(), {
      name: "SdpRpcError",
      code: "CLUSTER_SCOPE_MISSING",
    });
    await assert.rejects(async () => fetchHeliusDas(DAS_REQUEST_INIT), {
      name: "SdpRpcError",
      code: "CLUSTER_SCOPE_MISSING",
    });
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});
