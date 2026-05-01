import type { Address, TransactionSigner } from "@solana/kit";
import { getDb } from "@/db";
import type { ApiKeyContext } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { getSolanaConfig } from "@/lib/solana";
import { assertApiKeyWalletAccess } from "@/services/api-key-scope.service";
import { getTemplateInfo } from "@/services/issuance/templates";
import * as solanaServices from "@/services/solana";
import { CustodyConfigStore } from "@/services/stores/custody-config.store";
import type { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";

export type AuthorityRole = "mint" | "freeze" | "permanentDelegate" | "metadata";
type TokenRecord = Awaited<ReturnType<TokenService["getToken"]>>;

interface ParsedMintExtension {
  extension?: string;
  state?: {
    delegate?: string;
    authority?: string;
    updateAuthority?: string;
  };
}

interface ParsedMintInfo {
  extensions?: ParsedMintExtension[];
}

interface AccountInfoRpcResponse {
  result?: {
    value?: {
      data?: {
        parsed?: {
          info?: ParsedMintInfo;
        };
      };
    } | null;
  };
  error?: {
    message?: string;
  };
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

async function fetchMintPermanentDelegate(
  rpcUrl: string,
  mintAddress: string
): Promise<{ permanentDelegate: string | null; metadataAuthority: string | null }> {
  const rpcResponse = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "getAccountInfo",
      params: [mintAddress, { encoding: "jsonParsed", commitment: "confirmed" }],
    }),
  });

  if (!rpcResponse.ok) {
    throw new Error(`RPC request failed with status ${rpcResponse.status}`);
  }

  const payload = (await rpcResponse.json()) as AccountInfoRpcResponse;
  if (payload.error) {
    throw new Error(payload.error.message ?? "RPC returned an error");
  }

  const extensions = payload.result?.value?.data?.parsed?.info?.extensions ?? [];
  const permanentDelegate = extensions.find(
    (extension) => extension.extension === "permanentDelegate"
  )?.state?.delegate;
  const metadataUpdateAuthority = extensions.find(
    (extension) => extension.extension === "tokenMetadata"
  )?.state?.updateAuthority;
  const metadataPointerAuthority = extensions.find(
    (extension) => extension.extension === "metadataPointer"
  )?.state?.authority;

  return {
    permanentDelegate:
      typeof permanentDelegate === "string" && permanentDelegate.length > 0
        ? permanentDelegate
        : null,
    metadataAuthority:
      typeof metadataUpdateAuthority === "string" && metadataUpdateAuthority.length > 0
        ? metadataUpdateAuthority
        : typeof metadataPointerAuthority === "string" && metadataPointerAuthority.length > 0
          ? metadataPointerAuthority
          : null,
  };
}

export async function resolvePermanentDelegateAuthority(
  env: Env,
  tokenService: TokenService,
  token: TokenRecord
): Promise<string | null> {
  if (!token) {
    return null;
  }

  if (typeof token.extensions?.permanentDelegate === "string") {
    return token.extensions.permanentDelegate;
  }

  if (!token.mintAddress || !tokenMayHavePermanentDelegate(token)) {
    return null;
  }

  try {
    const { rpcUrl } = getSolanaConfig(env);
    const { permanentDelegate } = await fetchMintPermanentDelegate(rpcUrl, token.mintAddress);

    if (permanentDelegate && token.extensions?.permanentDelegate !== permanentDelegate) {
      await tokenService.updateTokenAuthorities(token.id, {
        permanentDelegate,
      });
    }

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
  tokenService: TokenService,
  token: TokenRecord
): Promise<string | null> {
  if (!token) {
    return null;
  }

  if (!token.mintAddress) {
    return token.metadataAuthority ?? token.mintAuthority;
  }

  try {
    const { rpcUrl } = getSolanaConfig(env);
    const { metadataAuthority } = await fetchMintPermanentDelegate(rpcUrl, token.mintAddress);

    if (metadataAuthority !== token.metadataAuthority) {
      await tokenService.updateTokenAuthorities(token.id, { metadataAuthority });
    }

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

  switch (role) {
    case "mint":
      return override ?? token.mintAuthority;
    case "freeze":
      return override ?? token.freezeAuthority;
    case "permanentDelegate":
      return resolvePermanentDelegateAuthority(env, tokenService, token);
    case "metadata":
      return resolveMetadataAuthority(env, tokenService, token);
  }
}

export async function resolveAuthoritySigner(params: {
  env: Env;
  auth: ApiKeyContext;
  token: TokenRecord;
  requestedWalletId?: string | null;
  currentAuthority: string;
}): Promise<{ signer: TransactionSigner; walletId: string | null }> {
  const { env, auth, token, requestedWalletId, currentAuthority } = params;
  const preferredWalletId =
    requestedWalletId ?? token?.signingWalletId ?? auth.signingWalletId ?? null;

  if (preferredWalletId) {
    assertApiKeyWalletAccess(auth, preferredWalletId, ["tokens:admin"]);
    const signer = await solanaServices.createOrgSigner(
      env,
      auth.organizationId,
      auth.projectId,
      preferredWalletId
    );

    if (signer.address === (currentAuthority as Address)) {
      return { signer, walletId: preferredWalletId };
    }
  }

  const custodyStore = new CustodyConfigStore(getDb(env), env.CUSTODY_ENCRYPTION_KEY);
  const authorityWallet = await custodyStore.findActiveWalletByPublicKey(
    auth.organizationId,
    auth.projectId ?? undefined,
    currentAuthority
  );

  if (!authorityWallet) {
    throw new AppError("BAD_REQUEST", "Current authority is not controlled by custody");
  }

  assertApiKeyWalletAccess(auth, authorityWallet.walletId, ["tokens:admin"]);
  const signer = await solanaServices.createOrgSigner(
    env,
    auth.organizationId,
    auth.projectId,
    authorityWallet.walletId
  );

  if (signer.address !== (currentAuthority as Address)) {
    throw new AppError("BAD_REQUEST", "Current authority is not controlled by custody");
  }

  return { signer, walletId: authorityWallet.walletId };
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
