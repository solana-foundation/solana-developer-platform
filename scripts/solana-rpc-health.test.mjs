import assert from "node:assert/strict";
import test from "node:test";
import {
  getSolanaRpcCandidates,
  useSolanaRpcCandidateAsDefault,
} from "./lib/solana-rpc-health.mjs";

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
