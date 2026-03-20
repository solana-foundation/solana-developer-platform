import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PaymentsDashboardWallet, Token } from "@sdp/types";
import { generateKeyPairSigner } from "@solana/kit";
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

interface BootstrapOptions {
  identity: ClerkTestIdentity;
  bearerToken: string;
}

interface PlaywrightApiRuntimeEnv {
  clerkJwtTemplate: string;
  localApiBaseUrl: string;
  persistPath: string;
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
  return {
    clerkJwtTemplate:
      process.env.CLERK_JWT_TEMPLATE ??
      process.env.NEXT_PUBLIC_CLERK_JWT_TEMPLATE ??
      DEFAULT_CLERK_JWT_TEMPLATE,
    localApiBaseUrl: process.env.PLAYWRIGHT_API_URL ?? DEFAULT_LOCAL_API_URL,
    persistPath: process.env.PLAYWRIGHT_API_PERSIST_PATH ?? DEFAULT_API_PERSIST_PATH,
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

  const externalAddresses = await createExternalAddressSet();

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
