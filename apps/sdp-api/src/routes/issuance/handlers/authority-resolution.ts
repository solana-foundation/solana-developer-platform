import { getTemplateInfo } from "@sdp/issuance/templates";
import { createRpc } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import type { Permission, TokenTransaction, TokenTransactionType } from "@sdp/types";
import { type TransactionSigner, unwrapOption } from "@solana/kit";
import { fetchMaybeMint } from "@solana-program/token-2022";
import { getDb } from "@/db";
import type { ApiKeyContext } from "@/lib/auth";
import { AppError, badRequest, conflict, walletNotFound } from "@/lib/errors";
import {
  assertApiKeyWalletAccess,
  assertFreshApiKeyCustodyWalletAccess,
} from "@/services/api-key-scope.service";
import { createSigningService } from "@/services/domain/signing.service";
import * as solanaServices from "@/services/solana";
import { CustodyConfigStore } from "@/services/stores/custody-config.store";
import type { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";

export type AuthorityRole = "mint" | "freeze" | "permanentDelegate" | "metadata";
type TokenRecord = Awaited<ReturnType<TokenService["getToken"]>>;

export interface ResolvedIssuanceWallet {
  custodyWalletId: string;
  providerWalletId: string;
  publicKey: string;
}

/** Validate an existing direct-action replay without consulting live authority state. */
export async function resolveDirectIssuanceReplay(params: {
  env: Env;
  auth: ApiKeyContext;
  tokenService: TokenService;
  tokenId: string;
  type: TokenTransactionType;
  idempotencyKey?: string;
  requestedCustodyWalletId?: string | null;
  requiredWalletPermissions: Permission[];
  fingerprintForCustodyWalletId: (custodyWalletId: string) => string | undefined;
}): Promise<TokenTransaction | null> {
  if (!params.idempotencyKey) return null;

  const transaction = await params.tokenService.findTransactionByIdempotency(
    params.auth.organizationId,
    params.idempotencyKey
  );
  if (!transaction) return null;

  const custodyWalletId = params.requestedCustodyWalletId ?? transaction.custodyWalletId;
  if (
    !custodyWalletId ||
    transaction.tokenId !== params.tokenId ||
    transaction.type !== params.type ||
    transaction.custodyWalletId !== custodyWalletId ||
    transaction.idempotencyFingerprint !== params.fingerprintForCustodyWalletId(custodyWalletId)
  ) {
    throw conflict("Idempotency key already used with different request payload");
  }

  await resolveIssuanceWallet({
    env: params.env,
    auth: params.auth,
    custodyWalletId,
    requiredWalletPermissions: params.requiredWalletPermissions,
  });
  return transaction;
}

/** Admit a genuinely new exact-wallet transaction before its durable row is created. */
export async function admitIssuanceRuntimeExecution(params: {
  env: Env;
  auth: ApiKeyContext;
  custodyWalletId: string;
  tokenService: TokenService;
  idempotencyKey?: string;
}): Promise<void> {
  if (
    params.idempotencyKey &&
    (await params.tokenService.findTransactionByIdempotency(
      params.auth.organizationId,
      params.idempotencyKey
    ))
  ) {
    return;
  }

  await createSigningService(params.env).admitRuntimeExecution(
    params.auth.organizationId,
    params.auth.projectId ?? undefined,
    params.custodyWalletId
  );
}

interface IssuanceWalletRow {
  custody_wallet_id: string;
  wallet_id: string;
  public_key: string;
}

function tokenMayHavePermanentDelegate(token: TokenRecord): boolean {
  if (!token) {
    return false;
  }

  if (typeof token.extensions?.permanentDelegate === "string") {
    return true;
  }

  const templateInfo = getTemplateInfo(token.template);
  return templateInfo?.requiredExtensions?.includes("permanentDelegate") ?? false;
}

async function fetchMintAuthorities(
  env: Env,
  mintAddress: string
): Promise<{
  mintAuthority: string | null;
  freezeAuthority: string | null;
  permanentDelegate: string | null;
  metadataAuthority: string | null;
}> {
  const mint = await fetchMaybeMint(
    createRpc(env),
    assertValidAddress(mintAddress, "mintAddress"),
    { commitment: "confirmed" }
  );
  if (!mint.exists) {
    return {
      mintAuthority: null,
      freezeAuthority: null,
      permanentDelegate: null,
      metadataAuthority: null,
    };
  }

  const extensions = unwrapOption(mint.data.extensions) ?? [];
  const permanentDelegate = extensions.find(
    (extension) => extension.__kind === "PermanentDelegate"
  );
  const tokenMetadata = extensions.find((extension) => extension.__kind === "TokenMetadata");
  const metadataPointer = extensions.find((extension) => extension.__kind === "MetadataPointer");
  const metadataUpdateAuthority = tokenMetadata
    ? unwrapOption(tokenMetadata.updateAuthority)
    : null;
  const metadataPointerAuthority = metadataPointer ? unwrapOption(metadataPointer.authority) : null;

  return {
    mintAuthority: unwrapOption(mint.data.mintAuthority),
    freezeAuthority: unwrapOption(mint.data.freezeAuthority),
    permanentDelegate: permanentDelegate?.delegate ?? null,
    metadataAuthority: metadataUpdateAuthority ?? metadataPointerAuthority,
  };
}

export async function resolvePermanentDelegateAuthority(
  env: Env,
  _tokenService: TokenService,
  token: TokenRecord
): Promise<string | null> {
  if (!token) {
    return null;
  }

  if (!token.mintAddress || !tokenMayHavePermanentDelegate(token)) {
    return null;
  }

  try {
    const { permanentDelegate } = await fetchMintAuthorities(env, token.mintAddress);

    return permanentDelegate;
  } catch (error) {
    throw new AppError(
      "SOLANA_RPC_ERROR",
      error instanceof Error ? error.message : "Failed to resolve permanent delegate authority"
    );
  }
}

export async function resolveMetadataAuthority(
  env: Env,
  _tokenService: TokenService,
  token: TokenRecord
): Promise<string | null> {
  if (!token) {
    return null;
  }

  if (!token.mintAddress) {
    return token.metadataAuthority ?? token.mintAuthority;
  }

  try {
    const { metadataAuthority } = await fetchMintAuthorities(env, token.mintAddress);

    return metadataAuthority;
  } catch (error) {
    throw new AppError(
      "SOLANA_RPC_ERROR",
      error instanceof Error ? error.message : "Failed to resolve metadata authority"
    );
  }
}

export async function resolveCurrentAuthorityForRole(
  env: Env,
  tokenService: TokenService,
  token: TokenRecord,
  role: AuthorityRole,
  override?: string
): Promise<string | null> {
  if (!token) {
    return null;
  }

  let currentAuthority: string | null;
  switch (role) {
    case "mint": {
      if (!token.mintAddress) {
        currentAuthority = token.mintAuthority;
        break;
      }
      try {
        const { mintAuthority } = await fetchMintAuthorities(env, token.mintAddress);
        currentAuthority = mintAuthority;
      } catch (error) {
        throw new AppError(
          "SOLANA_RPC_ERROR",
          error instanceof Error ? error.message : "Failed to resolve mint authority"
        );
      }
      break;
    }
    case "freeze": {
      if (!token.mintAddress) {
        currentAuthority = token.freezeAuthority;
        break;
      }
      try {
        const { freezeAuthority } = await fetchMintAuthorities(env, token.mintAddress);
        currentAuthority = freezeAuthority;
      } catch (error) {
        throw new AppError(
          "SOLANA_RPC_ERROR",
          error instanceof Error ? error.message : "Failed to resolve freeze authority"
        );
      }
      break;
    }
    case "permanentDelegate":
      currentAuthority = await resolvePermanentDelegateAuthority(env, tokenService, token);
      break;
    case "metadata":
      currentAuthority = await resolveMetadataAuthority(env, tokenService, token);
      break;
  }

  if (override !== undefined && override !== currentAuthority) {
    throw badRequest("Provided current authority does not match the on-chain authority");
  }

  return currentAuthority;
}

async function findIssuanceWallets(params: {
  env: Env;
  auth: ApiKeyContext;
  custodyWalletId?: string;
  publicKey?: string;
}): Promise<ResolvedIssuanceWallet[]> {
  const { env, auth, custodyWalletId, publicKey } = params;
  const walletPredicates = [
    custodyWalletId ? "w.id = ?" : null,
    publicKey ? "w.public_key = ?" : null,
  ].filter((predicate): predicate is string => predicate !== null);
  const walletFilter = walletPredicates.length > 0 ? `AND ${walletPredicates.join(" AND ")}` : "";
  const walletParams = [custodyWalletId, publicKey].filter(
    (value): value is string => value !== undefined
  );
  const projectId = auth.projectId ?? undefined;
  const configScope = projectId
    ? "(c.project_id = ? OR c.project_id IS NULL)"
    : "c.project_id IS NULL";
  const configParams = projectId
    ? [auth.organizationId, projectId, ...walletParams]
    : [auth.organizationId, ...walletParams];
  const connectionQuery = projectId
    ? `
       UNION ALL

       SELECT w.id AS custody_wallet_id, w.wallet_id, w.public_key
       FROM custody_wallets w
       JOIN custody_connections c ON c.id = w.custody_connection_id
       WHERE c.organization_id = ?
         AND c.project_id = ?
         ${walletFilter}`
    : "";
  const connectionParams = projectId ? [auth.organizationId, projectId, ...walletParams] : [];
  const rows = await getDb(env).queryMany<IssuanceWalletRow>(
    `SELECT w.id AS custody_wallet_id, w.wallet_id, w.public_key
     FROM custody_wallets w
     JOIN custody_configs c ON c.id = w.custody_config_id
     WHERE c.organization_id = ?
       AND ${configScope}
       ${walletFilter}
     ${connectionQuery}
     ORDER BY custody_wallet_id
     LIMIT 2`,
    [...configParams, ...connectionParams]
  );

  return rows.map((row) => ({
    custodyWalletId: row.custody_wallet_id,
    providerWalletId: row.wallet_id,
    publicKey: row.public_key,
  }));
}

async function assertFreshIssuanceWalletAccess(
  env: Env,
  auth: ApiKeyContext,
  custodyWalletId: string,
  requiredWalletPermissions: Permission[]
): Promise<void> {
  await assertFreshApiKeyCustodyWalletAccess(
    getDb(env),
    auth,
    custodyWalletId,
    requiredWalletPermissions
  );
}

/** Resolve one exact tenant-scoped wallet for draft or direct-deploy selection. */
export async function resolveIssuanceWallet(params: {
  env: Env;
  auth: ApiKeyContext;
  custodyWalletId: string;
  requiredWalletPermissions: Permission[];
}): Promise<ResolvedIssuanceWallet> {
  const matches = await findIssuanceWallets(params);
  const wallet = matches[0];
  if (!wallet) {
    throw walletNotFound();
  }
  await assertFreshIssuanceWalletAccess(
    params.env,
    params.auth,
    wallet.custodyWalletId,
    params.requiredWalletPermissions
  );
  return wallet;
}

/** Resolve exactly one tenant-scoped wallet that controls the current authority. */
export async function resolveAuthorityWallet(params: {
  env: Env;
  auth: ApiKeyContext;
  requestedCustodyWalletId?: string | null;
  currentAuthority: string;
  requiredWalletPermissions: Permission[];
}): Promise<ResolvedIssuanceWallet> {
  const { env, auth, requestedCustodyWalletId, currentAuthority, requiredWalletPermissions } =
    params;
  if (requestedCustodyWalletId) {
    const wallet = await resolveIssuanceWallet({
      env,
      auth,
      custodyWalletId: requestedCustodyWalletId,
      requiredWalletPermissions,
    });
    if (wallet.publicKey !== currentAuthority) {
      throw badRequest("Selected custody wallet does not control the current authority");
    }
    return wallet;
  }

  const matches = await findIssuanceWallets({ env, auth, publicKey: currentAuthority });
  if (matches.length === 0) {
    throw conflict("Current authority is not controlled by custody");
  }
  if (matches.length > 1) {
    throw conflict("Current authority wallet is ambiguous");
  }

  const wallet = matches[0];
  await assertFreshIssuanceWalletAccess(
    env,
    auth,
    wallet.custodyWalletId,
    requiredWalletPermissions
  );
  return wallet;
}

async function loadResolvedAuthoritySigner(params: {
  env: Env;
  auth: ApiKeyContext;
  custodyWalletId: string;
  currentAuthority: string;
}): Promise<TransactionSigner> {
  const signer = await solanaServices.createOrgSignerForCustodyWallet(
    params.env,
    params.auth.organizationId,
    params.auth.projectId,
    params.custodyWalletId
  );
  if (signer.address !== params.currentAuthority) {
    throw conflict("Current authority is not controlled by custody");
  }
  return signer;
}

export async function resolveAuthoritySigner(params: {
  env: Env;
  auth: ApiKeyContext;
  requestedCustodyWalletId?: string | null;
  currentAuthority: string;
  requiredWalletPermissions: Permission[];
}): Promise<ResolvedIssuanceWallet & { signer: TransactionSigner }> {
  const resolved = await resolveAuthorityWallet(params);
  const signer = await loadResolvedAuthoritySigner({
    env: params.env,
    auth: params.auth,
    custodyWalletId: resolved.custodyWalletId,
    currentAuthority: params.currentAuthority,
  });

  return { ...resolved, signer };
}

/** Load a persisted exact authority signer for execution or Approval replay. */
export async function createResolvedAuthoritySigner(params: {
  env: Env;
  auth: ApiKeyContext;
  custodyWalletId: string;
  currentAuthority: string;
  requiredWalletPermissions: Permission[];
}): Promise<TransactionSigner> {
  const wallet = await resolveIssuanceWallet(params);
  if (wallet.publicKey !== params.currentAuthority) {
    throw badRequest("Selected custody wallet does not control the current authority");
  }
  return loadResolvedAuthoritySigner(params);
}

/** Legacy Provider-ID resolution retained only for legacy prepare-family callers. */
export async function resolveLegacyAuthorityWallet(params: {
  env: Env;
  auth: ApiKeyContext;
  token: TokenRecord;
  requestedWalletId?: string | null;
  currentAuthority: string;
}): Promise<{ walletId: string }> {
  const { env, auth, token, requestedWalletId, currentAuthority } = params;
  const preferredWalletId =
    requestedWalletId ?? token?.signingWalletId ?? auth.signingWalletId ?? null;
  const custodyStore = new CustodyConfigStore(getDb(env), env);

  if (preferredWalletId) {
    assertApiKeyWalletAccess(auth, preferredWalletId, ["tokens:admin"]);
    const preferredWallet = await custodyStore.findActiveWalletByIdentifier(
      auth.organizationId,
      auth.projectId ?? undefined,
      preferredWalletId
    );
    if (preferredWallet?.publicKey === currentAuthority) {
      return { walletId: preferredWallet.walletId };
    }
  }

  const authorityWallet = await custodyStore.findActiveWalletByPublicKey(
    auth.organizationId,
    auth.projectId ?? undefined,
    currentAuthority
  );

  if (!authorityWallet) {
    throw badRequest("Current authority is not controlled by custody");
  }

  assertApiKeyWalletAccess(auth, authorityWallet.walletId, ["tokens:admin"]);

  return { walletId: authorityWallet.walletId };
}

export async function resolveLegacyAuthoritySigner(params: {
  env: Env;
  auth: ApiKeyContext;
  token: TokenRecord;
  requestedWalletId?: string | null;
  currentAuthority: string;
}): Promise<{ signer: TransactionSigner; walletId: string }> {
  const resolved = await resolveLegacyAuthorityWallet(params);
  const signer = await createLegacyResolvedAuthoritySigner({
    env: params.env,
    auth: params.auth,
    walletId: resolved.walletId,
    currentAuthority: params.currentAuthority,
  });
  return { signer, walletId: resolved.walletId };
}

export async function createLegacyResolvedAuthoritySigner(params: {
  env: Env;
  auth: ApiKeyContext;
  walletId: string | null;
  currentAuthority?: string | null;
  expectedCustodyWalletId?: string | null;
}): Promise<TransactionSigner> {
  const { env, auth, walletId, currentAuthority, expectedCustodyWalletId } = params;
  const custodyStore = new CustodyConfigStore(getDb(env), env);
  const projectId = auth.projectId ?? undefined;
  const expectedWallet = expectedCustodyWalletId
    ? await custodyStore.findActiveWalletByIdentifier(
        auth.organizationId,
        projectId,
        expectedCustodyWalletId
      )
    : null;

  if (expectedCustodyWalletId && !expectedWallet) {
    throw conflict("Legacy issuance prepare flow requires a Config wallet");
  }

  if (expectedWallet && expectedWallet.walletId !== walletId) {
    throw conflict("Legacy issuance provider wallet does not match its exact Config wallet");
  }

  const defaultConfig = walletId
    ? null
    : await custodyStore.findActive(auth.organizationId, projectId);
  const walletIdentifier = walletId ?? defaultConfig?.defaultWalletId;
  const wallet =
    expectedWallet ??
    (walletIdentifier
      ? await custodyStore.findActiveWalletByIdentifier(
          auth.organizationId,
          projectId,
          walletIdentifier
        )
      : null);

  if (!wallet) {
    throw walletNotFound();
  }

  const signer = await solanaServices.createOrgSignerForCustodyWallet(
    env,
    auth.organizationId,
    auth.projectId,
    wallet.id
  );

  if (currentAuthority && signer.address !== currentAuthority) {
    throw badRequest("Current authority is not controlled by custody");
  }

  return signer;
}

export function getInitialPermanentDelegateAuthority(
  token: TokenRecord,
  custodyAddress: string
): string | undefined {
  if (!token) {
    return undefined;
  }

  if (typeof token.extensions?.permanentDelegate === "string") {
    return token.extensions.permanentDelegate;
  }

  const templateInfo = getTemplateInfo(token.template);
  if (templateInfo?.requiredExtensions?.includes("permanentDelegate")) {
    return custodyAddress;
  }

  return undefined;
}
