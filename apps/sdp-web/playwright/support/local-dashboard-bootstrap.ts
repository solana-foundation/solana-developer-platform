import fs from "node:fs";
import path from "node:path";
import type { OrganizationTier, PaymentsDashboardWallet } from "@sdp/types";
import {
  type Address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { KoraClient } from "@solana/kora";
import { getTransferSolInstruction } from "@solana-program/system";
import { Client } from "pg";
import { type ClerkTestIdentity, setClerkOrganizationTier } from "./clerk-admin";
import { createLocalApiClient, type LocalApiClient } from "./local-api-client";

const PLAYWRIGHT_LOCAL_ORG_ID_PREFIX = "org_e2e_dashboard";
const PLAYWRIGHT_LOCAL_ORG_NAME_PREFIX = "E2E Dashboard Org";
const PLAYWRIGHT_LOCAL_ORG_SLUG_PREFIX = "e2e-dashboard";
const PLAYWRIGHT_LOCAL_USER_ID = "usr_e2e_dashboard_admin";
const PLAYWRIGHT_LOCAL_MEMBER_ID = "mem_e2e_dashboard_admin";
const PLAYWRIGHT_LOCAL_ORG_AUTH_ID = "aoi_e2e_dashboard";
const PLAYWRIGHT_LOCAL_USER_AUTH_ID = "aui_e2e_dashboard";
const DEFAULT_LOCAL_API_URL = "http://127.0.0.1:8788";
const DEFAULT_CLERK_JWT_TEMPLATE = "sdp-api";
const DEFAULT_KORA_RPC_URL = "https://your-kora-devnet-instance.us-central1.run.app";
const DEFAULT_SOLANA_RPC_URL = "https://api.devnet.solana.com";
const KORA_MAX_TRANSFER_LAMPORTS = BigInt(10_000_000);
const ZERO_LAMPORTS = BigInt(0);
const ONE_LAMPORT = BigInt(1);
const SOLANA_LAMPORTS_PER_SOL = 1_000_000_000;

interface PlaywrightApiRuntimeEnv {
  clerkJwtTemplate: string;
  localApiBaseUrl: string;
  koraApiKey: string | null;
  koraRpcUrl: string | null;
  solanaRpcUrl: string;
}

interface CreateWalletResponse {
  wallet: PlaywrightWalletFixture;
}

interface InitializeWalletResponse {
  configId: string;
  publicKey: string;
  walletId: string;
}

interface ListWalletsResponse {
  wallets: PaymentsDashboardWallet[];
}

interface RpcRelayResponse {
  response?: {
    error?: {
      message?: string;
    };
    result?: unknown;
  };
}

type SolanaRpcResponse<T> =
  | { jsonrpc: "2.0"; id: number | string; result: T }
  | { jsonrpc: "2.0"; id: number | string; error: { code: number; message: string } };

export interface PlaywrightWalletFixture {
  id: string;
  walletId: string;
  publicKey: string;
  label: string | null;
}

export interface WalletBootstrapResult {
  organization: {
    clerkOrgId: string;
    localOrgId: string;
    slug: string;
    name: string;
  };
  wallets: PlaywrightWalletFixture[];
}

interface PlaywrightOrganizationFixture {
  id: string;
  name: string;
  slug: string;
}

interface EnsureLinkedOrgOptions {
  tier?: OrganizationTier;
}

function getPlaywrightApiRuntimeEnv(): PlaywrightApiRuntimeEnv {
  return {
    clerkJwtTemplate:
      process.env.CLERK_JWT_TEMPLATE ??
      process.env.NEXT_PUBLIC_CLERK_JWT_TEMPLATE ??
      DEFAULT_CLERK_JWT_TEMPLATE,
    localApiBaseUrl: process.env.PLAYWRIGHT_API_URL ?? DEFAULT_LOCAL_API_URL,
    koraApiKey: getLocalDevVar("KORA_API_KEY"),
    koraRpcUrl: getLocalDevVar("KORA_RPC_URL") ?? DEFAULT_KORA_RPC_URL,
    solanaRpcUrl: getLocalDevVar("SOLANA_RPC_URL") ?? DEFAULT_SOLANA_RPC_URL,
  };
}

function getLocalDevVars(): Map<string, string> {
  const devVarsPath = path.resolve(__dirname, "../../../sdp-api/.dev.vars");
  const values = new Map<string, string>();

  if (fs.existsSync(devVarsPath)) {
    const contents = fs.readFileSync(devVarsPath, "utf8");
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      const [key, ...rest] = line.split("=");
      const value = rest.join("=").trim();
      if (key && value) {
        values.set(key, value);
      }
    }
  }

  return values;
}

function getLocalDevVar(name: string): string | null {
  const explicitValue = process.env[name]?.trim();
  if (explicitValue) {
    return explicitValue;
  }

  return getLocalDevVars().get(name) ?? null;
}

function getPlaywrightDatabaseUrl(): string {
  const databaseUrl = getLocalDevVar("DATABASE_URL");
  if (databaseUrl) {
    return databaseUrl;
  }

  const localDatabaseUrl = new URL("postgresql://127.0.0.1:5432/sdp");
  localDatabaseUrl.username = "sdp";
  localDatabaseUrl.password = "sdp";
  return localDatabaseUrl.toString();
}

function toFixtureWallet(wallet: PaymentsDashboardWallet): PlaywrightWalletFixture {
  return {
    id: wallet.id,
    walletId: wallet.walletId,
    publicKey: wallet.publicKey,
    label: wallet.label ?? null,
  };
}

function parseSolAmountToLamports(amountSol: number): number {
  const lamports = Math.round(amountSol * SOLANA_LAMPORTS_PER_SOL);
  if (!Number.isFinite(lamports) || lamports <= 0) {
    throw new Error(`Invalid SOL bootstrap amount: ${amountSol}`);
  }

  return lamports;
}

function buildPlaywrightOrganizationFixture(
  identity: ClerkTestIdentity
): PlaywrightOrganizationFixture {
  const suffix = `${Date.now().toString(36)}-${identity.organizationId.slice(-6).toLowerCase()}`;
  return {
    id: `${PLAYWRIGHT_LOCAL_ORG_ID_PREFIX}_${suffix}`,
    name: `${PLAYWRIGHT_LOCAL_ORG_NAME_PREFIX} ${suffix}`,
    slug: `${PLAYWRIGHT_LOCAL_ORG_SLUG_PREFIX}-${suffix}`,
  };
}

async function withDatabaseClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: getPlaywrightDatabaseUrl(),
  });

  await client.connect();

  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function listMappedOrganizationIds(
  client: Client,
  identity: ClerkTestIdentity
): Promise<string[]> {
  const result = await client.query<{ organization_id: string }>(
    `SELECT organization_id
     FROM auth_organization_identities
     WHERE provider = 'clerk' AND provider_org_id = $1`,
    [identity.organizationId]
  );

  return result.rows.map((row) => row.organization_id);
}

async function ensureLocalUserIdentity(
  client: Client,
  identity: ClerkTestIdentity
): Promise<string> {
  const clerkEmail = identity.email.toLowerCase();
  const existingIdentity = await client.query<{ user_id: string }>(
    `SELECT user_id
     FROM auth_user_identities
     WHERE provider = 'clerk' AND provider_user_id = $1
     LIMIT 1`,
    [identity.userId]
  );

  const existingUser =
    existingIdentity.rows[0]?.user_id ||
    (
      await client.query<{ id: string }>(
        `SELECT id
         FROM users
         WHERE email = $1
         LIMIT 1`,
        [clerkEmail]
      )
    ).rows[0]?.id ||
    PLAYWRIGHT_LOCAL_USER_ID;

  await client.query(
    `INSERT INTO users (id, email, email_verified, name, status)
     VALUES ($1, $2, 1, 'SDP E2E Admin', 'active')
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email,
       email_verified = EXCLUDED.email_verified,
       name = EXCLUDED.name,
       status = EXCLUDED.status`,
    [existingUser, clerkEmail]
  );

  await client.query(
    `INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
     VALUES ($1, 'clerk', $2, $3, $4)
     ON CONFLICT (provider, provider_user_id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       email = EXCLUDED.email,
       updated_at = sdp_datetime_now()`,
    [PLAYWRIGHT_LOCAL_USER_AUTH_ID, identity.userId, existingUser, clerkEmail]
  );

  return existingUser;
}

async function clearPlaywrightOrganizations(
  client: Client,
  identity: ClerkTestIdentity
): Promise<void> {
  const mappedOrganizationIds = await listMappedOrganizationIds(client, identity);
  const prefixedOrganizations = await client.query<{ id: string }>(
    `SELECT id
     FROM organizations
     WHERE id LIKE $1`,
    [`${PLAYWRIGHT_LOCAL_ORG_ID_PREFIX}%`]
  );
  const organizationIds = [
    ...new Set([...mappedOrganizationIds, ...prefixedOrganizations.rows.map((row) => row.id)]),
  ];

  await client.query(
    `DELETE FROM auth_organization_identities
     WHERE provider = 'clerk' AND provider_org_id = $1`,
    [identity.organizationId]
  );

  if (organizationIds.length > 0) {
    await client.query("DELETE FROM organizations WHERE id = ANY($1::text[])", [organizationIds]);
  }
}

async function listWallets(api: LocalApiClient): Promise<PaymentsDashboardWallet[]> {
  // biome-ignore lint/security/noSecrets: Local API path with query params for wallet listing.
  const data = await api.get<ListWalletsResponse>("/v1/wallets?includeAllProviders=true");
  return data.wallets;
}

async function requestWalletAirdropLamports(
  api: LocalApiClient,
  walletAddress: string,
  lamports: number
): Promise<void> {
  const runtimeEnv = getPlaywrightApiRuntimeEnv();

  try {
    const response = await fetch(runtimeEnv.solanaRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `wallet-faucet-${walletAddress}`,
        method: "requestAirdrop",
        params: [walletAddress, lamports],
      }),
    });
    const payload = (await response.json()) as SolanaRpcResponse<string>;
    if ("error" in payload) {
      throw new Error(payload.error.message);
    }
    return;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
  }

  const response = await api.post<RpcRelayResponse>("/v1/rpc/proxy", {
    jsonrpc: "2.0",
    id: `wallet-faucet-${walletAddress}`,
    method: "requestAirdrop",
    params: [walletAddress, lamports],
  });

  if (response.response?.error?.message) {
    throw new Error(response.response.error.message);
  }
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function getLatestBlockhash(api: LocalApiClient): Promise<{
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
}> {
  const response = await api.post<RpcRelayResponse>("/v1/rpc/proxy", {
    jsonrpc: "2.0",
    id: "wallet-latest-blockhash",
    // biome-ignore lint/security/noSecrets: Solana RPC method name, not a credential.
    method: "getLatestBlockhash",
    params: [{ commitment: "confirmed" }],
  });

  if (response.response?.error?.message) {
    throw new Error(response.response.error.message);
  }

  const value = (
    response.response?.result as {
      value?: { blockhash?: string; lastValidBlockHeight?: number };
    }
  )?.value;

  if (!value?.blockhash || typeof value.lastValidBlockHeight !== "number") {
    throw new Error("RPC provider did not return a confirmed blockhash");
  }

  return {
    blockhash: value.blockhash as Blockhash,
    lastValidBlockHeight: BigInt(Math.max(0, Math.trunc(value.lastValidBlockHeight))),
  };
}

async function getMinimumBalanceForRentExemption(api: LocalApiClient): Promise<bigint> {
  const response = await api.post<RpcRelayResponse>("/v1/rpc/proxy", {
    jsonrpc: "2.0",
    id: "wallet-rent-exemption",
    // biome-ignore lint/security/noSecrets: Solana RPC method name, not a credential.
    method: "getMinimumBalanceForRentExemption",
    params: [0],
  });

  if (response.response?.error?.message) {
    throw new Error(response.response.error.message);
  }

  const rentExemption = response.response?.result;
  if (typeof rentExemption !== "number" || !Number.isFinite(rentExemption)) {
    throw new Error("RPC provider did not return a valid rent exemption amount");
  }

  return BigInt(Math.max(0, Math.trunc(rentExemption)));
}

async function fundAddressViaKoraFeePayer(
  api: LocalApiClient,
  address: string,
  lamports: bigint
): Promise<boolean> {
  const runtimeEnv = getPlaywrightApiRuntimeEnv();
  const client = new KoraClient({
    rpcUrl: runtimeEnv.koraRpcUrl ?? DEFAULT_KORA_RPC_URL,
    ...(runtimeEnv.koraApiKey ? { apiKey: runtimeEnv.koraApiKey } : {}),
  });
  const payerSignerResponse = await client.getPayerSigner();
  const feePayer =
    (payerSignerResponse as { signer_address?: string }).signer_address ??
    (payerSignerResponse as { payment_address?: string }).payment_address ??
    (payerSignerResponse as { payerSigner?: string }).payerSigner;

  if (!feePayer) {
    throw new Error("Kora did not return a fee payer address");
  }

  let remainingLamports = lamports;
  while (remainingLamports > ZERO_LAMPORTS) {
    const requestedAmount =
      remainingLamports > KORA_MAX_TRANSFER_LAMPORTS
        ? KORA_MAX_TRANSFER_LAMPORTS
        : remainingLamports;
    const { blockhash, lastValidBlockHeight } = await getLatestBlockhash(api);
    const minimumLamports = await getMinimumBalanceForRentExemption(api);
    const amount =
      requestedAmount > minimumLamports ? requestedAmount : minimumLamports + ONE_LAMPORT;
    const instruction = getTransferSolInstruction({
      source: createNoopSigner(feePayer as Address),
      destination: address as Address,
      amount,
    });
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(feePayer as Address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
      (m) => appendTransactionMessageInstructions([instruction], m)
    );
    const compiled = compileTransaction(message);
    const transactionBytes = new Uint8Array(getTransactionEncoder().encode(compiled));

    await client.signAndSendTransaction({
      transaction: encodeBase64(transactionBytes),
    });
    remainingLamports -= requestedAmount;
  }

  return true;
}

async function getWalletLamports(api: LocalApiClient, walletAddress: string): Promise<number> {
  const response = await api.post<RpcRelayResponse>("/v1/rpc/proxy", {
    jsonrpc: "2.0",
    id: `wallet-balance-${walletAddress}`,
    method: "getBalance",
    params: [walletAddress, { commitment: "confirmed" }],
  });

  const result = response.response?.result;
  if (
    !result ||
    typeof result !== "object" ||
    !("value" in result) ||
    typeof (result as { value?: unknown }).value !== "number"
  ) {
    return 0;
  }

  return (result as { value: number }).value;
}

async function waitForWalletLamports(
  api: LocalApiClient,
  walletAddress: string,
  minimumLamports: number
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 60_000) {
    const lamports = await getWalletLamports(api, walletAddress);
    if (lamports >= minimumLamports) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(
    `Timed out waiting for wallet ${walletAddress} to reach ${minimumLamports} lamports`
  );
}

async function fundWalletToLamports(
  api: LocalApiClient,
  walletAddress: string,
  minimumLamports: number
): Promise<void> {
  const existingLamports = await getWalletLamports(api, walletAddress);
  if (existingLamports >= minimumLamports) {
    return;
  }

  const lamportsNeeded = minimumLamports - existingLamports;
  let koraFundingError: unknown = null;
  const koraFunded = await fundAddressViaKoraFeePayer(
    api,
    walletAddress,
    BigInt(lamportsNeeded)
  ).catch((error) => {
    koraFundingError = error;
    return false;
  });

  if (koraFunded) {
    await waitForWalletLamports(api, walletAddress, minimumLamports);
    return;
  }

  try {
    await requestWalletAirdropLamports(api, walletAddress, lamportsNeeded);
    await waitForWalletLamports(api, walletAddress, minimumLamports);
  } catch (airdropError) {
    const koraMessage =
      koraFundingError instanceof Error ? koraFundingError.message : String(koraFundingError);
    const airdropMessage =
      airdropError instanceof Error ? airdropError.message : String(airdropError);

    throw new Error(
      `Failed to fund wallet ${walletAddress} to ${minimumLamports} lamports. ` +
        `Kora funding failed: ${koraMessage}. ` +
        `Airdrop failed: ${airdropMessage}`
    );
  }
}

export async function ensureUnlinkedOrg(identity: ClerkTestIdentity): Promise<void> {
  await setClerkOrganizationTier(identity.organizationId, "enterprise");

  await withDatabaseClient(async (client) => {
    await client.query("BEGIN");

    try {
      await clearPlaywrightOrganizations(client, identity);
      await ensureLocalUserIdentity(client, identity);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
}

export async function ensureLinkedOrg(
  identity: ClerkTestIdentity,
  options?: EnsureLinkedOrgOptions
): Promise<PlaywrightOrganizationFixture> {
  const organization = buildPlaywrightOrganizationFixture(identity);
  const tier = options?.tier ?? "enterprise";

  await setClerkOrganizationTier(identity.organizationId, tier);

  await withDatabaseClient(async (client) => {
    await client.query("BEGIN");

    try {
      await clearPlaywrightOrganizations(client, identity);
      const userId = await ensureLocalUserIdentity(client, identity);

      await client.query(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES ($1, $2, $3, $4, 'active')
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           slug = EXCLUDED.slug,
           tier = EXCLUDED.tier,
           status = EXCLUDED.status,
           updated_at = sdp_datetime_now()`,
        [organization.id, organization.name, organization.slug, tier]
      );

      await client.query(
        `INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id, slug)
         VALUES ($1, 'clerk', $2, $3, $4)
         ON CONFLICT (provider, provider_org_id) DO UPDATE SET
           organization_id = EXCLUDED.organization_id,
           slug = EXCLUDED.slug,
           updated_at = sdp_datetime_now()`,
        [PLAYWRIGHT_LOCAL_ORG_AUTH_ID, identity.organizationId, organization.id, organization.slug]
      );

      await client.query(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES ($1, $2, $3, 'admin', 'active')
         ON CONFLICT (organization_id, user_id) DO UPDATE SET
           role = EXCLUDED.role,
           status = EXCLUDED.status`,
        [PLAYWRIGHT_LOCAL_MEMBER_ID, organization.id, userId]
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });

  return organization;
}

export async function bootstrapLocalWalletFixtures(input: {
  identity: ClerkTestIdentity;
  bearerToken: string;
  provider?: "privy";
  walletCount?: number;
  fundSourceWallet?: boolean;
  fundSourceAmountSol?: number;
  tier?: OrganizationTier;
}): Promise<WalletBootstrapResult> {
  const { identity, bearerToken } = input;
  const walletCount = Math.max(1, input.walletCount ?? 1);
  const provider = input.provider ?? "privy";
  const fundSourceWallet = input.fundSourceWallet ?? false;
  const fundSourceAmountSol = input.fundSourceAmountSol ?? 1;
  const runtimeEnv = getPlaywrightApiRuntimeEnv();
  const api = createLocalApiClient(runtimeEnv.localApiBaseUrl, bearerToken);

  const organization = await ensureLinkedOrg(identity, {
    tier: input.tier,
  });

  const initialized = await api.post<InitializeWalletResponse>("/v1/wallets/initialize", {
    provider,
    walletLabel: "Treasury",
  });

  const createdWalletIds = [initialized.walletId];

  for (let index = 1; index < walletCount; index += 1) {
    const created = await api.post<CreateWalletResponse>("/v1/wallets", {
      provider,
      label: index === 1 ? "Delegated" : `Wallet ${index + 1}`,
    });
    createdWalletIds.push(created.wallet.walletId);
  }

  const listedWallets = await listWallets(api);
  const wallets = createdWalletIds
    .map((walletId) => listedWallets.find((wallet) => wallet.walletId === walletId))
    .filter((wallet): wallet is PaymentsDashboardWallet => Boolean(wallet))
    .map(toFixtureWallet);

  if (wallets.length !== walletCount) {
    throw new Error(`Failed to resolve ${walletCount} seeded wallet(s) for Playwright bootstrap`);
  }

  if (fundSourceWallet) {
    const sourceWallet = wallets[0];
    if (!sourceWallet) {
      throw new Error("No source wallet available for Playwright funding bootstrap");
    }

    const minimumLamports = parseSolAmountToLamports(fundSourceAmountSol);
    await fundWalletToLamports(api, sourceWallet.publicKey, minimumLamports);
  }

  return {
    organization: {
      clerkOrgId: identity.organizationId,
      localOrgId: organization.id,
      slug: organization.slug,
      name: organization.name,
    },
    wallets,
  };
}

export async function createExternalSolanaAddress(): Promise<string> {
  const signer = await generateKeyPairSigner();
  return signer.address;
}

export function getBootstrapApiBaseUrl(): string {
  return getPlaywrightApiRuntimeEnv().localApiBaseUrl;
}

export function getBootstrapClerkJwtTemplate(): string {
  return getPlaywrightApiRuntimeEnv().clerkJwtTemplate;
}

export const seedLocalClerkOrganizationMapping = ensureLinkedOrg;
