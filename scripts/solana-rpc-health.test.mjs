import assert from "node:assert/strict";
import test from "node:test";
import {
  getSolanaRpcCandidates,
  selectHealthySolanaRpcUrl,
  useSolanaRpcCandidateAsDefault,
} from "./lib/solana-rpc-health.mjs";

// biome-ignore lint/security/noSecrets: Solana mainnet's public genesis hash
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
// biome-ignore lint/security/noSecrets: Solana devnet's public genesis hash
const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

test("reads each provider's devnet URL verbatim and ignores mainnet URLs", () => {
  const providers = [
    ["alchemy", "ALCHEMY"],
    ["quicknode", "QUICKNODE"],
    ["triton", "TRITON"],
    ["default", "DEFAULT"],
    ["helius", "HELIUS"],
    ["validationcloud", "VALIDATIONCLOUD"],
    ["nodit", "NODIT"],
  ];

  for (const [id, envName] of providers) {
    const url = `https://rpc-health-${id}.test/devnet?api-key=${id}-key`;
    const env = {
      [`SOLANA_RPC_${envName}_DEVNET_API_KEY_URL`]: url,
      [`SOLANA_RPC_${envName}_MAINNET_API_KEY_URL`]: `https://rpc-health-${id}.test/mainnet`,
    };

    const candidates = getSolanaRpcCandidates(env).map((candidate) => ({
      id: candidate.id,
      url: candidate.url,
    }));

    assert.deepEqual(candidates, [{ id, url }]);
  }
});

test("orders candidates by table order, preferred provider first, shared URLs once", () => {
  const env = {
    SOLANA_RPC_NODIT_DEVNET_API_KEY_URL: "https://rpc-health-nodit.test/devnet",
    SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: "https://rpc-health-shared.test/devnet",
    SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: "https://rpc-health-shared.test/devnet",
    SOLANA_RPC_ALCHEMY_DEVNET_API_KEY_URL: "https://rpc-health-alchemy.test/devnet",
  };

  const ids = (candidateEnv) =>
    getSolanaRpcCandidates(candidateEnv).map((candidate) => candidate.id);

  assert.deepEqual(ids(env), ["alchemy", "triton", "nodit"]);
  assert.deepEqual(ids({ ...env, SOLANA_RPC_CI_PREFERRED_PROVIDER: "nodit" }), [
    "nodit",
    "alchemy",
    "triton",
  ]);
});

test("replaces every provider URL key with the selected URL as the default and leaves unrelated keys alone", () => {
  const env = {
    SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: "https://rpc-health-keep-triton.test/devnet",
    SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: "https://rpc-health-keep-helius.test/devnet",
    SOLANA_RPC_NODIT_DEVNET_API_KEY_URL: "https://rpc-health-keep-nodit.test/devnet",
    SDP_UNRELATED_SETTING: "unrelated-value",
  };
  const [, selected] = getSolanaRpcCandidates(env);

  useSolanaRpcCandidateAsDefault(env, selected);

  assert.deepEqual(env, {
    SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL: "https://rpc-health-keep-helius.test/devnet",
    SDP_UNRELATED_SETTING: "unrelated-value",
  });
});

test("skips a candidate that serves mainnet and selects the next one that serves devnet", async (t) => {
  const mainnetUrl = "https://rpc-health-serves-mainnet.test/devnet";
  const devnetUrl = "https://rpc-health-serves-devnet.test/devnet";
  const genesisHashByUrl = { [mainnetUrl]: MAINNET_GENESIS_HASH, [devnetUrl]: DEVNET_GENESIS_HASH };
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, init) => {
    const { id, method, params } = JSON.parse(init.body);
    calls.push({ url, method, params });
    const result =
      method === "getGenesisHash"
        ? genesisHashByUrl[url]
        : {
            context: { slot: 7 },
            value: { blockhash: "rpc-health-blockhash", lastValidBlockHeight: 9 },
          };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
  };

  const selected = await selectHealthySolanaRpcUrl(
    {
      SOLANA_RPC_ALCHEMY_DEVNET_API_KEY_URL: mainnetUrl,
      SOLANA_RPC_QUICKNODE_DEVNET_API_KEY_URL: devnetUrl,
    },
    { timeoutMs: 1_000 }
  );

  assert.deepEqual(selected, {
    id: "quicknode",
    urlKey: "SOLANA_RPC_QUICKNODE_DEVNET_API_KEY_URL",
    url: devnetUrl,
  });
  assert.deepEqual(calls, [
    { url: mainnetUrl, method: "getGenesisHash", params: [] },
    { url: devnetUrl, method: "getGenesisHash", params: [] },
    { url: devnetUrl, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] },
  ]);
});
