import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SignerCheckApiResponse } from "../helpers/api-types";
import {
  cleanupIntegrationSuite,
  env,
  initIntegrationSuite,
  requestWithApiKey,
} from "../helpers/integration";

const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

type SolanaRpcResponse<T> =
  | { jsonrpc: "2.0"; id: number; result: T }
  | { jsonrpc: "2.0"; id: number; error: { code: number; message: string; data?: unknown } };

type ParsedAccountKey = string | { pubkey: string; signer?: boolean };
type ParsedInstruction = { programId?: string; parsed?: unknown };

type ParsedTransactionResponse = {
  slot: number;
  transaction: {
    message: {
      accountKeys: ParsedAccountKey[];
      instructions: ParsedInstruction[];
    };
  };
  meta: { err: unknown } | null;
};

const TRANSACTION_LOOKUP_TIMEOUT_MS = 30_000;
const TRANSACTION_LOOKUP_POLL_MS = 1_000;

function normalizePubkey(accountKey: ParsedAccountKey): string {
  if (typeof accountKey === "string") {
    return accountKey;
  }
  return accountKey.pubkey;
}

async function callSolanaRpc<T>(method: string, params: unknown[]): Promise<T> {
  const rpcUrl = env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    throw new Error("SOLANA_RPC_URL is not configured for integration tests.");
  }

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  const payload = (await response.json()) as SolanaRpcResponse<T>;
  if ("error" in payload) {
    throw new Error(payload.error.message ?? `RPC error calling ${method}`);
  }

  return payload.result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getConfirmedTransaction(signature: string): Promise<ParsedTransactionResponse> {
  const deadline = Date.now() + TRANSACTION_LOOKUP_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      const tx = await callSolanaRpc<ParsedTransactionResponse | null>("getTransaction", [
        signature,
        {
          commitment: "confirmed",
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
        },
      ]);

      if (tx) {
        return tx;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(TRANSACTION_LOOKUP_POLL_MS);
  }

  const suffix = lastError instanceof Error ? ` Last RPC error: ${lastError.message}` : "";
  throw new Error(
    `Unable to fetch confirmed Kora signer-check transaction ${signature} from SOLANA_RPC_URL after ${TRANSACTION_LOOKUP_TIMEOUT_MS}ms.${suffix}`
  );
}

function assertKoraLiveSmokeEnvConfigured() {
  const missing: string[] = [];
  if (env.RUN_INTEGRATION_TESTS !== "true") missing.push("RUN_INTEGRATION_TESTS=true");
  if (!env.SOLANA_RPC_URL) missing.push("SOLANA_RPC_URL");
  if (!env.KORA_RPC_URL) missing.push("KORA_RPC_URL");
  if (!env.PRIVY_APP_ID) missing.push("PRIVY_APP_ID");
  if (!env.PRIVY_APP_SECRET) missing.push("PRIVY_APP_SECRET");

  if (missing.length > 0) {
    throw new Error(`Kora live smoke tests require env configuration: ${missing.join(", ")}.`);
  }
}

describe("Kora Fee Payment (Live Smoke)", () => {
  const request = requestWithApiKey();

  beforeAll(async () => {
    assertKoraLiveSmokeEnvConfigured();
    await initIntegrationSuite();
  });

  afterAll(async () => {
    await cleanupIntegrationSuite();
  });

  it("submits a Privy signer-check memo through Kora signAndSend", {
    timeout: 120000,
  }, async () => {
    const createWalletRes = await request("/v1/wallets", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "privy",
        label: "Kora signer-check Privy integration wallet",
      }),
    });

    const createWalletPayload = await createWalletRes.text();
    if (createWalletRes.status !== 201) {
      throw new Error(
        `Privy wallet creation failed (${createWalletRes.status}): ${createWalletPayload}`
      );
    }

    const createWalletBody = JSON.parse(createWalletPayload) as {
      data: { wallet: { walletId: string; publicKey: string } };
    };

    const walletId = createWalletBody.data.wallet.walletId;
    const walletAddress = createWalletBody.data.wallet.publicKey;

    const createKeyRes = await request("/v1/api-keys", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Signer check integration key",
        permissions: ["wallets:write"],
        walletScope: "selected",
        signingWalletId: walletId,
      }),
    });

    expect(createKeyRes.status).toBe(201);
    const createdKeyBody = (await createKeyRes.json()) as {
      data: { apiKey: { id: string; key: string; name: string } };
    };

    const scopedApiKeyId = createdKeyBody.data.apiKey.id;
    const scopedApiKey = createdKeyBody.data.apiKey.key;
    const scopedApiKeyName = createdKeyBody.data.apiKey.name;
    const requestWithScopedKey = requestWithApiKey(scopedApiKey);
    const memo = `kora signer check ${Date.now()}`;
    let signerCheckPassed = false;

    try {
      const signerCheckRes = await requestWithScopedKey("/v1/wallets/signer-check", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ memo }),
      });

      const signerCheckPayload = await signerCheckRes.text();
      if (signerCheckRes.status !== 200) {
        throw new Error(
          `Kora signer-check failed (${signerCheckRes.status}): ${signerCheckPayload}`
        );
      }

      const signerCheckBody = JSON.parse(signerCheckPayload) as SignerCheckApiResponse;
      const signerCheck = signerCheckBody.data;

      expect(signerCheck.walletId).toBe(walletId);
      expect(signerCheck.walletAddress).toBe(walletAddress);
      expect(signerCheck.memo).toBe(memo);
      expect(signerCheck.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,88}$/);
      expect(signerCheck.feePayer).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(signerCheck.feePayer).not.toBe(signerCheck.walletAddress);

      const tx = await getConfirmedTransaction(signerCheck.signature);
      expect(tx.meta?.err).toBeNull();
      const accountKeys = tx.transaction.message.accountKeys.map(normalizePubkey);
      expect(accountKeys[0]).toBe(signerCheck.feePayer);
      expect(accountKeys).toContain(signerCheck.walletAddress);

      const memoInstruction = tx.transaction.message.instructions.find(
        (instruction) => instruction.programId === MEMO_PROGRAM_ADDRESS
      );
      expect(memoInstruction).toBeTruthy();

      const memoText = memoInstruction?.parsed;
      expect(typeof memoText).toBe("string");
      expect(memoText).toBe(memo);
      signerCheckPassed = true;
    } finally {
      const deleteScopedKeyRes = await request(`/v1/api-keys/${scopedApiKeyId}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ confirmation: scopedApiKeyName }),
      });
      if (signerCheckPassed) {
        expect(deleteScopedKeyRes.status).toBe(200);
      }
    }
  });
});
