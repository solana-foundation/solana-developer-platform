#!/usr/bin/env node
// biome-ignore-all lint/security/noSecrets: This local-only test shim contains public Solana program IDs, not secrets.
import http from "node:http";
import {
  createKeyPairFromBytes,
  getBase58Codec,
  getBase64Codec,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
} from "@solana/kit";

const host = process.env.KORA_SHIM_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.KORA_SHIM_PORT ?? "8080", 10);
const solanaRpcUrl = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const privateKey = process.env.SIGNER_PRIVATE_KEY;

if (!privateKey) {
  throw new Error("SIGNER_PRIVATE_KEY is required for the Kora Surfpool shim.");
}

const base58 = getBase58Codec();
const base64 = getBase64Codec();
const secretKey = base58.encode(privateKey);
if (secretKey.length !== 64) {
  throw new Error(`Invalid SIGNER_PRIVATE_KEY length: expected 64 bytes, got ${secretKey.length}`);
}

const keyPair = await createKeyPairFromBytes(secretKey);
const signerAddress = base58.decode(
  new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey))
);

const server = http.createServer(async (request, response) => {
  let requestId = 1;
  try {
    if (request.method === "GET" && (request.url === "/health" || request.url === "/liveness")) {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method !== "POST") {
      sendJson(response, 404, "Not Found");
      return;
    }

    const body = await readBody(request);
    const payload = JSON.parse(body);
    requestId = payload.id ?? 1;
    const result = await handleRpc(payload.method, payload.params);
    sendJson(response, 200, { jsonrpc: "2.0", id: requestId, result });
  } catch {
    console.error("Kora Surfpool shim request failed.");
    sendJson(response, 200, {
      jsonrpc: "2.0",
      id: requestId,
      error: {
        code: -32000,
        message: "Kora Surfpool shim request failed. See local shim logs for details.",
      },
    });
  }
});

server.listen(port, host, () => {
  console.log(`Kora Surfpool shim listening on http://${host}:${port}`);
  console.log(`Signer: ${signerAddress}`);
  console.log(`Solana RPC: ${solanaRpcUrl}`);
});

async function handleRpc(method, params) {
  switch (method) {
    case "getConfig":
      return getConfig();
    case "getPayerSigner":
      return {
        payment_address: signerAddress,
        signer_address: signerAddress,
      };
    case "getBlockhash": {
      const latest = await solanaRpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
      return {
        blockhash: latest.value.blockhash,
        lastValidBlockHeight: latest.value.lastValidBlockHeight,
      };
    }
    case "getSupportedTokens":
      return { tokens: ["So11111111111111111111111111111111111111112"] };
    case "estimateTransactionFee":
      return {
        fee_in_lamports: 5000,
        fee_in_token: 5000,
        payment_address: signerAddress,
        signer_pubkey: signerAddress,
      };
    case "signTransaction": {
      const signedTransaction = await signTransaction(params.transaction);
      return {
        signed_transaction: signedTransaction,
        signer_pubkey: signerAddress,
      };
    }
    case "signAndSendTransaction": {
      const signedTransaction = await signTransaction(params.transaction);
      const signature = await solanaRpc("sendTransaction", [
        signedTransaction,
        {
          encoding: "base64",
          preflightCommitment: "confirmed",
        },
      ]);
      return {
        signature,
        signed_transaction: signedTransaction,
        signer_pubkey: signerAddress,
      };
    }
    default:
      throw new Error(`Unsupported Kora shim method: ${method}`);
  }
}

async function signTransaction(base64Transaction) {
  if (!base64Transaction) {
    throw new Error("transaction is required");
  }
  const transactionBytes = base64.encode(base64Transaction);
  const transaction = getTransactionDecoder().decode(transactionBytes);
  const signed = await partiallySignTransaction([keyPair], transaction);
  return getBase64EncodedWireTransaction(signed);
}

async function solanaRpc(method, params = []) {
  const response = await fetch(solanaRpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error) {
    throw new Error(payload.error.message ?? `Solana RPC ${method} failed`);
  }
  return payload.result;
}

function getConfig() {
  return {
    enabled_methods: {
      estimate_transaction_fee: true,
      get_blockhash: true,
      get_config: true,
      get_payer_signer: true,
      get_supported_tokens: true,
      liveness: true,
      sign_and_send_transaction: true,
      sign_transaction: true,
      transfer_transaction: false,
    },
    fee_payers: [signerAddress],
    validation_config: {
      allowed_programs: [
        "11111111111111111111111111111111",
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
        "TACLkU6CiCdkQN2MjoyDkVg2yAH9zkxiHDsiztQ52TP",
        "GATEzzqxhJnsWF6vHRsgtixxSB8PaQdcqGEVTEHWiULz",
        "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
        "ComputeBudget111111111111111111111111111111",
      ],
      allowed_spl_paid_tokens: [],
      allowed_tokens: ["So11111111111111111111111111111111111111112"],
      disallowed_accounts: [],
      fee_payer_policy: {},
      max_allowed_lamports: 10_000_000,
      max_signatures: 10,
      price: { type: "free" },
      price_source: "Mock",
      token2022: {
        blocked_account_extensions: [],
        blocked_mint_extensions: [],
      },
    },
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  });
  response.end(typeof payload === "string" ? payload : JSON.stringify(payload));
}
