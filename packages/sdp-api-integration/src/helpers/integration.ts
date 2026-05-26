import { getDb } from "@sdp/api/db";
import app from "@sdp/api/index";
import { hashString } from "@sdp/api/lib/hash";
import { createFeePaymentAdapter } from "@sdp/api/services/adapters/fee-payment";
import { createSigningService } from "@sdp/api/services/domain/signing.service";
import { createMosaicService } from "@sdp/api/services/mosaic";
import { createToken2022Service, Token2022Service } from "@sdp/api/services/solana";
import {
  confirmTransaction,
  createRpc,
  getMinimumBalanceForRentExemption,
  getRecentBlockhash,
} from "@sdp/api/services/solana/rpc";
import type { CustodyWallet } from "@sdp/api/services/stores/custody-config.store";
import { TEST_ORG, TEST_USER } from "@sdp/api-test/fixtures/organizations";
import {
  TEST_PROJECT,
  TEST_PROJECT_API_KEY,
  TEST_PROJECT_CACHED_KEY,
} from "@sdp/api-test/fixtures/tokens";
import { clearTestDatabase, seedTestDatabase } from "@sdp/api-test/mocks/db";
import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { env } from "#env-impl";

const PRIVY_CONFIGURED = !!env.PRIVY_APP_ID && !!env.PRIVY_APP_SECRET;
const SOLANA_CONFIGURED = !!env.SOLANA_RPC_URL && PRIVY_CONFIGURED;
const KORA_CONFIGURED = !!env.KORA_RPC_URL;
const RUN_INTEGRATION_TESTS = env.RUN_INTEGRATION_TESTS === "true";

let cachedKeyHash: string | null = null;
let cachedCustodyAddress: string | null = null;
// 0.01 SOL — enough to cover sRFC-37 deploy paths where custody pays directly
// (~0.0043 SOL for mint + listConfig + walletEntry rent), with margin for follow-up ops.
const PRIVY_INTEGRATION_AIRDROP_LAMPORTS = 10_000_000;
const KORA_MAX_TRANSFER_LAMPORTS = 10_000_000n;

type SolanaRpcResponse<T> =
  | { jsonrpc: "2.0"; id: number; result: T }
  | { jsonrpc: "2.0"; id: number; error: { code: number; message: string; data?: unknown } };

async function computeApiKeyHash(): Promise<string> {
  if (cachedKeyHash) {
    return cachedKeyHash;
  }

  const pepper = (env as { API_KEY_PEPPER: string }).API_KEY_PEPPER;
  cachedKeyHash = await hashString(TEST_PROJECT_API_KEY.raw, pepper);
  return cachedKeyHash;
}

export async function initIntegrationSuite() {
  await seedTestDatabase(env);

  const apiKeyHash = await computeApiKeyHash();
  const state = await resetIntegrationState(apiKeyHash);

  return { apiKeyHash, custodyAddress: state.custodyAddress };
}

export async function resetIntegrationState(
  apiKeyHash: string
): Promise<{ custodyAddress: string }> {
  const db = getDb(env);
  const apiKeysKV = env.SDP_API_KEYS;
  const rateLimitKV = env.SDP_RATE_LIMITS;

  const rateLimitKeys = await rateLimitKV.list();
  for (const key of rateLimitKeys.keys) {
    await rateLimitKV.delete(key.name);
  }

  await db
    .prepare("DELETE FROM signing_requests")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM frozen_accounts")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM token_allowlist_statuses")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM token_allowlists")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM issuance_transaction_statuses")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM issuance_transactions")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM issued_token_extensions")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM issued_tokens")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM project_members")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM api_keys WHERE project_id IS NOT NULL")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM projects")
    .run()
    .catch(() => {});

  await db
    .prepare(
      "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
    )
    .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
    .run();

  await db
    .prepare(
      "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
    )
    .bind(TEST_USER.id, TEST_USER.email)
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO projects (id, organization_id, name, slug, environment, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      TEST_PROJECT.id,
      TEST_PROJECT.organizationId,
      TEST_PROJECT.name,
      TEST_PROJECT.slug,
      TEST_PROJECT.environment,
      TEST_PROJECT.status,
      TEST_PROJECT.createdBy
    )
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO api_keys
       (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, environment, status)
       VALUES (?, ?, ?, ?, 'Project Test Key', ?, ?, 'api_admin', '["*"]', 'sandbox', 'active')`
    )
    .bind(
      TEST_PROJECT_API_KEY.id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      TEST_USER.id,
      TEST_PROJECT_API_KEY.prefix,
      apiKeyHash
    )
    .run();

  await apiKeysKV.put(`key:${apiKeyHash}`, JSON.stringify(TEST_PROJECT_CACHED_KEY));
  cachedCustodyAddress = await ensurePrivyCustodyAddress();
  return { custodyAddress: cachedCustodyAddress };
}

export async function cleanupIntegrationSuite() {
  await clearTestDatabase(env);
}

export function request(url: string, init?: RequestInit) {
  return app.request(url, init, env);
}

export function requestWithApiKey(apiKey: string = TEST_PROJECT_API_KEY.raw) {
  return (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${apiKey}`);
    return request(url, { ...init, headers });
  };
}

async function ensurePrivyCustodyAddress(): Promise<string> {
  if (!SOLANA_CONFIGURED) {
    return "";
  }

  const db = getDb(env);
  const signingService = createSigningService(env);
  const existing = await signingService.getConfigurationByProvider(TEST_ORG.id, undefined, "privy");

  if (!existing) {
    await signingService.initializePrivySigning(TEST_ORG.id, undefined, {
      walletLabel: "Integration Root Wallet",
    });
  } else {
    await signingService.setDefaultProvider(TEST_ORG.id, undefined, "privy");
  }

  const config = await signingService.getConfigurationByProvider(TEST_ORG.id, undefined, "privy");
  if (!config) {
    throw new Error("Integration precondition failed: Privy signer configuration not found.");
  }

  if (!config.defaultWalletId) {
    const fallbackWallet = await db
      .prepare(
        `SELECT wallet_id
       FROM custody_wallets
       WHERE custody_config_id = ? AND status = 'active'
       ORDER BY created_at ASC
       LIMIT 1`
      )
      .bind(config.id)
      .first<{ wallet_id: string }>();

    if (!fallbackWallet) {
      throw new Error("Integration precondition failed: Privy signer has no active wallets.");
    }

    await db
      .prepare(
        `UPDATE custody_configs
       SET default_wallet_id = ?, updated_at = datetime('now')
       WHERE id = ?`
      )
      .bind(fallbackWallet.wallet_id, config.id)
      .run();
  }

  const walletRows = (
    await db
      .prepare(
        `SELECT wallet_id, public_key
       FROM custody_wallets
       WHERE custody_config_id = ? AND status = 'active'
       ORDER BY created_at ASC`
      )
      .bind(config.id)
      .all<{ wallet_id: string; public_key: string }>()
  ).results;

  let preferredWallet = walletRows.find((wallet) => wallet.wallet_id === config.defaultWalletId);
  if (!preferredWallet) {
    preferredWallet = walletRows[0];
  }

  if (!preferredWallet) {
    throw new Error("Integration precondition failed: Privy signer has no active wallets.");
  }

  for (const wallet of walletRows) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await solanaAccountExists(env.SOLANA_RPC_URL as string, wallet.public_key);
    if (!exists) {
      continue;
    }

    preferredWallet = wallet;
    break;
  }

  if (preferredWallet.wallet_id !== config.defaultWalletId) {
    await db
      .prepare(
        `UPDATE custody_configs
       SET default_wallet_id = ?, updated_at = datetime('now')
       WHERE id = ?`
      )
      .bind(preferredWallet.wallet_id, config.id)
      .run();
  }

  const address = preferredWallet.public_key;
  await ensureAddressAccountExists(address);
  // Top up existing wallets too — sRFC-37 deploy paths now have custody pay
  // directly, so a 1M-lamport bootstrap left over from older runs isn't enough.
  await fundAddressToLamports(address, PRIVY_INTEGRATION_AIRDROP_LAMPORTS);
  return address;
}

async function ensureAddressAccountExists(address: string): Promise<void> {
  const rpcUrl = env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    return;
  }

  const exists = await solanaAccountExists(rpcUrl, address);
  if (exists) {
    return;
  }

  let koraFundingError: unknown = null;
  const koraFunded = await fundAddressViaKoraFeePayer(address).catch((error) => {
    koraFundingError = error;
    return false;
  });
  if (koraFunded) {
    await waitForAccountExistence(rpcUrl, address, 30_000);
    return;
  }

  try {
    await solanaRequestAirdrop(rpcUrl, address, PRIVY_INTEGRATION_AIRDROP_LAMPORTS);
    await waitForAccountExistence(rpcUrl, address, 30_000);
  } catch (airdropError) {
    const koraMessage =
      koraFundingError instanceof Error ? koraFundingError.message : String(koraFundingError);
    const airdropMessage =
      airdropError instanceof Error ? airdropError.message : String(airdropError);

    throw new Error(
      `Failed to activate Privy signer account ${address}. ` +
        `Kora funding failed: ${koraMessage}. ` +
        `Airdrop failed: ${airdropMessage}`
    );
  }
}

async function getAddressLamports(address: string): Promise<number> {
  const rpcUrl = env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    return 0;
  }

  type Balance = { value: number };
  const response = await solanaRpc<Balance>(rpcUrl, "getBalance", [
    address,
    { commitment: "confirmed" },
  ]);

  return response.value ?? 0;
}

async function fundAddressViaKoraFeePayer(
  address: string,
  lamports: bigint = BigInt(PRIVY_INTEGRATION_AIRDROP_LAMPORTS)
): Promise<boolean> {
  const rpcUrl = env.SOLANA_RPC_URL;
  if (!rpcUrl || !env.KORA_RPC_URL) {
    return false;
  }

  const feePayment = createFeePaymentAdapter(env);
  const feePayer = await feePayment.getFeePayer();
  const rpc = createRpc(env);
  let remainingLamports = lamports;

  while (remainingLamports > 0n) {
    const requestedAmount =
      remainingLamports > KORA_MAX_TRANSFER_LAMPORTS
        ? KORA_MAX_TRANSFER_LAMPORTS
        : remainingLamports;
    const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc, "confirmed");
    const minimumLamports = await getMinimumBalanceForRentExemption(rpc, 0);
    const amount = requestedAmount > minimumLamports ? requestedAmount : minimumLamports + 1n;

    const instruction = getTransferSolInstruction({
      source: createNoopSigner(feePayer),
      destination: address as Address,
      amount,
    });

    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
      (m) => appendTransactionMessageInstructions([instruction], m)
    );

    const compiled = compileTransaction(message);
    const txBytes = new Uint8Array(getTransactionEncoder().encode(compiled));
    const signature = await feePayment.signAndSend(txBytes);
    const confirmation = await confirmTransaction(rpc, signature, { commitment: "confirmed" });

    if (confirmation.err) {
      return false;
    }

    remainingLamports -= requestedAmount;
  }

  return true;
}

export async function fundAddressToLamports(
  address: string,
  minimumLamports: number
): Promise<void> {
  const currentLamports = await getAddressLamports(address);
  if (currentLamports >= minimumLamports) {
    return;
  }

  const requiredLamports = minimumLamports - currentLamports;
  let koraFundingError: unknown = null;
  const koraFunded = await fundAddressViaKoraFeePayer(address, BigInt(requiredLamports)).catch(
    (error) => {
      koraFundingError = error;
      return false;
    }
  );

  if (koraFunded) {
    await waitForLamports(address, minimumLamports, 30_000);
    return;
  }

  try {
    await solanaRequestAirdrop(env.SOLANA_RPC_URL as string, address, requiredLamports);
    await waitForLamports(address, minimumLamports, 30_000);
  } catch (airdropError) {
    const koraMessage =
      koraFundingError instanceof Error ? koraFundingError.message : String(koraFundingError);
    const airdropMessage =
      airdropError instanceof Error ? airdropError.message : String(airdropError);

    throw new Error(
      `Failed to fund wallet ${address} to ${minimumLamports} lamports. ` +
        `Kora funding failed: ${koraMessage}. ` +
        `Airdrop failed: ${airdropMessage}`
    );
  }
}

async function solanaAccountExists(rpcUrl: string, address: string): Promise<boolean> {
  type AccountInfo = { value: null | object };
  const response = await solanaRpc<AccountInfo>(rpcUrl, "getAccountInfo", [
    address,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  return response.value !== null;
}

async function solanaRequestAirdrop(
  rpcUrl: string,
  address: string,
  lamports: number
): Promise<void> {
  await solanaRpc<string>(rpcUrl, "requestAirdrop", [address, lamports]);
}

async function waitForAccountExistence(
  rpcUrl: string,
  address: string,
  timeoutMs: number
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await solanaAccountExists(rpcUrl, address);
    if (exists) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for Privy signer account ${address} to exist on-chain.`);
}

async function waitForLamports(address: string, minimumLamports: number, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const lamports = await getAddressLamports(address);
    if (lamports >= minimumLamports) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for ${address} to reach ${minimumLamports} lamports.`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function solanaRpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });

      const payload = (await response.json()) as SolanaRpcResponse<T>;
      if ("error" in payload) {
        throw new Error(payload.error.message ?? `Solana RPC error calling ${method}`);
      }

      return payload.result;
    } catch (error) {
      if (attempt < maxRetries && isRetryableSolanaRpcError(error)) {
        await sleep((attempt + 1) * 500);
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Solana RPC error calling ${method}`);
}

function isRetryableSolanaRpcError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("unable to complete request") ||
    message.includes("request timed out") ||
    message.includes("timed out") ||
    message.includes("service unavailable") ||
    message.includes("try again") ||
    message.includes("too many requests") ||
    message.includes("429") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504")
  );
}

export async function createFundedPrivyWallet(input: {
  label: string;
  fundLamports?: number;
  setDefault?: boolean;
}): Promise<CustodyWallet> {
  const signingService = createSigningService(env);
  const wallet = await signingService.createWallet(TEST_ORG.id, undefined, {
    provider: "privy",
    label: input.label,
    setDefault: input.setDefault,
  });

  if (input.fundLamports && input.fundLamports > 0) {
    await fundAddressToLamports(wallet.publicKey, input.fundLamports);
  } else {
    await ensureAddressAccountExists(wallet.publicKey);
  }

  return wallet;
}

export {
  app,
  createMosaicService,
  createToken2022Service,
  ensurePrivyCustodyAddress,
  env,
  KORA_CONFIGURED,
  PRIVY_CONFIGURED,
  RUN_INTEGRATION_TESTS,
  SOLANA_CONFIGURED,
  TEST_ORG,
  TEST_PROJECT,
  TEST_PROJECT_API_KEY,
  TEST_PROJECT_CACHED_KEY,
  TEST_USER,
  Token2022Service,
};
