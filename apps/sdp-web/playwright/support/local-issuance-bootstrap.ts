import type { OrganizationTier, Token } from "@sdp/types";
import { generateKeyPairSigner } from "@solana/kit";
import type { ClerkTestIdentity } from "./clerk-admin";
import {
  type IssuanceFixtures,
  type IssuanceFixtureToken,
  writeIssuanceFixtures,
} from "./issuance-fixtures";
import {
  type BearerTokenProvider,
  createLocalApiClient,
  type LocalApiClient,
} from "./local-api-client";
import {
  bootstrapLocalWalletFixtures,
  createExternalSolanaAddress,
  getBootstrapApiBaseUrl,
  getBootstrapClerkJwtTemplate,
  getPlaywrightCustodyProvider,
  type PlaywrightWalletFixture,
  resolvePlaywrightProjectId,
  seedLocalClerkOrganizationMapping,
} from "./local-dashboard-bootstrap";

interface BootstrapOptions {
  identity: ClerkTestIdentity;
  bearerToken: BearerTokenProvider;
  tier?: OrganizationTier;
}

export interface PaymentDashboardFixtures {
  projectId: string;
  wallets: {
    treasury: PlaywrightWalletFixture;
  };
  token: IssuanceFixtureToken;
}

interface TokenResponse {
  token: Token;
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
    imageUrl: "https://example.com/assets/sdp-e2e-token.png",
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

async function createExternalAddressSet(): Promise<{
  allowlistWallet: string;
  freezeWallet: string;
}> {
  const freezeWallet = await generateKeyPairSigner();

  return {
    allowlistWallet: await createExternalSolanaAddress(),
    freezeWallet: freezeWallet.address,
  };
}

function requireWallet(
  wallets: PlaywrightWalletFixture[],
  walletId: string | undefined,
  fallbackIndex: number
): PlaywrightWalletFixture {
  const resolved =
    (walletId ? wallets.find((wallet) => wallet.walletId === walletId) : null) ??
    wallets[fallbackIndex];

  if (!resolved) {
    throw new Error(`Failed to resolve Playwright wallet fixture at index ${fallbackIndex}`);
  }

  return resolved;
}

export async function bootstrapLocalIssuanceFixtures({
  identity,
  bearerToken,
  tier,
}: BootstrapOptions): Promise<IssuanceFixtures> {
  const custodyProvider = getPlaywrightCustodyProvider();
  const walletBootstrap = await bootstrapLocalWalletFixtures({
    identity,
    bearerToken,
    provider: custodyProvider,
    walletCount: custodyProvider === "local" ? 1 : 2,
    tier,
    // sRFC-37 deploys (denylist tokens) bypass Kora and have custody pay
    // directly, so the treasury wallet needs SOL up front. 0.05 SOL covers
    // multiple deploys + downstream rent with comfortable margin.
    fundSourceWallet: true,
    fundSourceAmountSol: 0.05,
  });
  const projectId = await resolvePlaywrightProjectId(getBootstrapApiBaseUrl(), bearerToken);
  const api = createLocalApiClient(getBootstrapApiBaseUrl(), bearerToken, projectId);

  const treasuryWallet = requireWallet(
    walletBootstrap.wallets,
    walletBootstrap.wallets[0]?.walletId,
    0
  );
  const externalAddresses = await createExternalAddressSet();
  const delegatedWallet =
    walletBootstrap.wallets[1] ??
    (custodyProvider === "local"
      ? treasuryWallet
      : ({
          id: "external-delegated-authority",
          walletId: externalAddresses.freezeWallet,
          publicKey: externalAddresses.freezeWallet,
          label: "External delegated authority",
        } satisfies PlaywrightWalletFixture));

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
  const authorityDraft = await createFixtureToken(api, {
    name: "E2E Authority Stable",
    symbol: "E2EAUT",
    uri: "https://example.com/metadata/e2e-authority-stable.json",
    requiresAllowlist: false,
    signingWalletId: treasuryWallet.walletId,
  });

  const allowlistedToken = await deployFixtureToken(
    api,
    allowlistedDraft.id,
    treasuryWallet.walletId
  );
  const openToken = await deployFixtureToken(api, openDraft.id, treasuryWallet.walletId);
  const authorityToken = await deployFixtureToken(api, authorityDraft.id, treasuryWallet.walletId);

  const fixtures: IssuanceFixtures = {
    organization: walletBootstrap.organization,
    projectId,
    wallets: {
      treasury: treasuryWallet,
      delegated: delegatedWallet,
    },
    tokens: {
      pending: toFixtureToken(pendingToken),
      allowlisted: toFixtureToken(allowlistedToken),
      authority: toFixtureToken(authorityToken),
      open: toFixtureToken(openToken),
    },
    addresses: externalAddresses,
  };

  writeIssuanceFixtures(fixtures);
  return fixtures;
}

export async function bootstrapLocalPaymentFixtures({
  identity,
  bearerToken,
  tier,
}: BootstrapOptions): Promise<PaymentDashboardFixtures> {
  const custodyProvider = getPlaywrightCustodyProvider();
  const walletBootstrap = await bootstrapLocalWalletFixtures({
    identity,
    bearerToken,
    provider: custodyProvider,
    walletCount: 1,
    tier,
    fundSourceWallet: true,
    fundSourceAmountSol: 0.05,
  });
  const projectId = await resolvePlaywrightProjectId(getBootstrapApiBaseUrl(), bearerToken);
  const api = createLocalApiClient(getBootstrapApiBaseUrl(), bearerToken, projectId);
  const treasuryWallet = requireWallet(
    walletBootstrap.wallets,
    walletBootstrap.wallets[0]?.walletId,
    0
  );
  const openDraft = await createFixtureToken(api, {
    name: "E2E Open Stable",
    symbol: "E2EOPN",
    uri: "https://example.com/metadata/e2e-open-stable.json",
    requiresAllowlist: false,
    signingWalletId: treasuryWallet.walletId,
  });
  const openToken = await deployFixtureToken(api, openDraft.id, treasuryWallet.walletId);

  return {
    projectId,
    wallets: {
      treasury: treasuryWallet,
    },
    token: toFixtureToken(openToken),
  };
}

export { getBootstrapApiBaseUrl, getBootstrapClerkJwtTemplate, seedLocalClerkOrganizationMapping };
