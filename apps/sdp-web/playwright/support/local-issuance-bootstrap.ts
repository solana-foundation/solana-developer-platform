import type { PaymentsDashboardWallet, Token } from "@sdp/types";
import { generateKeyPairSigner } from "@solana/kit";
import { Client } from "pg";
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
const DEFAULT_CLERK_JWT_TEMPLATE = "sdp-api";
const DEFAULT_METADATA_IMAGE_URL = "https://example.com/assets/sdp-e2e-token.png";

interface BootstrapOptions {
  identity: ClerkTestIdentity;
  bearerToken: string;
}

interface PlaywrightApiRuntimeEnv {
  clerkJwtTemplate: string;
  localApiBaseUrl: string;
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

function getPlaywrightApiRuntimeEnv(): PlaywrightApiRuntimeEnv {
  return {
    clerkJwtTemplate:
      process.env.CLERK_JWT_TEMPLATE ??
      process.env.NEXT_PUBLIC_CLERK_JWT_TEMPLATE ??
      DEFAULT_CLERK_JWT_TEMPLATE,
    localApiBaseUrl: process.env.PLAYWRIGHT_API_URL ?? DEFAULT_LOCAL_API_URL,
  };
}

function getPlaywrightDatabaseUrl(): string {
  const explicitDatabaseUrl = process.env.DATABASE_URL?.trim();
  if (explicitDatabaseUrl) {
    return explicitDatabaseUrl;
  }

  const localDatabaseUrl = new URL("postgresql://127.0.0.1:5432/sdp");
  localDatabaseUrl.username = "sdp";
  localDatabaseUrl.password = "sdp";
  return localDatabaseUrl.toString();
}

export async function seedLocalClerkOrganizationMapping(
  identity: ClerkTestIdentity
): Promise<void> {
  const client = new Client({
    connectionString: getPlaywrightDatabaseUrl(),
  });
  const clerkEmail = identity.email.toLowerCase();
  const localUserId = "usr_e2e_issuance_admin";
  const localMemberId = "mem_e2e_issuance_admin";
  const localUserIdentityId = "aui_e2e_issuance_admin";
  const now = new Date().toISOString().replace("T", " ").replace("Z", "");

  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO organizations (id, name, slug, tier, status)
       VALUES ($1, $2, $3, 'free', 'active')
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         slug = EXCLUDED.slug,
         tier = EXCLUDED.tier,
         status = EXCLUDED.status,
         updated_at = sdp_datetime_now()`,
      [PLAYWRIGHT_LOCAL_ORG_ID, PLAYWRIGHT_LOCAL_ORG_NAME, PLAYWRIGHT_LOCAL_ORG_SLUG]
    );
    await client.query(
      `INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id, slug)
       VALUES ($1, 'clerk', $2, $3, $4)
       ON CONFLICT (provider, provider_org_id) DO UPDATE SET
         id = EXCLUDED.id,
         organization_id = EXCLUDED.organization_id,
         slug = EXCLUDED.slug,
         updated_at = sdp_datetime_now()`,
      [
        "aoi_e2e_issuance",
        identity.organizationId,
        PLAYWRIGHT_LOCAL_ORG_ID,
        PLAYWRIGHT_LOCAL_ORG_SLUG,
      ]
    );
    await client.query(
      `INSERT INTO users (id, email, email_verified, name, status)
       VALUES ($1, $2, 1, 'SDP E2E Admin', 'active')
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         email_verified = EXCLUDED.email_verified,
         name = EXCLUDED.name,
         status = EXCLUDED.status`,
      [localUserId, clerkEmail]
    );
    await client.query(
      `INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
       VALUES ($1, 'clerk', $2, $3, $4)
       ON CONFLICT (provider, provider_user_id) DO UPDATE SET
         id = EXCLUDED.id,
         user_id = EXCLUDED.user_id,
         email = EXCLUDED.email,
         updated_at = sdp_datetime_now()`,
      [localUserIdentityId, identity.userId, localUserId, clerkEmail]
    );
    await client.query(
      `INSERT INTO organization_members (id, organization_id, user_id, role, status, created_at)
       VALUES ($1, $2, $3, 'admin', 'active', $4)
       ON CONFLICT (organization_id, user_id) DO UPDATE SET
         id = EXCLUDED.id,
         role = EXCLUDED.role,
         status = EXCLUDED.status`,
      [localMemberId, PLAYWRIGHT_LOCAL_ORG_ID, localUserId, now]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
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
