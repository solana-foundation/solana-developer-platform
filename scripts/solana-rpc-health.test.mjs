import assert from "node:assert/strict";
import test from "node:test";
import { getSolanaRpcCandidates } from "./lib/solana-rpc-health.mjs";

test("resolves managed RPC URL shapes without changing existing providers", () => {
  const cases = [
    {
      id: "alchemy",
      env: {
        SOLANA_RPC_ALCHEMY_URL: "https://solana-devnet.g.alchemy.com/v2/{API_KEY}",
        SOLANA_RPC_ALCHEMY_API_KEY: "alchemy123",
      },
      expected: "https://solana-devnet.g.alchemy.com/v2/alchemy123",
    },
    {
      id: "quicknode",
      env: {
        SOLANA_RPC_QUICKNODE_URL: "https://example.solana-devnet.quiknode.pro/{API_KEY}",
        SOLANA_RPC_QUICKNODE_API_KEY: "quicknode123",
      },
      expected: "https://example.solana-devnet.quiknode.pro/quicknode123",
    },
    {
      id: "triton",
      env: {
        SOLANA_RPC_TRITON_URL: "https://example.devnet.rpcpool.com/{API_KEY}",
        SOLANA_RPC_TRITON_API_KEY: "triton123",
      },
      expected: "https://example.devnet.rpcpool.com/triton123",
    },
    {
      id: "default",
      env: {
        SOLANA_RPC_URL: "https://api.devnet.solana.com",
      },
      expected: "https://api.devnet.solana.com",
    },
    {
      id: "helius",
      env: {
        SOLANA_RPC_HELIUS_URL: "https://devnet.helius-rpc.com/?api-key={API_KEY}",
        SOLANA_RPC_HELIUS_API_KEY: "helius123",
      },
      expected: "https://devnet.helius-rpc.com/?api-key=helius123",
    },
    {
      id: "validationcloud",
      env: {
        SOLANA_RPC_VALIDATIONCLOUD_URL: "https://devnet.solana.validationcloud.io/v1/{API_KEY}",
        SOLANA_RPC_VALIDATIONCLOUD_API_KEY: "validationcloud123",
      },
      expected: "https://devnet.solana.validationcloud.io/v1/validationcloud123",
    },
    {
      id: "nodit",
      env: {
        SOLANA_RPC_NODIT_URL: "https://solana-devnet.nodit.io/{API_KEY}",
        SOLANA_RPC_NODIT_API_KEY: "a/b c?d=e%f",
      },
      expected: [
        "https://solana-devnet.nodit.io/a",
        "%2F",
        "b",
        "%20",
        "c",
        "%3F",
        "d",
        "%3D",
        "e",
        "%25",
        "f",
      ].join(""),
    },
    {
      id: "nodit",
      env: {
        SOLANA_RPC_NODIT_URL: "https://nodit-proxy.example/rpc",
      },
      expected: "https://nodit-proxy.example/rpc",
    },
    {
      id: "nodit",
      env: {
        SOLANA_RPC_NODIT_URL: "https://nodit-proxy.example/{API_KEY}?key={API_KEY}",
        SOLANA_RPC_NODIT_API_KEY: "nodit-key",
      },
      expected: "https://nodit-proxy.example/nodit-key?key=nodit-key",
    },
    {
      id: "alchemy",
      env: {
        SOLANA_RPC_ALCHEMY_URL: "https://alchemy-proxy.example/rpc",
        SOLANA_RPC_ALCHEMY_API_KEY: "unused-key",
      },
      expected: "https://alchemy-proxy.example/rpc",
    },
  ];

  for (const { id, env, expected } of cases) {
    const candidates = getSolanaRpcCandidates(env).map((candidate) => ({
      id: candidate.id,
      url: candidate.url,
    }));
    assert.deepEqual(candidates, [{ id, url: expected }]);
  }
});
