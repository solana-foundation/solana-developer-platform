import { createRpcForSdk } from "@sdp/rpc/solana";
import { type Address, assertValidAddress } from "@sdp/solana/address";
import { resolveTokenAccount } from "@solana/mosaic-sdk";
import { getDb } from "@/db";
import type { WorkflowExecutionRow } from "@/db/repositories";
import { createMosaicService } from "@/services/issuance/mosaic";
import { createOrgSigner } from "@/services/solana";
import { CustodyConfigStore } from "@/services/stores/custody-config.store";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import type { ActionContext, ActionExecutionResult } from "./types";

type MosaicSdkRpc = Parameters<typeof resolveTokenAccount>[0];
type OrgSigner = Awaited<ReturnType<typeof createOrgSigner>>;
type LoadedToken = NonNullable<Awaited<ReturnType<TokenService["getToken"]>>>;

// Permanent failure (no retry): a config/data gap that won't self-heal on its own —
// missing token, bad address, unknown param, revoked capability.
export function permanentFail(error: string): ActionExecutionResult {
  return { status: "failed", retryable: false, result: {}, error };
}
// Transient failure (engine retries with backoff): RPC/chain hiccup that may clear.
export function transientFail(error: string): ActionExecutionResult {
  return { status: "failed", retryable: true, result: {}, error };
}
export function succeeded(result: Record<string, unknown>): ActionExecutionResult {
  return { status: "succeeded", retryable: false, result };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Address validation that returns null (→ caller maps to permanent fail) rather than
// throwing, so a bad param never reaches an on-chain call.
export function safeAddress(value: string, label: string): Address | null {
  try {
    return assertValidAddress(value, label);
  } catch {
    return null;
  }
}

export interface OnchainContext {
  env: Env;
  execution: WorkflowExecutionRow;
  token: LoadedToken;
  decimals: number;
  mintAddress: Address;
  signer: OrgSigner;
  // The custody wallet `signer` was built from — which is NOT always the token's
  // `signingWalletId`, since an authority fallback can settle on a different wallet.
  // Wallet operation policy has to be evaluated against this one: the whole point of the
  // policy is to bound what the signing key is allowed to do. Null only when the token
  // named no wallet and no fallback ran, i.e. the org default signer.
  signerWalletId: string | null;
  mosaic: ReturnType<typeof createMosaicService>;
}

// Which recorded authority an action signs with. Each on-chain operation is authorized
// by a specific key, and they are only the same key while a token still uses one wallet
// for everything — a rotation or a split-authority deploy separates them.
export type RequiredAuthority = "mint" | "freeze";

// Load the token + build the org signer and mosaic service from `env` (no HTTP
// context) — the shared preamble for every on-chain workflow action. Mirrors the
// pattern lifted into allowlist-sync.ts.
export async function prepareOnchain(
  env: Env,
  execution: WorkflowExecutionRow,
  requires?: RequiredAuthority
): Promise<{ ok: true; ctx: OnchainContext } | { ok: false; result: ActionExecutionResult }> {
  const tokenService = new TokenService(getDb(env));
  const token = await tokenService.getToken({
    tokenId: execution.token_id,
    organizationId: execution.organization_id,
    projectId: execution.project_id,
  });
  if (!token) {
    return { ok: false, result: permanentFail("TOKEN_NOT_FOUND") };
  }
  if (!token.mintAddress) {
    return { ok: false, result: permanentFail("TOKEN_NOT_DEPLOYED") };
  }
  if (token.decimals == null) {
    return { ok: false, result: permanentFail("TOKEN_DECIMALS_UNKNOWN") };
  }

  const resolved = await resolveSignerForAuthority(env, execution, token, requires);
  if (!resolved.ok) {
    return resolved;
  }
  const signer = resolved.signer;

  const mosaic = createMosaicService(env, signer, "sponsored");

  return {
    ok: true,
    ctx: {
      env,
      execution,
      token,
      decimals: token.decimals,
      mintAddress: assertValidAddress(token.mintAddress, "mintAddress"),
      signer,
      signerWalletId: resolved.walletId,
      mosaic,
    },
  };
}

// The active custody wallet holding a public key, or null when none does (a key custody
// does not manage, e.g. a local dev signer). Never throws: a lookup failure must not turn
// into a retried action.
function lookupCustodyWallet(env: Env, execution: WorkflowExecutionRow, publicKey: string) {
  return new CustodyConfigStore(getDb(env), env)
    .findActiveWalletByPublicKey(
      execution.organization_id,
      execution.project_id ?? undefined,
      publicKey
    )
    .catch(() => null);
}

async function findCustodyWalletId(
  env: Env,
  execution: WorkflowExecutionRow,
  publicKey: string
): Promise<string | null> {
  const wallet = await lookupCustodyWallet(env, execution, publicKey);
  return wallet?.walletId ?? null;
}

// Build the signer that actually controls the authority this action needs.
//
// The token's `signingWalletId` is the right key only while a token uses one wallet for
// everything. When it doesn't — after an authority rotation, or a deploy that split mint
// and freeze across wallets — signing with it produces a transaction the chain rejects
// with an opaque error, five times over. So: try the token's wallet, and if it isn't the
// recorded authority, look up the custody wallet that is (the same fallback the HTTP
// `resolveAuthoritySigner` performs, minus its API-key scoping, which has no analogue
// here — the engine acts as the org).
async function resolveSignerForAuthority(
  env: Env,
  execution: WorkflowExecutionRow,
  token: LoadedToken,
  requires?: RequiredAuthority
): Promise<
  | { ok: true; signer: OrgSigner; walletId: string | null }
  | { ok: false; result: ActionExecutionResult }
> {
  // Signer construction reaches custody and can fail for reasons no retry fixes (the
  // wallet was removed, the key is unavailable). Left to throw it would escape into the
  // engine's generic catch and be rescheduled up to `max_attempts`.
  const build = async (walletId?: string): Promise<OrgSigner | ActionExecutionResult> => {
    try {
      return await createOrgSigner(env, execution.organization_id, execution.project_id, walletId);
    } catch (error) {
      return permanentFail(`SIGNER_UNAVAILABLE:${errorMessage(error)}`);
    }
  };

  const preferred = await build(token.signingWalletId ?? undefined);
  if ("status" in preferred) {
    return { ok: false, result: preferred };
  }

  const required = requires === "mint" ? token.mintAuthority : token.freezeAuthority;
  // No declared authority to match (or none demanded): the token's wallet is all we know.
  if (!requires || !required || preferred.address === (required as string)) {
    return {
      ok: true,
      signer: preferred,
      // A token that names no wallet still signs with one: `getTransactionSigner` with no
      // wallet id resolves the org's effective custody config and signs with that config's
      // wallet — a real custody row that can carry an operation policy. Reporting null
      // here let that wallet mint unbounded, so the id is recovered from the key that will
      // actually sign. Null now means only what it says: no custody wallet holds this key.
      walletId:
        token.signingWalletId ?? (await findCustodyWalletId(env, execution, preferred.address)),
    };
  }

  const authorityWallet = await lookupCustodyWallet(env, execution, required);
  if (!authorityWallet) {
    return {
      ok: false,
      result: permanentFail(`AUTHORITY_NOT_IN_CUSTODY:${requires}`),
    };
  }

  const authoritySigner = await build(authorityWallet.walletId);
  if ("status" in authoritySigner) {
    return { ok: false, result: authoritySigner };
  }
  if (authoritySigner.address !== (required as string)) {
    return { ok: false, result: permanentFail(`AUTHORITY_MISMATCH:${requires}`) };
  }
  // The fallback wallet is the one that signs, so it is the one the policy must bind.
  return { ok: true, signer: authoritySigner, walletId: authorityWallet.walletId };
}

// The wallet an action targets: an explicit `params.wallet` wins, otherwise the
// trigger's subject wallet (e.g. the KYC'd holder in the payload).
export function resolveTargetWallet(
  execution: WorkflowExecutionRow,
  action: ActionContext
): string | null {
  const fromParams = action.params.wallet;
  if (typeof fromParams === "string" && fromParams.trim()) {
    return fromParams.trim();
  }
  const fromPayload = execution.trigger_payload.wallet;
  return typeof fromPayload === "string" && fromPayload.trim() ? fromPayload.trim() : null;
}

// A named string/number param as a trimmed string, or null when absent/blank.
export function resolveParam(action: ActionContext, key: string): string | null {
  const value = action.params[key];
  if (typeof value === "number") {
    return String(value);
  }
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Derive the associated token account for a wallet on this mint (freeze/burn targets
// operate on token accounts, not wallets). RPC-backed — callers run it inside their
// try so a transient RPC error becomes a retry.
export async function resolveWalletTokenAccount(
  env: Env,
  wallet: Address,
  mint: Address
): Promise<Address> {
  const rpc = createRpcForSdk<MosaicSdkRpc>(env);
  const resolved = await resolveTokenAccount(rpc, wallet, mint);
  return resolved.tokenAccount;
}
