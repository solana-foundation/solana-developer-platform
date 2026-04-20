import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  BurnApiResponse,
  FreezeApiResponse,
  MintApiResponse,
  SignerCheckApiResponse,
  TokenApiResponse,
  UnfreezeApiResponse,
} from "../helpers/api-types";
import {
  cleanupIntegrationSuite,
  env,
  initIntegrationSuite,
  requestWithApiKey,
  resetIntegrationState,
} from "../helpers/integration";

// biome-ignore lint/security/noSecrets: Solana Memo program id constant, not a secret.
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

function assertKoraIntegrationEnvConfigured() {
  const missing: string[] = [];
  if (env.RUN_INTEGRATION_TESTS !== "true") missing.push("RUN_INTEGRATION_TESTS=true");
  if (!env.SOLANA_RPC_URL) missing.push("SOLANA_RPC_URL");
  if (!env.KORA_RPC_URL) missing.push("KORA_RPC_URL");
  if (!env.PRIVY_APP_ID) missing.push("PRIVY_APP_ID");
  if (!env.PRIVY_APP_SECRET) missing.push("PRIVY_APP_SECRET");

  if (missing.length > 0) {
    throw new Error(`Kora integration tests require env configuration: ${missing.join(", ")}.`);
  }
}

describe("Kora Fee Payment (Devnet)", () => {
  let apiKeyHash: string;
  let custodyAddress = "";
  const request = requestWithApiKey();

  beforeAll(async () => {
    assertKoraIntegrationEnvConfigured();
    const init = await initIntegrationSuite();
    apiKeyHash = init.apiKeyHash;
    custodyAddress = init.custodyAddress;
  });

  afterAll(async () => {
    await cleanupIntegrationSuite();
  });

  beforeEach(async () => {
    const state = await resetIntegrationState(apiKeyHash);
    custodyAddress = state.custodyAddress;
  });

  it("deploys and manages a token using Kora fee payer", { timeout: 120000 }, async () => {
    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Kora Devnet Token",
        symbol: "KORA",
        decimals: 6,
        isMintable: true,
        isFreezable: true,
      }),
    });

    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as TokenApiResponse;
    const tokenId = created.data.token.id;

    const deployRes = await request(`/v1/issuance/tokens/${tokenId}/deploy`, {
      method: "POST",
    });

    expect(deployRes.status).toBe(200);
    const deployed = (await deployRes.json()) as TokenApiResponse;
    expect(deployed.data.token.mintAddress).toBeTruthy();

    const mintRes = await request(`/v1/issuance/tokens/${tokenId}/mint`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mint: {
          destination: custodyAddress,
          amount: "2",
        },
      }),
    });

    expect(mintRes.status).toBe(200);
    const minted = (await mintRes.json()) as MintApiResponse;
    expect(minted.data.transaction.status).toBe("confirmed");
    expect(minted.data.transaction.signature).toBeTruthy();

    const tokenAccount = minted.data.tokenAccount;
    expect(tokenAccount).toBeTruthy();

    const freezeRes = await request(`/v1/issuance/tokens/${tokenId}/freeze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ accountAddress: tokenAccount }),
    });

    expect(freezeRes.status).toBe(201);
    const frozen = (await freezeRes.json()) as FreezeApiResponse;
    expect(frozen.data.frozenAccount.accountAddress).toBe(tokenAccount);

    const unfreezeRes = await request(`/v1/issuance/tokens/${tokenId}/unfreeze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ accountAddress: tokenAccount }),
    });

    expect(unfreezeRes.status).toBe(200);
    const unfrozen = (await unfreezeRes.json()) as UnfreezeApiResponse;
    expect(unfrozen.data.frozenAccount.accountAddress).toBe(tokenAccount);

    const burnRes = await request(`/v1/issuance/tokens/${tokenId}/burn`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        burn: {
          source: tokenAccount,
          amount: "1",
        },
      }),
    });

    expect(burnRes.status).toBe(200);
    const burned = (await burnRes.json()) as BurnApiResponse;
    expect(burned.data.transaction.status).toBe("confirmed");
    expect(burned.data.transaction.signature).toBeTruthy();
  });

  it("submits signer-check memo with Privy wallet-bound API key via Kora", {
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

      expect(signerCheckRes.status).toBe(200);
      const signerCheckBody = (await signerCheckRes.json()) as SignerCheckApiResponse;
      const signerCheck = signerCheckBody.data;

      expect(signerCheck.walletId).toBe(walletId);
      expect(signerCheck.walletAddress).toBe(walletAddress);
      expect(signerCheck.memo).toBe(memo);
      expect(signerCheck.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,88}$/);
      expect(signerCheck.feePayer).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(signerCheck.feePayer).not.toBe(signerCheck.walletAddress);

      const tx = await callSolanaRpc<ParsedTransactionResponse | null>("getTransaction", [
        signerCheck.signature,
        {
          commitment: "confirmed",
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
        },
      ]);

      expect(tx).toBeTruthy();
      if (!tx) {
        return;
      }

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
