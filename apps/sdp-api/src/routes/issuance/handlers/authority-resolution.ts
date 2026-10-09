import { getTemplateInfo } from "@sdp/issuance/templates";
import { createRpc, createRpcForSdk } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import type { MovementId, Permission, TokenTransaction, TokenTransactionType } from "@sdp/types";
import { type TransactionSigner, unwrapOption } from "@solana/kit";
import { getListConfig, inspectToken } from "@solana/mosaic-sdk";
import { getTokenAclMintConfig } from "@solana/token-acl-sdk";
import { fetchMaybeMint } from "@solana-program/token-2022";
import { getDb } from "@/db";
import { type ApiKeyContext, requireAuthProjectId } from "@/lib/auth";
import { AppError, badRequest, conflict, walletNotFound } from "@/lib/errors";
import { assertFreshApiKeyCustodyWalletAccess } from "@/services/api-key-scope.service";
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

/** Shared live list authority for both signer selection and execution. */
export async function resolveAllowlistAuthority(env: Env, listAddress: string): Promise<string> {
  const { authority } = await getListConfig({
    rpc: createRpcForSdk<Parameters<typeof getListConfig>[0]["rpc"]>(env),
    listConfig: assertValidAddress(listAddress, "ablListAddress"),
  });
  return authority;
}

/** Resolve the live Token-2022 pausable authority used for pause/unpause signing. */
export async function resolvePauseAuthority(env: Env, mintAddress: string): Promise<string | null> {
  const token = await inspectToken(
    createRpcForSdk<Parameters<typeof inspectToken>[0]>(env),
    assertValidAddress(mintAddress, "mintAddress")
  );
  return token.authorities.pausableAuthority ?? null;
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
    requireAuthProjectId(params.auth),
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
    throw new Error(`Mint account ${mintAddress} was not found on-chain`);
  }

  const extensions = unwrapOption(mint.data.extensions) ?? [];
  const permanentDelegate = extensions.find(
    (extension) => extension.__kind === "PermanentDelegate"
  );
  const tokenMetadata = extensions.find((extension) => extension.__kind === "TokenMetadata");
  const metadataUpdateAuthority = tokenMetadata
    ? unwrapOption(tokenMetadata.updateAuthority)
    : null;

  return {
    mintAuthority: unwrapOption(mint.data.mintAuthority),
    freezeAuthority: unwrapOption(mint.data.freezeAuthority),
    permanentDelegate: permanentDelegate?.delegate ?? null,
    // MetadataPointer authority can redirect metadata, not edit its contents.
    metadataAuthority: metadataUpdateAuthority,
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

    // The typed mint decoder distinguishes a revoked/absent authority from a
    // failed read. Do not restore stale stored authority after revocation.
    return metadataAuthority;
  } catch (error) {
    throw new AppError(
      "SOLANA_RPC_ERROR",
      error instanceof Error ? error.message : "Failed to resolve metadata authority"
    );
  }
}

/** Resolve the wallet authority that can execute freeze/thaw, including Token ACL mints. */
export async function resolveFreezeOperationAuthority(
  env: Env,
  token: TokenRecord
): Promise<string | null> {
  if (!token) {
    return null;
  }

  if (!token.mintAddress) {
    return token.freezeAuthority;
  }

  try {
    const mint = assertValidAddress(token.mintAddress, "mintAddress");
    const mintConfig = await getTokenAclMintConfig(
      createRpcForSdk<Parameters<typeof getTokenAclMintConfig>[0]>(env),
      mint
    );
    if (mintConfig.exists) {
      return mintConfig.data.freezeAuthority;
    }

    const { freezeAuthority } = await fetchMintAuthorities(env, token.mintAddress);
    return freezeAuthority;
  } catch (error) {
    throw new AppError(
      "SOLANA_RPC_ERROR",
      error instanceof Error ? error.message : "Failed to resolve freeze authority"
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
      currentAuthority = await resolveFreezeOperationAuthority(env, token);
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
  const projectId = requireAuthProjectId(auth);
  const scopeParams = [auth.organizationId, projectId, ...walletParams];
  const rows = await getDb(env).queryMany<IssuanceWalletRow>(
    `SELECT w.id AS custody_wallet_id, w.wallet_id, w.public_key
     FROM custody_wallets w
     JOIN custody_configs c ON c.id = w.custody_config_id
     WHERE c.organization_id = ?
       AND c.project_id = ?
       ${walletFilter}

     UNION ALL

     SELECT w.id AS custody_wallet_id, w.wallet_id, w.public_key
     FROM custody_wallets w
     JOIN custody_connections c ON c.id = w.custody_connection_id
     WHERE c.organization_id = ?
       AND c.project_id = ?
       ${walletFilter}
     ORDER BY custody_wallet_id
     LIMIT 2`,
    [...scopeParams, ...scopeParams]
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

/** The issuance movements: compliance controls are exits, everything else a start. */
export type IssuanceMovement = Extract<
  MovementId,
  "issuance.authority" | "issuance.control" | "issuance.seize"
>;

async function loadResolvedAuthoritySigner(params: {
  env: Env;
  auth: ApiKeyContext;
  custodyWalletId: string;
  currentAuthority: string;
  movement: IssuanceMovement;
}): Promise<TransactionSigner> {
  const signer = await solanaServices.createOrgSignerForCustodyWallet(
    params.env,
    params.auth.organizationId,
    requireAuthProjectId(params.auth),
    params.custodyWalletId,
    params.movement
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
  movement: IssuanceMovement;
}): Promise<ResolvedIssuanceWallet & { signer: TransactionSigner }> {
  const resolved = await resolveAuthorityWallet(params);
  const signer = await loadResolvedAuthoritySigner({
    env: params.env,
    auth: params.auth,
    custodyWalletId: resolved.custodyWalletId,
    currentAuthority: params.currentAuthority,
    movement: params.movement,
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
  movement: IssuanceMovement;
}): Promise<TransactionSigner> {
  const wallet = await resolveIssuanceWallet(params);
  if (wallet.publicKey !== params.currentAuthority) {
    throw badRequest("Selected custody wallet does not control the current authority");
  }
  return loadResolvedAuthoritySigner(params);
}

/**
 * Load the Config signer for the legacy client-signed issuance flows (deploy
 * prepare, confirm, prepare-metadata). Every call names its signing wallet: the
 * request's or token's `signingWalletId`, or the API key's own binding.
 *
 * @param params - The legacy signer request.
 * @param params.env - API process environment.
 * @param params.auth - The authenticated API key context.
 * @param params.walletId - The resolved provider signing wallet ID, or null when none was named.
 * @param params.currentAuthority - When set, the authority the signer must control.
 * @param params.expectedCustodyWalletId - The exact Config wallet row pinned on the token, if any.
 * @returns The signer for the named Config wallet.
 * @throws 400 when no signing wallet was named.
 */
export async function createLegacyResolvedAuthoritySigner(params: {
  env: Env;
  auth: ApiKeyContext;
  walletId: string | null;
  currentAuthority?: string | null;
  expectedCustodyWalletId?: string | null;
  movement: IssuanceMovement;
}): Promise<TransactionSigner> {
  const { env, auth, walletId, currentAuthority, expectedCustodyWalletId, movement } = params;
  if (walletId === null) {
    throw badRequest("signingWalletId is required for the legacy issuance prepare flow");
  }
  const custodyStore = new CustodyConfigStore(getDb(env), env);
  const projectId = requireAuthProjectId(auth);
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

  const wallet =
    expectedWallet ??
    (await custodyStore.findActiveWalletByIdentifier(auth.organizationId, projectId, walletId));

  if (!wallet) {
    throw walletNotFound();
  }

  const signer = await solanaServices.createOrgSignerForCustodyWallet(
    env,
    auth.organizationId,
    projectId,
    wallet.id,
    movement
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
