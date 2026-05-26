import { address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareMagicBlockPrivateTransfer } from "@/services/private-transfers/magicblock";
import { env } from "@/test/helpers/env";

const TEST_MAGICBLOCK_API_BASE_URL = "https://payments.magicblock.test";
const TEST_SOURCE = address("8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ");
const TEST_DESTINATION = address("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
const DEVNET_USDC_MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

let originalMagicBlockApiBaseUrl: string | undefined;
let originalSolanaNetwork: "devnet" | "mainnet-beta" | undefined;
let originalSolanaRpcUrl: string | undefined;

function prepareTransfer() {
  return prepareMagicBlockPrivateTransfer(env, {
    from: TEST_SOURCE,
    to: TEST_DESTINATION,
    mint: DEVNET_USDC_MINT,
    amount: 1,
    options: {
      visibility: "private",
      fromBalance: "base",
      toBalance: "base",
    },
  });
}

describe("MagicBlock private transfers", () => {
  beforeEach(() => {
    originalMagicBlockApiBaseUrl = env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL;
    originalSolanaNetwork = env.SOLANA_NETWORK;
    originalSolanaRpcUrl = env.SOLANA_RPC_URL;

    env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
    env.SOLANA_NETWORK = "devnet";
    env.SOLANA_RPC_URL = "https://api.devnet.solana.test";
  });

  afterEach(() => {
    vi.restoreAllMocks();

    env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = originalMagicBlockApiBaseUrl;
    env.SOLANA_NETWORK = originalSolanaNetwork;
    env.SOLANA_RPC_URL = originalSolanaRpcUrl;
  });

  it("maps MagicBlock rate limits to RATE_LIMITED", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Too many MagicBlock requests" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(prepareTransfer()).rejects.toMatchObject({
      code: "RATE_LIMITED",
      statusCode: 429,
      message: "Too many MagicBlock requests",
      details: {
        provider: "magicblock",
        providerStatus: 429,
      },
    });
  });

  it("maps MagicBlock upstream failures to PROVIDER_UNAVAILABLE", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "MagicBlock unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(prepareTransfer()).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      statusCode: 503,
      message: "MagicBlock unavailable",
      details: {
        provider: "magicblock",
        providerStatus: 503,
      },
    });
  });

  it("maps malformed MagicBlock success responses to PROVIDER_UNAVAILABLE", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ transactionBase64: "not enough fields" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(prepareTransfer()).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      statusCode: 503,
      message: "MagicBlock transfer response payload is invalid.",
      details: {
        provider: "magicblock",
      },
    });
  });

  it("maps MagicBlock timeouts to PROVIDER_UNAVAILABLE", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new DOMException("The operation timed out.", "TimeoutError")
    );

    await expect(prepareTransfer()).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      statusCode: 503,
      message: "MagicBlock request timed out.",
      details: {
        provider: "magicblock",
        timeoutMs: 15_000,
      },
    });
  });
});
