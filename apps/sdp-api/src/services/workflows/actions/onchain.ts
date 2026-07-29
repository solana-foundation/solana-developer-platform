import { createRpcForSdk } from "@sdp/rpc/solana";
import { type Address, assertValidAddress } from "@sdp/solana/address";
import { resolveTokenAccount } from "@solana/mosaic-sdk";
import { getDb } from "@/db";
import type { WorkflowExecutionRow } from "@/db/repositories";
import { createMosaicService } from "@/services/mosaic";
import { createOrgSigner } from "@/services/solana";
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
  mosaic: ReturnType<typeof createMosaicService>;
}

// Load the token + build the org signer and mosaic service from `env` (no HTTP
// context) — the shared preamble for every on-chain workflow action. Mirrors the
// pattern lifted into allowlist-sync.ts.
export async function prepareOnchain(
  env: Env,
  execution: WorkflowExecutionRow
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

  const signer = await createOrgSigner(
    env,
    execution.organization_id,
    execution.project_id,
    token.signingWalletId ?? undefined
  );
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
      mosaic,
    },
  };
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
