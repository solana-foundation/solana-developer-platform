import { type ApiTestCustodyWallet, apiTestSupport } from "@sdp/api/test-support";
import {
  confirmTransaction,
  createRpc,
  getMinimumBalanceForRentExemption,
  getRecentBlockhash,
} from "@sdp/rpc/solana";
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
import { getIntegrationCustodyProvider } from "./custody-provider";

const {
  app,
  createKVStoreSet,
  createFeePaymentAdapter,
  createMosaicService,
  createSigningService,
  CustodyConfigStore,
  getDb,
  hashString,
  seedTestDatabase,
  TEST_ORG,
  TEST_PROJECT,
  TEST_PROJECT_API_KEY,
  TEST_PROJECT_CACHED_KEY,
  TEST_USER,
} = apiTestSupport;

const PRIVY_CONFIGURED = !!env.PRIVY_APP_ID && !!env.PRIVY_APP_SECRET;
const KORA_CONFIGURED = !!env.KORA_RPC_URL;
const RUN_INTEGRATION_TESTS = env.RUN_INTEGRATION_TESTS === "true";
const INTEGRATION_CUSTODY_PROVIDER = getIntegrationCustodyProvider();
const LOCAL_CUSTODY_CONFIGURED = !!env.CUSTODY_PRIVATE_KEY;
const INTEGRATION_CUSTODY_CONFIGURED =
  INTEGRATION_CUSTODY_PROVIDER === "local" ? LOCAL_CUSTODY_CONFIGURED : PRIVY_CONFIGURED;
const SOLANA_CONFIGURED = !!env.SOLANA_RPC_URL && INTEGRATION_CUSTODY_CONFIGURED;

let cachedKeyHash: string | null = null;
export interface IntegrationCustodyWallet {
  id: string;
  address: string;
}

let cachedCustodyWallet: IntegrationCustodyWallet | null = null;
// 0.05 SOL — enough headroom for sRFC-37 deploy paths where custody pays
// directly. A single tokenized-security deploy needs ~0.0095 SOL (mint +
// mintConfig + listConfig + extraMetas PDA rent, plus keeping custody itself
// rent-exempt). Earlier 0.01-SOL budget was a razor-thin fit for the
// stablecoin shape; the ScaledUiAmount extension on tokenized-security
// pushed the mint rent ~0.0004 SOL higher and tipped tests over.
const INTEGRATION_CUSTODY_FUND_LAMPORTS = 50_000_000;
// Fallback when the relay does not expose its policy; matches the deployed
// devnet max_allowed_lamports.
const KORA_MAX_TRANSFER_LAMPORTS = 9_900_000n;

type SolanaRpcResponse<T> =
  | { jsonrpc: "2.0"; id: number; result: T }
  | { jsonrpc: "2.0"; id: number; error: { code: number; message: string; data?: unknown } };

function getOrganizationSettingsForIntegration(): string | null {
  if (INTEGRATION_CUSTODY_PROVIDER !== "local") {
    return null;
  }

  return JSON.stringify({
    providerOverrides: {
      custody: {
        local: true,
      },
    },
  });
}

async function computeApiKeyHash(): Promise<string> {
  if (cachedKeyHash) {
    return cachedKeyHash;
  }

  const pepper = (env as { API_KEY_PEPPER: string }).API_KEY_PEPPER;
  const hash = await hashString(TEST_PROJECT_API_KEY.raw, pepper);
  cachedKeyHash = hash;
  return hash;
}

/** Initialize tenant and API-key fixtures without provisioning a funded custody wallet. */
export async function initIntegrationApiSuite() {
  await seedTestDatabase(env);

  const apiKeyHash = await computeApiKeyHash();
  await resetIntegrationApiState(apiKeyHash);

  return { apiKeyHash };
}

export async function initIntegrationSuite() {
  await seedTestDatabase(env);

  const apiKeyHash = await computeApiKeyHash();
  const state = await resetIntegrationState(apiKeyHash);

  return { apiKeyHash, ...state };
}

export async function resetIntegrationState(
  apiKeyHash: string
): Promise<{ custodyAddress: string; custodyWallet: IntegrationCustodyWallet }> {
  await resetIntegrationApiState(apiKeyHash);
  cachedCustodyWallet = await ensureIntegrationCustodyWallet();
  return { custodyAddress: cachedCustodyWallet.address, custodyWallet: cachedCustodyWallet };
}

async function resetIntegrationApiState(apiKeyHash: string): Promise<void> {
  cachedCustodyWallet = null;
  const db = getDb(env);
  const { apiKeys: apiKeysKV, rateLimits: rateLimitKV } = createKVStoreSet(env);

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
      "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status, settings) VALUES (?, ?, ?, 'individual', 'active', ?)"
    )
    .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, getOrganizationSettingsForIntegration())
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
       (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
       VALUES (?, ?, ?, ?, 'Project Test Key', ?, ?, 'api_admin', '["*"]', 'active')`
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
}

export async function cleanupIntegrationSuite() {
  await seedTestDatabase(env);
}

type IntegrationRequestInit = RequestInit & {
  timeoutMs?: number;
};

const UNKEYED_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Gives every mutating request an Idempotency-Key unless the caller set one,
 * because value-moving routes require it (HOO-1918). A test that exercises
 * retries passes its own key so both attempts share it.
 */
function withIdempotencyKey(init: RequestInit): RequestInit {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (UNKEYED_METHODS.has(method) || headers.has("Idempotency-Key")) {
    return init;
  }
  headers.set("Idempotency-Key", crypto.randomUUID());
  return { ...init, headers };
}

export async function request(url: string, init: IntegrationRequestInit = {}) {
  const { timeoutMs, ...unkeyedInit } = init;
  const requestInit = withIdempotencyKey(unkeyedInit);

  if (!timeoutMs || timeoutMs <= 0) {
    return app.request(url, requestInit, env);
  }

  const controller = new AbortController();
  const operation = Promise.resolve(
    app.request(url, { ...requestInit, signal: controller.signal }, env)
  );
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  void operation.catch(() => undefined);

  try {
    return await Promise.race([
      operation,
      new Promise<Response>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(
            new Error(
              `Timed out waiting for ${requestInit.method ?? "GET"} ${url} after ${timeoutMs}ms`
            )
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function requestWithApiKey(apiKey: string = TEST_PROJECT_API_KEY.raw) {
  return (url: string, init: IntegrationRequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${apiKey}`);
    return request(url, { ...init, headers });
  };
}

interface IntegrationCustodyWalletRow {
  id: string;
  wallet_id: string;
  public_key: string;
}

/**
 * The active wallets of one custody config, oldest first.
 * @param configId - The custody config whose wallets are listed.
 * @returns The config's active wallet rows.
 */
async function listActiveConfigWallets(configId: string): Promise<IntegrationCustodyWalletRow[]> {
  const { results } = await getDb(env)
    .prepare(
      `SELECT id, wallet_id, public_key
       FROM custody_wallets
       WHERE custody_config_id = ? AND status = 'active'
       ORDER BY created_at ASC, id ASC`
    )
    .bind(configId)
    .all<IntegrationCustodyWalletRow>();
  return results;
}

/**
 * Fund a chosen custody wallet and return it as the suite's signing wallet.
 * @param wallet - The exact custody wallet row the suite signs with.
 * @returns The wallet's record ID and address.
 */
async function fundIntegrationCustodyWallet(
  wallet: IntegrationCustodyWalletRow
): Promise<IntegrationCustodyWallet> {
  await ensureAddressAccountExists(wallet.public_key);
  // Top up existing wallets too — sRFC-37 deploy paths now have custody pay
  // directly, so a 1M-lamport bootstrap left over from older runs isn't enough.
  await fundAddressToLamports(wallet.public_key, INTEGRATION_CUSTODY_FUND_LAMPORTS);
  return { id: wallet.id, address: wallet.public_key };
}

/**
 * The project's Managed Privy wallet the suite signs with: the oldest active wallet
 * that already exists on chain, else the oldest active wallet.
 * @returns The chosen wallet's record ID and address.
 */
async function ensurePrivyCustodyWallet(): Promise<IntegrationCustodyWallet> {
  const signingService = createSigningService(env);
  const existing = await signingService.getConfigurationByProvider(
    TEST_ORG.id,
    TEST_PROJECT.id,
    "privy"
  );
  const configId = existing
    ? existing.id
    : (
        await signingService.initializePrivySigning(TEST_ORG.id, TEST_PROJECT.id, {
          walletLabel: "Integration Root Wallet",
        })
      ).configId;

  const walletRows = await listActiveConfigWallets(configId);
  const [oldestWallet] = walletRows;
  if (!oldestWallet) {
    throw new Error("Integration precondition failed: Privy signer has no active wallets.");
  }

  for (const wallet of walletRows) {
    // eslint-disable-next-line no-await-in-loop
    if (await solanaAccountExists(env.SOLANA_RPC_URL as string, wallet.public_key)) {
      return fundIntegrationCustodyWallet(wallet);
    }
  }
  return fundIntegrationCustodyWallet(oldestWallet);
}

/**
 * The project's Managed local wallet the suite signs with: the wallet a fresh
 * initialization creates, else the config's oldest active wallet.
 * @returns The chosen wallet's record ID and address.
 */
async function ensureLocalCustodyWallet(): Promise<IntegrationCustodyWallet> {
  const signingService = createSigningService(env);
  const existing = await signingService.getConfigurationByProvider(
    TEST_ORG.id,
    TEST_PROJECT.id,
    "local"
  );

  if (!existing) {
    const initialized = await signingService.initializeLocalSigning(TEST_ORG.id, TEST_PROJECT.id, {
      walletLabel: "Integration Local Root Wallet",
    });
    const initializedWallet = (await listActiveConfigWallets(initialized.configId)).find(
      (wallet) => wallet.wallet_id === initialized.walletId
    );
    if (!initializedWallet) {
      throw new Error("Integration precondition failed: initialized local wallet not found.");
    }
    return fundIntegrationCustodyWallet(initializedWallet);
  }

  const [oldestWallet] = await listActiveConfigWallets(existing.id);
  if (!oldestWallet) {
    throw new Error("Integration precondition failed: local signer has no active wallets.");
  }
  return fundIntegrationCustodyWallet(oldestWallet);
}

/**
 * The exact custody wallet the integration suite signs with, under the configured provider.
 * @returns The wallet's record ID and address; both empty when Solana is not configured.
 */
async function ensureIntegrationCustodyWallet(): Promise<IntegrationCustodyWallet> {
  if (!SOLANA_CONFIGURED) {
    return { id: "", address: "" };
  }

  if (INTEGRATION_CUSTODY_PROVIDER === "local") {
    return ensureLocalCustodyWallet();
  }

  return ensurePrivyCustodyWallet();
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
    await solanaRequestAirdrop(rpcUrl, address, INTEGRATION_CUSTODY_FUND_LAMPORTS);
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
  lamports: bigint = BigInt(INTEGRATION_CUSTODY_FUND_LAMPORTS)
): Promise<boolean> {
  const rpcUrl = env.SOLANA_RPC_URL;
  if (!rpcUrl || !env.KORA_RPC_URL) {
    return false;
  }

  const feePayment = createFeePaymentAdapter(env);
  const feePayer = await feePayment.getFeePayer();
  const rpc = createRpc(env);
  const maxTransferLamports =
    (await feePayment
      .getSponsorshipConfiguration?.()
      .then((configuration) => configuration.maxAllowedLamports)
      .catch(() => 0n)
      .then((cap) => (cap > 0n ? cap : undefined))) ?? KORA_MAX_TRANSFER_LAMPORTS;
  let remainingLamports = lamports;

  while (remainingLamports > 0n) {
    const requestedAmount =
      remainingLamports > maxTransferLamports ? maxTransferLamports : remainingLamports;
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
  const maxRetries = 4;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });

      const responseText = await response.text();
      let payload: SolanaRpcResponse<T>;
      try {
        payload = JSON.parse(responseText) as SolanaRpcResponse<T>;
      } catch (error) {
        const parseMessage = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Solana RPC returned ${response.status} with empty/invalid body calling ${method}: ${parseMessage}`
        );
      }
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
    message.includes("empty/invalid body") ||
    message.includes("internal error") ||
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
}): Promise<ApiTestCustodyWallet> {
  const signingService = createSigningService(env);
  const wallet = await signingService.createWallet(TEST_ORG.id, TEST_PROJECT.id, {
    provider: "privy",
    label: input.label,
  });

  if (input.fundLamports && input.fundLamports > 0) {
    await fundAddressToLamports(wallet.publicKey, input.fundLamports);
  } else {
    await ensureAddressAccountExists(wallet.publicKey);
  }

  return wallet;
}

export async function createFundedIntegrationWallet(input: {
  label: string;
  fundLamports?: number;
}): Promise<ApiTestCustodyWallet> {
  if (INTEGRATION_CUSTODY_PROVIDER === "local") {
    return createFundedLocalWallet(input);
  }

  return createFundedPrivyWallet(input);
}

async function createFundedLocalWallet(input: {
  label: string;
  fundLamports?: number;
}): Promise<ApiTestCustodyWallet> {
  const { address: publicKey } = await ensureIntegrationCustodyWallet();
  const signingService = createSigningService(env);
  const config = await signingService.getConfigurationByProvider(
    TEST_ORG.id,
    TEST_PROJECT.id,
    "local"
  );
  if (!config) {
    throw new Error("Integration precondition failed: local signer configuration not found.");
  }

  const configStore = new CustodyConfigStore(getDb(env), env);
  // Local custody has one signing key; access tests still need distinct wallet IDs.
  const wallet = await configStore.createWallet(config.id, {
    walletId: `local_${crypto.randomUUID()}`,
    publicKey,
    label: input.label,
    purpose: "transfer",
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
  env,
  INTEGRATION_CUSTODY_PROVIDER,
  KORA_CONFIGURED,
  PRIVY_CONFIGURED,
  RUN_INTEGRATION_TESTS,
  SOLANA_CONFIGURED,
  TEST_ORG,
  TEST_PROJECT,
  TEST_PROJECT_API_KEY,
  TEST_PROJECT_CACHED_KEY,
  TEST_USER,
};
