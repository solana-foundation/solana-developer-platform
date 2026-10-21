import fs from "node:fs";
import path from "node:path";
import type { Browser, Page, Response } from "@playwright/test";
import type { CounterpartyAccountResponse, CounterpartyResponse } from "@sdp/types/counterparties";
import type { WalletFaucetResponse } from "@sdp/types/custody";
import type { OrganizationSettings, OrganizationTier } from "@sdp/types/organizations";
import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import type { ListProjectsResponse } from "@sdp/types/projects";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getTransactionEncoder,
  lamports,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { KoraClient } from "@solana/kora";
import { getTransferSolInstruction } from "@solana-program/system";
import { Client } from "pg";
import { projectHref } from "@/lib/dashboard-project-path";
import { getPlaywrightAdminSession, type PlaywrightAdminSession } from "./auth-session";
import { type ClerkTestIdentity, setClerkOrganizationTier } from "./clerk-admin";
import {
  type BearerTokenProvider,
  createLocalApiClient,
  type LocalApiClient,
} from "./local-api-client";

const PLAYWRIGHT_LOCAL_ORG_ID_PREFIX = "org_e2e_dashboard";
const PLAYWRIGHT_LOCAL_ORG_NAME_PREFIX = "E2E Dashboard Org";
const PLAYWRIGHT_LOCAL_ORG_SLUG_PREFIX = "e2e-dashboard";
const PLAYWRIGHT_LOCAL_USER_ID = "usr_e2e_dashboard_admin";
const PLAYWRIGHT_LOCAL_MEMBER_ID = "mem_e2e_dashboard_admin";
const PLAYWRIGHT_ORGANIZATION_BASE_SETTINGS = {
  enableProductionProject: true,
} satisfies OrganizationSettings;
const PLAYWRIGHT_LOCAL_ORG_AUTH_ID = "aoi_e2e_dashboard";
const PLAYWRIGHT_LOCAL_USER_AUTH_ID = "aui_e2e_dashboard";
const DEFAULT_LOCAL_API_URL = "http://127.0.0.1:8788";
const DEFAULT_KORA_DEVNET_URL = "https://your-kora-devnet-instance.us-central1.run.app";
const DEFAULT_SOLANA_RPC_URL = "https://api.devnet.solana.com";
const KORA_MAX_TRANSFER_LAMPORTS = BigInt(9_900_000);
const ZERO_LAMPORTS = BigInt(0);
const ONE_LAMPORT = BigInt(1);
const SOLANA_LAMPORTS_PER_SOL = 1_000_000_000;

interface PlaywrightApiRuntimeEnv {
  localApiBaseUrl: string;
  koraApiKey: string | null;
  koraRpcUrl: string | null;
  solanaRpcUrl: string;
}

type PlaywrightCustodyProvider = "local" | "privy";

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
  projectId: string;
  wallets: PlaywrightWalletFixture[];
}

export interface PlaywrightProjects {
  sandbox: string;
  production: string;
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
    localApiBaseUrl: process.env.PLAYWRIGHT_API_URL ?? DEFAULT_LOCAL_API_URL,
    koraApiKey: getLocalDevVar("KORA_DEVNET_API_KEY"),
    koraRpcUrl: getLocalDevVar("KORA_DEVNET_URL") ?? DEFAULT_KORA_DEVNET_URL,
    solanaRpcUrl: getLocalDevVar("SOLANA_RPC_URL") ?? DEFAULT_SOLANA_RPC_URL,
  };
}

function getLocalEnvValues(): Map<string, string> {
  const localEnvPath = path.resolve(__dirname, "../../../sdp-api/.env.local");
  const values = new Map<string, string>();

  if (fs.existsSync(localEnvPath)) {
    const contents = fs.readFileSync(localEnvPath, "utf8");
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

  return getLocalEnvValues().get(name) ?? null;
}

function isKoraSurfpoolShim(): boolean {
  return process.env.KORA_SURFPOOL_SHIM === "true";
}

export function getPlaywrightCustodyProvider(): PlaywrightCustodyProvider {
  const configuredProvider = process.env.SDP_INTEGRATION_CUSTODY_PROVIDER?.trim();
  if (!configuredProvider) {
    return "privy";
  }

  if (configuredProvider === "local" || configuredProvider === "privy") {
    return configuredProvider;
  }

  throw new Error(
    `Invalid SDP_INTEGRATION_CUSTODY_PROVIDER: ${configuredProvider}. Expected "local" or "privy".`
  );
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

async function enableLocalCustodyForPlaywrightOrg(organizationId: string): Promise<void> {
  await withDatabaseClient(async (client) => {
    await client.query(
      `UPDATE organizations
       SET settings = $2, updated_at = sdp_datetime_now()
       WHERE id = $1`,
      [
        organizationId,
        JSON.stringify({
          ...PLAYWRIGHT_ORGANIZATION_BASE_SETTINGS,
          providerOverrides: {
            custody: {
              local: true,
            },
          },
        }),
      ]
    );
  });
}

async function listWallets(api: LocalApiClient): Promise<PaymentsDashboardWallet[]> {
  const data = await api.get<ListWalletsResponse>("/v1/wallets");
  return data.wallets;
}

/**
 * Runs a provision callback inside an admin session that is always closed.
 *
 * `session.getBearerToken` depends on the session page and is only valid inside
 * `provision`. Callers that need a token after this function returns must return
 * the static `session.bearerToken` snapshot from the callback.
 *
 * @param browser - The Playwright browser to open the admin session in.
 * @param provision - Provisions data while the admin session is open.
 * @returns The provision result after the admin page is closed.
 */
export async function provisionWithAdminSession<T>(
  browser: Browser,
  provision: (session: PlaywrightAdminSession) => Promise<T>
): Promise<T> {
  const session = await getPlaywrightAdminSession(browser);

  try {
    return await provision(session);
  } finally {
    await session.page.close();
  }
}

/**
 * Resolves the Sandbox and Production Project ids of the bearer token's Organization.
 *
 * @param localApiBaseUrl - The sdp-api base URL.
 * @param bearerToken - The admin session's bearer token provider.
 * @returns The Sandbox and Production Project ids.
 */
export async function resolvePlaywrightProjects(
  localApiBaseUrl: string,
  bearerToken: BearerTokenProvider
): Promise<PlaywrightProjects> {
  const projectsApi = createLocalApiClient(localApiBaseUrl, bearerToken);
  const { projects } = await projectsApi.get<ListProjectsResponse>("/v1/projects");
  const sandbox = projects.find((project) => project.environment === "sandbox");
  const production = projects.find((project) => project.environment === "production");
  if (sandbox === undefined || production === undefined) {
    throw new Error("The Playwright Organization must list a Sandbox and a Production Project");
  }
  return { sandbox: sandbox.id, production: production.id };
}

/**
 * Opens a dashboard page inside a Project, returning once its DOM has loaded.
 *
 * @param page - The page to navigate.
 * @param projectId - The Project the URL is scoped to.
 * @param dashboardPath - The project-less dashboard path, e.g. `/dashboard/wallets`.
 * @returns The main navigation response.
 */
export async function gotoProjectPage(
  page: Page,
  projectId: string,
  dashboardPath: string
): Promise<Response | null> {
  return page.goto(projectHref(projectId, dashboardPath), { waitUntil: "domcontentloaded" });
}

/**
 * Recreates the Playwright Organization with no fixtures beyond its Projects.
 *
 * @param browser - The Playwright browser to open the admin session in.
 * @returns The new Organization's Sandbox and Production Project ids.
 */
export async function provisionLinkedOrgProjects(browser: Browser): Promise<PlaywrightProjects> {
  return provisionWithAdminSession(browser, async (session) => {
    await ensureLinkedOrg(session.identity, { tier: "enterprise" });
    return resolvePlaywrightProjects(getBootstrapApiBaseUrl(), session.getBearerToken);
  });
}

/** The cluster RPC the local API is configured with. */
function localClusterRpc() {
  return createSolanaRpc(getPlaywrightApiRuntimeEnv().solanaRpcUrl);
}

/**
 * Airdrops `lamports` from the cluster RPC, falling back to the API's devnet
 * faucet, which airdrops its own fixed amount.
 */
async function requestWalletAirdropLamports(
  api: LocalApiClient,
  wallet: PlaywrightWalletFixture,
  amountLamports: number
): Promise<void> {
  try {
    await localClusterRpc()
      .requestAirdrop(address(wallet.publicKey), lamports(BigInt(amountLamports)))
      .send();
    return;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
  }

  const airdrop = await api.post<WalletFaucetResponse>(
    `/internal/dashboard/wallets/${encodeURIComponent(wallet.walletId)}/faucet`
  );
  if (airdrop.status === "failed") {
    throw new Error(`Devnet faucet airdrop ${airdrop.signature} failed`);
  }
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function getLatestBlockhash(): Promise<{
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
}> {
  const { value } = await localClusterRpc().getLatestBlockhash({ commitment: "confirmed" }).send();
  return value;
}

async function getMinimumBalanceForRentExemption(): Promise<bigint> {
  return localClusterRpc().getMinimumBalanceForRentExemption(0n).send();
}

async function fundAddressViaKoraFeePayer(address: string, lamports: bigint): Promise<boolean> {
  const runtimeEnv = getPlaywrightApiRuntimeEnv();
  const client = new KoraClient({
    rpcUrl: runtimeEnv.koraRpcUrl ?? DEFAULT_KORA_DEVNET_URL,
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
    const { blockhash, lastValidBlockHeight } = await getLatestBlockhash();
    const minimumLamports = await getMinimumBalanceForRentExemption();
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

async function getWalletLamports(walletAddress: string): Promise<number> {
  const { value } = await localClusterRpc()
    .getBalance(address(walletAddress), { commitment: "confirmed" })
    .send();
  return Number(value);
}

async function waitForWalletLamports(
  walletAddress: string,
  minimumLamports: number,
  timeoutMs = 60_000
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const lamports = await getWalletLamports(walletAddress);
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
  wallet: PlaywrightWalletFixture,
  minimumLamports: number
): Promise<void> {
  const walletAddress = wallet.publicKey;
  const existingLamports = await getWalletLamports(walletAddress);
  if (existingLamports >= minimumLamports) {
    return;
  }

  const lamportsNeeded = minimumLamports - existingLamports;
  if (isKoraSurfpoolShim()) {
    try {
      await requestWalletAirdropLamports(api, wallet, lamportsNeeded);
      await waitForWalletLamports(walletAddress, minimumLamports);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to fund wallet ${walletAddress} to ${minimumLamports} lamports via Surfpool local RPC: ${message}`
      );
    }
  }

  let koraFundingError: unknown = null;
  const koraFunded = await fundAddressViaKoraFeePayer(walletAddress, BigInt(lamportsNeeded)).catch(
    (error) => {
      koraFundingError = error;
      return false;
    }
  );

  if (koraFunded) {
    try {
      await waitForWalletLamports(walletAddress, minimumLamports, 15_000);
      return;
    } catch (error) {
      koraFundingError = error;
    }
  }

  try {
    await requestWalletAirdropLamports(api, wallet, lamportsNeeded);
    await waitForWalletLamports(walletAddress, minimumLamports);
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
        `INSERT INTO organizations
           (id, name, slug, tier, status, settings, onboarding_completed_at, onboarding_version)
         VALUES ($1, $2, $3, $4, 'active', $5, sdp_datetime_now(), 1)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           slug = EXCLUDED.slug,
           tier = EXCLUDED.tier,
           status = EXCLUDED.status,
           settings = EXCLUDED.settings,
           onboarding_completed_at = sdp_datetime_now(),
           onboarding_version = 1,
           updated_at = sdp_datetime_now()`,
        [
          organization.id,
          organization.name,
          organization.slug,
          tier,
          JSON.stringify(PLAYWRIGHT_ORGANIZATION_BASE_SETTINGS),
        ]
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

      // Production provisions default projects via the Clerk webhook
      // (see apps/sdp-api/src/routes/webhooks/handlers.ts). Tests don't fire
      // the webhook, so mirror its behavior here so subsequent project-scoped
      // API calls have a sandbox project to attach to.
      const projectResult = await client.query<{ id: string }>(
        `INSERT INTO projects
           (id, organization_id, name, slug, description, environment, status, created_by)
         VALUES (
           'prj_' || gen_random_uuid(), $1, 'Default Sandbox Project', 'default-sandbox',
           'Default sandbox project', 'sandbox', 'active', $2
         )
         ON CONFLICT (organization_id, slug) DO UPDATE
           SET status = 'active'
         RETURNING id`,
        [organization.id, userId]
      );
      const sandboxProjectId = projectResult.rows[0]?.id;
      if (!sandboxProjectId) {
        throw new Error("Failed to provision default sandbox project for Playwright bootstrap");
      }

      await client.query(
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES ('pm_' || gen_random_uuid(), $1, $2, 'admin')
         ON CONFLICT (project_id, user_id) DO NOTHING`,
        [sandboxProjectId, userId]
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
  bearerToken: BearerTokenProvider;
  provider?: PlaywrightCustodyProvider;
  walletLabel?: string;
  walletCount?: number;
  fundSourceWallet?: boolean;
  fundSourceAmountSol?: number;
  tier?: OrganizationTier;
}): Promise<WalletBootstrapResult> {
  const { identity, bearerToken } = input;
  const walletCount = Math.max(1, input.walletCount ?? 1);
  const provider = input.provider ?? getPlaywrightCustodyProvider();
  const fundSourceWallet = input.fundSourceWallet ?? false;
  const fundSourceAmountSol = input.fundSourceAmountSol ?? 1;
  const runtimeEnv = getPlaywrightApiRuntimeEnv();

  if (provider === "local" && walletCount > 1) {
    throw new Error("Local custody supports one seeded Playwright wallet");
  }

  const organization = await ensureLinkedOrg(identity, {
    tier: input.tier,
  });
  if (provider === "local") {
    await enableLocalCustodyForPlaywrightOrg(organization.id);
  }

  const projects = await resolvePlaywrightProjects(runtimeEnv.localApiBaseUrl, bearerToken);
  const projectId = projects.sandbox;
  const api = createLocalApiClient(runtimeEnv.localApiBaseUrl, bearerToken, projectId);

  const createdWalletIds = [
    await initializeOrCreateWallet(api, provider, input.walletLabel ?? "Treasury"),
  ];

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
    await fundWalletToLamports(api, sourceWallet, minimumLamports);
  }

  return {
    organization: {
      clerkOrgId: identity.organizationId,
      localOrgId: organization.id,
      slug: organization.slug,
      name: organization.name,
    },
    projectId,
    wallets,
  };
}

async function initializeOrCreateWallet(
  api: LocalApiClient,
  provider: PlaywrightCustodyProvider,
  label: string
): Promise<string> {
  try {
    const initialized = await api.post<InitializeWalletResponse>("/v1/wallets/initialize", {
      provider,
      walletLabel: label,
    });
    return initialized.walletId;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("Signing already initialized for org")
    ) {
      throw error;
    }
  }

  const created = await api.post<CreateWalletResponse>("/v1/wallets", {
    provider,
    label,
    purpose: "root",
  });
  return created.wallet.walletId;
}

export async function createExternalSolanaAddress(): Promise<string> {
  const signer = await generateKeyPairSigner();
  return signer.address;
}

export interface SeededCounterparty {
  counterpartyId: string;
  accountId: string;
  destinationAddress: string;
  displayName: string;
}

export async function seedCounterpartyWithSolanaAccount(
  api: LocalApiClient,
  input: {
    displayName: string;
    accountLabel: string;
    destinationAddress: string;
  }
): Promise<SeededCounterparty> {
  const { counterparty } = await api.post<CounterpartyResponse>("/v1/counterparties", {
    entityType: "individual",
    displayName: input.displayName,
  });
  const { account } = await api.post<CounterpartyAccountResponse>(
    `/v1/counterparties/${counterparty.id}/accounts`,
    {
      accountKind: "crypto_wallet",
      label: input.accountLabel,
      details: { network: "solana", address: input.destinationAddress },
    }
  );
  return {
    counterpartyId: counterparty.id,
    accountId: account.id,
    destinationAddress: input.destinationAddress,
    displayName: input.displayName,
  };
}

export function getBootstrapApiBaseUrl(): string {
  return getPlaywrightApiRuntimeEnv().localApiBaseUrl;
}

export const seedLocalClerkOrganizationMapping = ensureLinkedOrg;
