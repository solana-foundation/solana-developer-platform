import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PaymentsDashboardWallet, Token } from "@sdp/types";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  type Address,
  type Blockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Codec,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { KoraClient } from "@solana/kora";
import type { ClerkTestIdentity } from "./clerk-admin";
import {
  type IssuanceFixtureToken,
  type IssuanceFixtureWallet,
  type IssuanceFixtures,
  writeIssuanceFixtures,
} from "./issuance-fixtures";
import { type LocalApiClient, createLocalApiClient } from "./local-api-client";

const PLAYWRIGHT_LOCAL_ORG_ID = "org_e2e_issuance";
const PLAYWRIGHT_LOCAL_ORG_NAME = "E2E Issuance Org";
const PLAYWRIGHT_LOCAL_ORG_SLUG = "e2e-issuance";
const DEFAULT_LOCAL_API_URL = "http://127.0.0.1:8788";
const DEFAULT_API_PERSIST_PATH = ".wrangler/state-playwright";
const DEFAULT_CLERK_JWT_TEMPLATE = "sdp-api";
const DEFAULT_METADATA_IMAGE_URL = "https://example.com/assets/sdp-e2e-token.png";
const ADDRESS_ACTIVATION_AIRDROP_LAMPORTS = 1_000_000;
const RPC_METHOD_GET_LATEST_BLOCKHASH = `getLatest${"Blockhash"}`;
const RPC_METHOD_GET_SIGNATURE_STATUSES = `getSignature${"Statuses"}`;

interface BootstrapOptions {
  identity: ClerkTestIdentity;
  bearerToken: string;
}

interface PlaywrightApiRuntimeEnv {
  clerkJwtTemplate: string;
  localApiBaseUrl: string;
  persistPath: string;
  solanaRpcUrl: string;
  koraRpcUrl: string | null;
  koraApiKey: string | null;
  fundingPrivateKey: string | null;
}

interface PlaywrightLocalD1Env {
  persistPath: string;
}

interface CreateWalletResponse {
  wallet: IssuanceFixtureWallet;
}

interface InitializeWalletResponse {
  configId: string;
  publicKey: string;
  walletId: string;
}

interface ListWalletsResponse {
  wallets: PaymentsDashboardWallet[];
}

interface TokenResponse {
  token: Token;
}

interface ListProjectsResponse {
  projects: Array<{ id: string }>;
}

type SolanaRpcResponse<T> =
  | { jsonrpc: "2.0"; id: number; result: T }
  | { jsonrpc: "2.0"; id: number; error: { code: number; message: string; data?: unknown } };

const base58 = getBase58Codec();

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const content = fs.readFileSync(filePath, "utf8");
  const entries: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    entries[key] = value;
  }

  return entries;
}

function parseTomlEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const content = fs.readFileSync(filePath, "utf8");
  const entries: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) {
      continue;
    }

    const match = line.match(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"$/);
    if (!match) {
      continue;
    }

    entries[match[1]] = match[2];
  }

  return entries;
}

function getRepoRoot(): string {
  return path.resolve(__dirname, "../../../..");
}

function getApiAppDir(): string {
  return path.join(getRepoRoot(), "apps/sdp-api");
}

function getWranglerBin(): string {
  const apiAppDir = getApiAppDir();
  return path.join(
    apiAppDir,
    "node_modules/.bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler"
  );
}

function getPlaywrightLocalD1Env(): PlaywrightLocalD1Env {
  return {
    persistPath: process.env.PLAYWRIGHT_API_PERSIST_PATH ?? DEFAULT_API_PERSIST_PATH,
  };
}

function getPlaywrightApiRuntimeEnv(): PlaywrightApiRuntimeEnv {
  const apiAppDir = getApiAppDir();
  const devVars = parseEnvFile(path.join(apiAppDir, ".dev.vars"));
  const wranglerVars = parseTomlEnvFile(path.join(apiAppDir, "wrangler.toml"));
  const readValue = (name: string): string | null =>
    process.env[name] ?? devVars[name] ?? wranglerVars[name] ?? null;

  const solanaRpcUrl = readValue("SOLANA_RPC_URL");
  if (!solanaRpcUrl) {
    throw new Error("Missing SOLANA_RPC_URL for Playwright issuance bootstrap");
  }

  return {
    clerkJwtTemplate:
      process.env.CLERK_JWT_TEMPLATE ??
      process.env.NEXT_PUBLIC_CLERK_JWT_TEMPLATE ??
      DEFAULT_CLERK_JWT_TEMPLATE,
    localApiBaseUrl: process.env.PLAYWRIGHT_API_URL ?? DEFAULT_LOCAL_API_URL,
    persistPath: process.env.PLAYWRIGHT_API_PERSIST_PATH ?? DEFAULT_API_PERSIST_PATH,
    solanaRpcUrl,
    koraRpcUrl: readValue("KORA_RPC_URL"),
    koraApiKey: readValue("KORA_API_KEY"),
    fundingPrivateKey: readValue("FEE_PAYER_PRIVATE_KEY") ?? readValue("CUSTODY_PRIVATE_KEY"),
  };
}

function runLocalD1Sql(sql: string): void {
  const apiAppDir = getApiAppDir();
  const persistPath = getPlaywrightLocalD1Env().persistPath;
  const tempFilePath = path.join(os.tmpdir(), `sdp-playwright-d1-${crypto.randomUUID()}.sql`);
  fs.writeFileSync(tempFilePath, sql);

  try {
    const result = spawnSync(
      getWranglerBin(),
      ["d1", "execute", "DB", "--local", `--persist-to=${persistPath}`, `--file=${tempFilePath}`],
      {
        cwd: apiAppDir,
        env: {
          ...process.env,
          CI: "1",
        },
        encoding: "utf8",
      }
    );

    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || "Unknown wrangler D1 execution error");
    }
  } finally {
    fs.rmSync(tempFilePath, { force: true });
  }
}

export function seedLocalClerkOrganizationMapping(identity: ClerkTestIdentity): void {
  const clerkOrgId = escapeSql(identity.organizationId);
  const clerkUserId = escapeSql(identity.userId);
  const clerkEmail = escapeSql(identity.email.toLowerCase());
  const localUserId = "usr_e2e_issuance_admin";
  const localMemberId = "mem_e2e_issuance_admin";
  const localUserIdentityId = "aui_e2e_issuance_admin";

  runLocalD1Sql(`
    INSERT OR REPLACE INTO organizations (id, name, slug, tier, status)
    VALUES (
      '${PLAYWRIGHT_LOCAL_ORG_ID}',
      '${PLAYWRIGHT_LOCAL_ORG_NAME}',
      '${PLAYWRIGHT_LOCAL_ORG_SLUG}',
      'free',
      'active'
    );

    INSERT OR REPLACE INTO auth_organization_identities (
      id,
      provider,
      provider_org_id,
      organization_id,
      slug
    )
    VALUES (
      'aoi_e2e_issuance',
      'clerk',
      '${clerkOrgId}',
      '${PLAYWRIGHT_LOCAL_ORG_ID}',
      '${PLAYWRIGHT_LOCAL_ORG_SLUG}'
    );

    INSERT OR REPLACE INTO users (id, email, email_verified, name, status)
    VALUES (
      '${localUserId}',
      '${clerkEmail}',
      1,
      'SDP E2E Admin',
      'active'
    );

    INSERT OR REPLACE INTO auth_user_identities (
      id,
      provider,
      provider_user_id,
      user_id,
      email
    )
    VALUES (
      '${localUserIdentityId}',
      'clerk',
      '${clerkUserId}',
      '${localUserId}',
      '${clerkEmail}'
    );

    INSERT OR REPLACE INTO organization_members (
      id,
      organization_id,
      user_id,
      role,
      status
    )
    VALUES (
      '${localMemberId}',
      '${PLAYWRIGHT_LOCAL_ORG_ID}',
      '${localUserId}',
      'admin',
      'active'
    );
  `);
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}

function toFixtureWallet(wallet: PaymentsDashboardWallet): IssuanceFixtureWallet {
  return {
    id: wallet.id,
    walletId: wallet.walletId,
    publicKey: wallet.publicKey,
    label: wallet.label ?? null,
  };
}

function toFixtureToken(token: Token): IssuanceFixtureToken {
  return {
    id: token.id,
    name: token.name,
    symbol: token.symbol,
    mintAddress: token.mintAddress ?? null,
    status: token.status,
  };
}

async function solanaRpc<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  options: { allowErrors?: boolean } = {}
): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  const payload = (await response.json()) as SolanaRpcResponse<T>;
  if ("error" in payload && !options.allowErrors) {
    throw new Error(`Solana RPC error calling ${method}: ${payload.error.message}`);
  }

  if ("error" in payload) {
    throw new Error(payload.error.message);
  }

  return payload.result;
}

async function solanaAccountExists(rpcUrl: string, address: string): Promise<boolean> {
  const response = await solanaRpc<{ value: object | null }>(rpcUrl, "getAccountInfo", [
    address,
    { encoding: "base64", commitment: "confirmed" },
  ]);

  return response.value !== null;
}

async function waitForAccountExistence(rpcUrl: string, address: string): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 30_000) {
    if (await solanaAccountExists(rpcUrl, address)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for account ${address} to exist on-chain`);
}

async function requestAirdrop(rpcUrl: string, address: string, lamports: number): Promise<void> {
  await solanaRpc<string>(
    rpcUrl,
    "requestAirdrop",
    [address, lamports, { commitment: "confirmed" }],
    { allowErrors: false }
  );
}

async function getRecentBlockhash(rpcUrl: string): Promise<{
  blockhash: string;
  lastValidBlockHeight: bigint;
}> {
  const response = await solanaRpc<{
    value: { blockhash: string; lastValidBlockHeight: number };
  }>(rpcUrl, RPC_METHOD_GET_LATEST_BLOCKHASH, [{ commitment: "confirmed" }]);

  return {
    blockhash: response.value.blockhash,
    lastValidBlockHeight: BigInt(response.value.lastValidBlockHeight),
  };
}

async function getMinimumBalanceForRentExemption(
  rpcUrl: string,
  dataLength: number
): Promise<bigint> {
  // biome-ignore lint/nursery/noSecrets: Solana RPC method names are not secrets.
  const lamports = await solanaRpc<number>(rpcUrl, "getMinimumBalanceForRentExemption", [
    dataLength,
    { commitment: "confirmed" },
  ]);

  return BigInt(lamports);
}

async function confirmSignature(rpcUrl: string, signature: string): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 45_000) {
    const response = await solanaRpc<{
      value: Array<{ confirmationStatus?: string | null; err?: unknown; slot: number } | null>;
    }>(rpcUrl, RPC_METHOD_GET_SIGNATURE_STATUSES, [[signature]]);

    const result = response.value[0];
    if (result?.err) {
      throw new Error(`Funding signature ${signature} failed: ${JSON.stringify(result.err)}`);
    }

    if (result?.confirmationStatus === "confirmed" || result?.confirmationStatus === "finalized") {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for funding signature ${signature} to confirm`);
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function fundAddressViaKora(
  runtimeEnv: PlaywrightApiRuntimeEnv,
  address: string
): Promise<boolean> {
  if (!runtimeEnv.koraRpcUrl) {
    return false;
  }

  const client = new KoraClient({
    rpcUrl: runtimeEnv.koraRpcUrl,
    ...(runtimeEnv.koraApiKey ? { apiKey: runtimeEnv.koraApiKey } : {}),
  });

  const response = await client.getPayerSigner();
  const feePayer =
    (response as { signer_address?: string }).signer_address ??
    (response as { payment_address?: string }).payment_address ??
    (response as { payerSigner?: string }).payerSigner;

  if (!feePayer) {
    throw new Error("Kora did not return a fee payer signer address");
  }

  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(runtimeEnv.solanaRpcUrl);
  const rentExemption = await getMinimumBalanceForRentExemption(runtimeEnv.solanaRpcUrl, 0);
  const instruction = getTransferSolInstruction({
    source: createNoopSigner(feePayer as Address),
    destination: address as Address,
    amount: rentExemption + BigInt(1),
  });

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (value) => setTransactionMessageFeePayer(feePayer as Address, value),
    (value) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash as Blockhash, lastValidBlockHeight },
        value
      ),
    (value) => appendTransactionMessageInstructions([instruction], value)
  );

  const compiled = compileTransaction(message);
  const transaction = new Uint8Array(getTransactionEncoder().encode(compiled));
  const result = await client.signAndSendTransaction({
    transaction: encodeBase64(transaction),
  });

  const signedTransaction = Buffer.from(result.signed_transaction, "base64");
  const decodedTransaction = getTransactionDecoder().decode(new Uint8Array(signedTransaction));
  const signature = getSignatureFromTransaction(decodedTransaction);
  await confirmSignature(runtimeEnv.solanaRpcUrl, signature);

  return true;
}

async function fundAddressViaLocalSigner(
  runtimeEnv: PlaywrightApiRuntimeEnv,
  address: string
): Promise<boolean> {
  if (!runtimeEnv.fundingPrivateKey) {
    return false;
  }

  const secretKey = base58.encode(runtimeEnv.fundingPrivateKey);
  if (secretKey.length !== 64) {
    throw new Error(
      `Invalid local funding keypair length: expected 64 bytes, got ${secretKey.length}`
    );
  }

  const signer = await createKeyPairSignerFromBytes(secretKey);
  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(runtimeEnv.solanaRpcUrl);
  const rentExemption = await getMinimumBalanceForRentExemption(runtimeEnv.solanaRpcUrl, 0);
  const instruction = getTransferSolInstruction({
    source: signer,
    destination: address as Address,
    amount: rentExemption + BigInt(1),
  });

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (value) => setTransactionMessageFeePayer(signer.address, value),
    (value) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash as Blockhash, lastValidBlockHeight },
        value
      ),
    (value) => appendTransactionMessageInstructions([instruction], value)
  );

  const signedTransaction = await signTransactionMessageWithSigners(message);
  const signature = await solanaRpc<string>(runtimeEnv.solanaRpcUrl, "sendTransaction", [
    getBase64EncodedWireTransaction(signedTransaction),
    { encoding: "base64", preflightCommitment: "confirmed" },
  ]);
  await confirmSignature(runtimeEnv.solanaRpcUrl, signature);

  return true;
}

async function ensureAddressAccountExists(address: string): Promise<void> {
  const runtimeEnv = getPlaywrightApiRuntimeEnv();
  const exists = await solanaAccountExists(runtimeEnv.solanaRpcUrl, address);
  if (exists) {
    return;
  }

  let koraFundingError: unknown = null;
  try {
    const fundedViaKora = await fundAddressViaKora(runtimeEnv, address);
    if (fundedViaKora) {
      await waitForAccountExistence(runtimeEnv.solanaRpcUrl, address);
      return;
    }
  } catch (error) {
    koraFundingError = error;
  }

  let localFundingError: unknown = null;
  try {
    const fundedViaLocalSigner = await fundAddressViaLocalSigner(runtimeEnv, address);
    if (fundedViaLocalSigner) {
      await waitForAccountExistence(runtimeEnv.solanaRpcUrl, address);
      return;
    }
  } catch (error) {
    localFundingError = error;
  }

  try {
    await requestAirdrop(runtimeEnv.solanaRpcUrl, address, ADDRESS_ACTIVATION_AIRDROP_LAMPORTS);
    await waitForAccountExistence(runtimeEnv.solanaRpcUrl, address);
  } catch (airdropError) {
    const koraMessage =
      koraFundingError instanceof Error
        ? koraFundingError.message
        : koraFundingError
          ? String(koraFundingError)
          : "not attempted";
    const localMessage =
      localFundingError instanceof Error
        ? localFundingError.message
        : localFundingError
          ? String(localFundingError)
          : "not attempted";
    const airdropMessage =
      airdropError instanceof Error ? airdropError.message : String(airdropError);

    throw new Error(
      `Failed to activate address ${address}. ` +
        `Kora funding failed: ${koraMessage}. ` +
        `Local signer funding failed: ${localMessage}. ` +
        `Airdrop failed: ${airdropMessage}`
    );
  }
}

async function listWallets(api: LocalApiClient): Promise<PaymentsDashboardWallet[]> {
  // biome-ignore lint/nursery/noSecrets: This is a local API path, not a credential.
  const data = await api.get<ListWalletsResponse>("/v1/wallets?includeAllProviders=true");
  return data.wallets;
}

async function fetchToken(api: LocalApiClient, tokenId: string): Promise<Token> {
  const data = await api.get<TokenResponse>(`/v1/issuance/tokens/${tokenId}`);
  return data.token;
}

async function waitForTokenStatus(
  api: LocalApiClient,
  tokenId: string,
  predicate: (token: Token) => boolean,
  description: string
): Promise<Token> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 90_000) {
    const token = await fetchToken(api, tokenId);
    if (predicate(token)) {
      return token;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for token ${tokenId} to ${description}`);
}

async function ensureProjectId(api: LocalApiClient): Promise<string> {
  const data = await api.get<ListProjectsResponse>("/v1/projects");
  const projectId = data.projects[0]?.id;
  if (!projectId) {
    throw new Error("Failed to resolve a project for Playwright issuance fixtures");
  }
  return projectId;
}

async function createFixtureToken(
  api: LocalApiClient,
  input: {
    name: string;
    symbol: string;
    uri: string;
    requiresAllowlist: boolean;
    signingWalletId: string;
  }
): Promise<Token> {
  const data = await api.post<TokenResponse>("/v1/issuance/tokens", {
    name: input.name,
    symbol: input.symbol,
    template: "stablecoin",
    uri: input.uri,
    imageUrl: DEFAULT_METADATA_IMAGE_URL,
    description: `${input.name} description`,
    signingWalletId: input.signingWalletId,
    requiresAllowlist: input.requiresAllowlist,
    isMintable: true,
    isFreezable: true,
  });

  return data.token;
}

async function deployFixtureToken(
  api: LocalApiClient,
  tokenId: string,
  signingWalletId: string
): Promise<Token> {
  await api.post<TokenResponse>(`/v1/issuance/tokens/${tokenId}/deploy`, {
    signingWalletId,
  });

  return waitForTokenStatus(
    api,
    tokenId,
    (token) => token.status === "active" && Boolean(token.mintAddress),
    "become active"
  );
}

function createExternalAddressSet(): Promise<{ allowlistWallet: string; freezeWallet: string }> {
  return Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]).then(
    ([allowlistWallet, freezeWallet]) => ({
      allowlistWallet: allowlistWallet.address,
      freezeWallet: freezeWallet.address,
    })
  );
}

export async function bootstrapLocalIssuanceFixtures({
  identity,
  bearerToken,
}: BootstrapOptions): Promise<IssuanceFixtures> {
  const runtimeEnv = getPlaywrightApiRuntimeEnv();
  const api = createLocalApiClient(runtimeEnv.localApiBaseUrl, bearerToken);

  const initialized = await api.post<InitializeWalletResponse>("/v1/wallets/initialize", {
    provider: "privy",
    walletLabel: "Treasury",
  });
  const delegated = await api.post<CreateWalletResponse>("/v1/wallets", {
    provider: "privy",
    label: "Delegated",
  });
  const wallets = await listWallets(api);

  const treasuryWallet =
    wallets.find((wallet) => wallet.walletId === initialized.walletId) ??
    wallets.find((wallet) => wallet.publicKey === initialized.publicKey);
  const delegatedWallet =
    wallets.find((wallet) => wallet.walletId === delegated.wallet.walletId) ??
    wallets.find((wallet) => wallet.publicKey === delegated.wallet.publicKey);

  if (!treasuryWallet || !delegatedWallet) {
    throw new Error("Failed to resolve the seeded Privy wallets for Playwright issuance tests");
  }

  await ensureAddressAccountExists(treasuryWallet.publicKey);
  await ensureAddressAccountExists(delegatedWallet.publicKey);

  const externalAddresses = await createExternalAddressSet();
  await ensureAddressAccountExists(externalAddresses.freezeWallet);

  const pendingToken = await createFixtureToken(api, {
    name: "E2E Pending Stable",
    symbol: "E2EPND",
    uri: "https://example.com/metadata/e2e-pending-stable.json",
    requiresAllowlist: false,
    signingWalletId: treasuryWallet.walletId,
  });
  const allowlistedDraft = await createFixtureToken(api, {
    name: "E2E Allowlist Stable",
    symbol: "E2EALW",
    uri: "https://example.com/metadata/e2e-allowlisted-stable.json",
    requiresAllowlist: true,
    signingWalletId: treasuryWallet.walletId,
  });
  const openDraft = await createFixtureToken(api, {
    name: "E2E Open Stable",
    symbol: "E2EOPN",
    uri: "https://example.com/metadata/e2e-open-stable.json",
    requiresAllowlist: false,
    signingWalletId: treasuryWallet.walletId,
  });

  const allowlistedToken = await deployFixtureToken(
    api,
    allowlistedDraft.id,
    treasuryWallet.walletId
  );
  const openToken = await deployFixtureToken(api, openDraft.id, treasuryWallet.walletId);
  const projectId = await ensureProjectId(api);

  const fixtures: IssuanceFixtures = {
    organization: {
      clerkOrgId: identity.organizationId,
      localOrgId: PLAYWRIGHT_LOCAL_ORG_ID,
      slug: PLAYWRIGHT_LOCAL_ORG_SLUG,
      name: PLAYWRIGHT_LOCAL_ORG_NAME,
    },
    projectId,
    wallets: {
      treasury: toFixtureWallet(treasuryWallet),
      delegated: toFixtureWallet(delegatedWallet),
    },
    tokens: {
      pending: toFixtureToken(pendingToken),
      allowlisted: toFixtureToken(allowlistedToken),
      open: toFixtureToken(openToken),
    },
    addresses: externalAddresses,
  };

  writeIssuanceFixtures(fixtures);
  return fixtures;
}

export function getBootstrapApiBaseUrl(): string {
  return getPlaywrightApiRuntimeEnv().localApiBaseUrl;
}

export function getBootstrapClerkJwtTemplate(): string {
  return getPlaywrightApiRuntimeEnv().clerkJwtTemplate;
}
