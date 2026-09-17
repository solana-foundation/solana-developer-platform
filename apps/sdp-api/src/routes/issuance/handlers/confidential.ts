/**
 * Confidential transfer operations (Token-2022 encrypted balances).
 *
 * Devnet only. Execute-only: the ElGamal/AES keys are derived server-side from
 * the owner's custody signature (see `services/issuance/confidential-keys`), so
 * there is nothing a client could sign independently in a prepare step. Genuine
 * non-custodial prepare mode needs client-derived keys and is gated on HOO-1507.
 *
 * Holder-signed operations are addressed by the owner WALLET and derive the
 * associated token account from (wallet, mint). `approve` is the exception: it
 * is signed by the mint's confidential-transfer authority against someone
 * else's account, so it names that account directly.
 */

import type {
  MosaicTransactionPlanResult,
  MosaicTransactionResult,
} from "@sdp/issuance/mosaic/types";
import { MosaicTransactionPlanError } from "@sdp/issuance/mosaic/types";
import { createRpcForSdk } from "@sdp/rpc/solana";
import { type Address, assertValidAddress } from "@sdp/solana/address";
import type { Permission, TokenTransaction, TokenTransactionType } from "@sdp/types";
import { createNoopSigner } from "@solana/kit";
import { resolveTokenAccount } from "@solana/mosaic-sdk";
import type { Context, Next } from "hono";
import { getDb } from "@/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { type AuditAction, AuditService } from "@/services/audit.service";
import { type ConfidentialKeys, withConfidentialKeys } from "@/services/issuance/confidential-keys";
import {
  planSignatureFields,
  summarizeConfidentialSettlement,
} from "@/services/issuance/confidential-plan";
import { tokenHasConfidentialBalances } from "@/services/issuance/confidential-support";
import type { TokenService } from "@/services/token.service";
import { parsePositiveTokenAmount } from "@/services/token-operation.service";
import type { Env } from "@/types/env";
import {
  createIssuanceMosaicService,
  getTenantTokenService,
  requireProjectScope,
} from "../helpers";
import type {
  confidentialAccountSchema,
  confidentialAmountSchema,
  confidentialApproveSchema,
  confidentialTransferSchema,
} from "../schemas";
import { confidentialBalanceQuerySchema } from "../schemas";
import {
  resolveAuthoritySigner,
  resolveAuthorityWallet,
  resolveCurrentAuthorityForRole,
} from "./authority-resolution";
import { buildIdempotencyMetadata } from "./idempotency";
import {
  persistSettledTransactionThenOutcome,
  recoverSettledTransactionReplay,
} from "./settled-transaction";

type AppContext = Context<{ Bindings: Env }>;
type MosaicSdkRpc = Parameters<typeof resolveTokenAccount>[0];
type TokenRecord = NonNullable<Awaited<ReturnType<TokenService["getToken"]>>>;
type MosaicService = ReturnType<typeof createIssuanceMosaicService>;

/** Confidential transaction types are also audit actions, one-to-one. */
type ConfidentialOperation = Extract<TokenTransactionType, `confidential_${string}`> & AuditAction;

/**
 * The custody-wallet permissions each operation's signing wallet must carry.
 * Mirrors the `requirePermissions` guard on the matching route: the route check
 * is about the API key, this one is about the wallet it reaches for.
 */
const CONFIDENTIAL_OPERATION_WALLET_PERMISSIONS = {
  confidential_configure: ["tokens:write"],
  confidential_approve: ["tokens:admin"],
  confidential_deposit: ["tokens:write"],
  confidential_apply_pending: ["tokens:write"],
  confidential_transfer: ["tokens:admin"],
  confidential_withdraw: ["tokens:admin"],
  confidential_empty_account: ["tokens:write"],
} as const satisfies Record<ConfidentialOperation, readonly Permission[]>;

/**
 * Confidential balances are still being validated on devnet. Mainnet exposure is
 * a deliberate migration, not a config flip — see the matching note on the
 * `confidentialTransfers` entry in `@sdp/issuance/capabilities`.
 */
export async function requireConfidentialTransfersDevnet(c: AppContext, next: Next) {
  if ((c.env.SOLANA_NETWORK ?? "devnet") !== "devnet") {
    throw new AppError("SERVICE_UNAVAILABLE", "Confidential transfers are devnet-only");
  }
  await next();
}

export function assertTokenSupportsConfidentialTransfers(token: TokenRecord): void {
  if (tokenHasConfidentialBalances(token)) {
    return;
  }
  throw new AppError(
    "CONFIDENTIAL_NOT_ENABLED",
    "This token was not created with confidential balances enabled.",
    { hint: "The confidential transfer extension can only be added when the mint is created." }
  );
}

interface ResolvedToken {
  token: TokenRecord;
  tokenService: TokenService;
  mintAddress: Address;
  auth: ReturnType<typeof requireProjectScope>["auth"];
  orgId: string;
  projectId: string;
}

async function resolveConfidentialToken(c: AppContext, tokenId: string): Promise<ResolvedToken> {
  const { auth, projectId, orgId } = requireProjectScope(c);
  const tokenService = getTenantTokenService(c);
  const token = await tokenService.getToken({ tokenId, organizationId: orgId, projectId });

  if (!token) {
    throw notFound("Token");
  }
  if (!token.mintAddress) {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }
  assertTokenSupportsConfidentialTransfers(token);

  return {
    token,
    tokenService,
    mintAddress: assertValidAddress(token.mintAddress, "mintAddress"),
    auth,
    orgId,
    projectId,
  };
}

/**
 * Resolve a wallet or token-account address to its initialized token account for
 * this mint. Confidential operations act on an existing account — configure is
 * no exception, since the account must already hold the mint.
 */
async function resolveConfidentialTokenAccount(
  env: Env,
  requestedAddress: Address,
  mintAddress: Address,
  field: string
): Promise<Address> {
  const rpc = createRpcForSdk<MosaicSdkRpc>(env);
  const resolved = await resolveTokenAccount(rpc, requestedAddress, mintAddress);

  if (!resolved.isInitialized) {
    throw new AppError(
      "TOKEN_ACCOUNT_NOT_FOUND",
      "This wallet does not currently have a token account for this mint.",
      { field, hint: "Use a wallet that already holds this token." }
    );
  }
  return resolved.tokenAccount;
}

// ═══════════════════════════════════════════════════════════════════════════
// Program error mapping
// ═══════════════════════════════════════════════════════════════════════════
//
// Token-2022 rejects these three states on-chain, and each is an ordinary
// caller mistake rather than a server fault. Without the mapping they surface
// as an opaque 500 carrying a raw `InstructionError` blob.

/** ExtensionAlreadyInitialized — the account is already configured. */
const TOKEN_2022_EXTENSION_ALREADY_INITIALIZED = 22;
/** ConfidentialTransferAccountHasBalance — cannot close a non-empty account. */
const TOKEN_2022_CONFIDENTIAL_ACCOUNT_HAS_BALANCE = 23;
/** ConfidentialTransferAccountNotApproved — whitelist policy, approve first. */
const TOKEN_2022_CONFIDENTIAL_ACCOUNT_NOT_APPROVED = 24;

/** `SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM` — stable across @solana/errors 6 and 7. */
const SOLANA_ERROR_INSTRUCTION_ERROR_CUSTOM = 4615026;

/** Every error in a `cause` chain, outermost first. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  // `cause` chains here are a handful deep; the bound only guards a cycle.
  for (let depth = 0; current !== null && current !== undefined && depth < 16; depth += 1) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/**
 * The Token-2022 program error behind a failed confidential operation.
 *
 * Three wire forms reach us, and all three must parse or the 22/23/24 mapping
 * below is dead code on whichever path is missed:
 *   - **direct RPC simulation** (the path every confidential op takes, since
 *     they are holder-paid and bypass Kora): a `SolanaError` whose message is
 *     only "Transaction simulation failed". The code is *structured*, nested in
 *     the `cause` chain as `context.code` under `context.__code ===
 *     SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM`, with the rendered hex form in
 *     `context.logs`. Read the structure rather than the message.
 *   - **Kora's pre-sign simulation** — the runtime's rendered string, hex:
 *     `... failed: custom program error: 0x16`
 *   - **a stringified `InstructionError`**, decimal: `{"Custom":22}`
 */
function readCustomProgramError(error: unknown): number | null {
  for (const link of causeChain(error)) {
    const context = (link as { context?: Record<string, unknown> }).context;
    if (!context) {
      continue;
    }

    if (
      context.__code === SOLANA_ERROR_INSTRUCTION_ERROR_CUSTOM &&
      typeof context.code === "number"
    ) {
      return context.code;
    }

    // Some shapes carry no structured code but do carry the program's logs.
    if (Array.isArray(context.logs)) {
      for (const line of context.logs) {
        const logged =
          typeof line === "string" && line.match(/custom program error:\s*0x([0-9a-f]+)/i);
        if (logged) {
          return Number.parseInt(logged[1], 16);
        }
      }
    }
  }

  const message = error instanceof Error ? error.message : "";
  const json = message.match(/"Custom":\s*"?(\d+)"?/);
  if (json) {
    return Number(json[1]);
  }
  const hex = message.match(/custom program error:\s*0x([0-9a-f]+)/i);
  return hex ? Number.parseInt(hex[1], 16) : null;
}

function toConfidentialAppError(error: unknown): AppError | null {
  switch (readCustomProgramError(error)) {
    case TOKEN_2022_EXTENSION_ALREADY_INITIALIZED:
      return new AppError(
        "CONFLICT",
        "This account is already configured for confidential transfers.",
        { hint: "Configure runs once per account; deposit or transfer directly." }
      );
    case TOKEN_2022_CONFIDENTIAL_ACCOUNT_HAS_BALANCE:
      return new AppError("CONFLICT", "This confidential account still holds a balance.", {
        hint: "Apply any pending balance and withdraw to zero before emptying the account.",
      });
    case TOKEN_2022_CONFIDENTIAL_ACCOUNT_NOT_APPROVED:
      return new AppError(
        "BAD_REQUEST",
        "This confidential account has not been approved to transact.",
        { hint: "The mint uses the whitelist policy; run the approve operation first." }
      );
    default:
      return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared execute skeleton
// ═══════════════════════════════════════════════════════════════════════════

interface RunConfidentialOptions {
  c: AppContext;
  resolved: ResolvedToken;
  operation: ConfidentialOperation;
  /** Signer for this operation — the account owner, or the mint's confidential authority. */
  signerAddress: string;
  requestedCustodyWalletId?: string | null;
  /** Persisted on the transaction row and used for replay recovery. */
  params: Record<string, unknown>;
  /** Fingerprinted for idempotency; the raw request body. */
  requestBody: unknown;
  /**
   * `walletId` is the custody wallet actually resolved for `signerAddress` — not
   * the one the caller asked for. Key derivation must use it, or a holder who
   * omits `signingCustodyWalletId` derives against the org default wallet and the
   * signature never matches the owner.
   */
  run: (
    mosaic: MosaicService,
    walletId: string | null
  ) => Promise<MosaicTransactionResult | MosaicTransactionPlanResult>;
}

/**
 * The freeze/seize execute skeleton, generalized over the seven confidential
 * operations: idempotent transaction row → replay short-circuit → critical audit
 * bracket → on-chain call → settlement.
 *
 * Multi-transaction plans settle on the LAST transaction (the one that carries
 * the operation's effect; the others set up and tear down proof context state).
 * Every signature is journaled into `params.planSignatures` so the intermediate
 * accounts stay traceable.
 */
async function runConfidentialOperation(
  options: RunConfidentialOptions
): Promise<TokenTransaction> {
  const { c, resolved, operation, params } = options;
  const { tokenService, token, auth } = resolved;

  const { signer, providerWalletId: walletId } = await resolveAuthoritySigner({
    env: c.env,
    auth,
    requestedCustodyWalletId: options.requestedCustodyWalletId,
    currentAuthority: options.signerAddress,
    requiredWalletPermissions: [...CONFIDENTIAL_OPERATION_WALLET_PERMISSIONS[operation]],
  });

  const idempotencyMetadata = buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
    tokenId: token.id,
    operation,
    mode: "execute",
    params: options.requestBody,
  });

  const { transaction: tx, replayed } = await tokenService.createTransaction({
    tokenId: token.id,
    organizationId: auth.organizationId,
    type: operation,
    params,
    idempotencyKey: idempotencyMetadata.idempotencyKey,
    idempotencyFingerprint: idempotencyMetadata.idempotencyFingerprint,
    initiatedByKeyId: auth.id,
  });

  const auditService = new AuditService(getDb(c.env));
  if (replayed) {
    return recoverSettledTransactionReplay({
      auditService,
      tokenService,
      transaction: tx,
      action: operation,
      params,
    });
  }

  const mosaic = createIssuanceMosaicService(c, signer, "sponsored");
  const auditIntent = await auditService.beginCritical(c, {
    action: operation,
    resourceType: "token_transaction",
    resourceId: tx.id,
    metadata: { tokenId: token.id, ...params, mode: "execute" },
  });
  let onChainEffectCompleted = false;

  try {
    const settlement = summarizeConfidentialSettlement(await options.run(mosaic, walletId));
    // An empty plan means nothing landed, so the flag stays false and the catch
    // below records the failure rather than leaving the row pending forever.
    if (!settlement) {
      throw new AppError("SOLANA_RPC_ERROR", "Confidential operation submitted no transactions");
    }
    onChainEffectCompleted = true;
    const planFields = planSignatureFields(settlement);

    const updatedTx = await persistSettledTransactionThenOutcome({
      tokenService,
      transaction: tx,
      evidence: { signature: settlement.signature, slot: Number(settlement.slot) },
      params: {
        ...params,
        signature: settlement.signature,
        slot: settlement.slot.toString(),
        ...planFields,
      },
      persistOutcome: () =>
        auditService.completeCritical(c, auditIntent, {
          metadata: {
            signature: settlement.signature,
            slot: settlement.slot.toString(),
            ...planFields,
          },
        }),
    });

    return updatedTx;
  } catch (error) {
    if (!onChainEffectCompleted) {
      // A plan that failed partway still landed its earlier transactions. Their
      // signatures are the only handle on the proof context-state accounts they
      // created, so journal them onto the failed row rather than dropping them.
      const landed =
        error instanceof MosaicTransactionPlanError
          ? error.submitted.map((entry) => entry.signature)
          : [];
      const mapped = toConfidentialAppError(error);
      const message = mapped?.message ?? (error instanceof Error ? error.message : "Unknown error");

      await auditService.completeCritical(c, auditIntent, {
        status: "failure",
        metadata: { error: message, ...(landed.length > 0 ? { planSignatures: landed } : {}) },
      });
      await tokenService.updateTransaction(tx.id, {
        status: "failed",
        error: message,
        ...(landed.length > 0 ? { params: { ...params, planSignatures: landed } } : {}),
      });
      if (mapped) {
        throw mapped;
      }
    }
    throw error;
  }
}

/** Resolve the owner wallet + its token account for a holder-signed operation. */
async function resolveHolderTarget(
  c: AppContext,
  resolved: ResolvedToken,
  walletAddress: string
): Promise<{ owner: Address; tokenAccount: Address }> {
  const owner = assertValidAddress(walletAddress, "walletAddress");
  const tokenAccount = await resolveConfidentialTokenAccount(
    c.env,
    owner,
    resolved.mintAddress,
    "walletAddress"
  );
  return { owner, tokenAccount };
}

/** Run `use` with the holder's confidential keys, always releasing them afterwards. */
function withHolderKeys<T>(
  c: AppContext,
  resolved: ResolvedToken,
  owner: Address,
  walletId: string | null | undefined,
  use: (keys: ConfidentialKeys) => Promise<T>
): Promise<T> {
  return withConfidentialKeys(
    {
      env: c.env,
      organizationId: resolved.auth.organizationId,
      projectId: resolved.projectId,
      walletId,
      owner,
      mint: resolved.mintAddress,
    },
    use
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Handlers
// ═══════════════════════════════════════════════════════════════════════════

export const configureConfidentialAccount = async (
  c: ValidatedBodyContext<typeof confidentialAccountSchema>
) => {
  const { tokenId } = c.req.param();
  const body = c.req.valid("json");
  const resolved = await resolveConfidentialToken(c, tokenId);
  const { owner, tokenAccount } = await resolveHolderTarget(c, resolved, body.walletAddress);

  const transaction = await runConfidentialOperation({
    c,
    resolved,
    operation: "confidential_configure",
    signerAddress: owner,
    requestedCustodyWalletId: body.signingCustodyWalletId,
    params: { accountAddress: tokenAccount, walletAddress: owner },
    requestBody: body,
    run: (mosaic, walletId) =>
      withHolderKeys(c, resolved, owner, walletId, (keys) =>
        mosaic.configureConfidentialAccount({
          mint: resolved.mintAddress,
          owner,
          tokenAccount,
          keys,
          feePayer: owner,
        })
      ),
  });

  return success(c, { transaction });
};

export const approveConfidentialAccount = async (
  c: ValidatedBodyContext<typeof confidentialApproveSchema>
) => {
  const { tokenId } = c.req.param();
  const body = c.req.valid("json");
  const resolved = await resolveConfidentialToken(c, tokenId);

  const requestedAddress = assertValidAddress(body.accountAddress, "accountAddress");
  const tokenAccount = await resolveConfidentialTokenAccount(
    c.env,
    requestedAddress,
    resolved.mintAddress,
    "accountAddress"
  );

  const authority = await resolveCurrentAuthorityForRole(
    c.env,
    resolved.tokenService,
    resolved.token,
    "confidentialTransfer"
  );
  if (!authority) {
    throw badRequest("Confidential transfer authority is not available for this token");
  }

  const transaction = await runConfidentialOperation({
    c,
    resolved,
    operation: "confidential_approve",
    signerAddress: authority,
    requestedCustodyWalletId: body.signingCustodyWalletId,
    params: { accountAddress: tokenAccount, authority },
    requestBody: body,
    run: (mosaic) =>
      mosaic.approveConfidentialAccount({
        tokenAccount,
        mint: resolved.mintAddress,
        authority: assertValidAddress(authority, "authority"),
        feePayer: assertValidAddress(authority, "authority"),
      }),
  });

  return success(c, { transaction });
};

export const depositConfidential = async (
  c: ValidatedBodyContext<typeof confidentialAmountSchema>
) => {
  const { tokenId } = c.req.param();
  const body = c.req.valid("json");
  const resolved = await resolveConfidentialToken(c, tokenId);
  const { owner, tokenAccount } = await resolveHolderTarget(c, resolved, body.walletAddress);
  parsePositiveTokenAmount(body.amount, resolved.token.decimals);

  const transaction = await runConfidentialOperation({
    c,
    resolved,
    operation: "confidential_deposit",
    signerAddress: owner,
    requestedCustodyWalletId: body.signingCustodyWalletId,
    params: { accountAddress: tokenAccount, walletAddress: owner, amount: body.amount },
    requestBody: body,
    // Deposit needs no proof and therefore no keys: it moves a publicly visible
    // amount into the pending balance, which only the owner can later decrypt.
    run: (mosaic) =>
      mosaic.depositConfidential({
        tokenAccount,
        mint: resolved.mintAddress,
        amount: body.amount,
        owner,
        feePayer: owner,
      }),
  });

  return success(c, { transaction });
};

export const applyPendingConfidentialBalance = async (
  c: ValidatedBodyContext<typeof confidentialAccountSchema>
) => {
  const { tokenId } = c.req.param();
  const body = c.req.valid("json");
  const resolved = await resolveConfidentialToken(c, tokenId);
  const { owner, tokenAccount } = await resolveHolderTarget(c, resolved, body.walletAddress);

  const transaction = await runConfidentialOperation({
    c,
    resolved,
    operation: "confidential_apply_pending",
    signerAddress: owner,
    requestedCustodyWalletId: body.signingCustodyWalletId,
    params: { accountAddress: tokenAccount, walletAddress: owner },
    requestBody: body,
    run: (mosaic, walletId) =>
      withHolderKeys(c, resolved, owner, walletId, (keys) =>
        mosaic.applyPendingConfidentialBalance({ tokenAccount, owner, keys, feePayer: owner })
      ),
  });

  return success(c, { transaction });
};

export const confidentialTransfer = async (
  c: ValidatedBodyContext<typeof confidentialTransferSchema>
) => {
  const { tokenId } = c.req.param();
  const body = c.req.valid("json");
  const resolved = await resolveConfidentialToken(c, tokenId);
  const { owner, tokenAccount } = await resolveHolderTarget(c, resolved, body.walletAddress);
  parsePositiveTokenAmount(body.amount, resolved.token.decimals);

  const destination = await resolveConfidentialTokenAccount(
    c.env,
    assertValidAddress(body.destination, "destination"),
    resolved.mintAddress,
    "destination"
  );

  const transaction = await runConfidentialOperation({
    c,
    resolved,
    operation: "confidential_transfer",
    signerAddress: owner,
    requestedCustodyWalletId: body.signingCustodyWalletId,
    params: {
      source: tokenAccount,
      destination,
      walletAddress: owner,
      amount: body.amount,
    },
    requestBody: body,
    run: (mosaic, walletId) =>
      withHolderKeys(c, resolved, owner, walletId, (keys) =>
        mosaic.confidentialTransfer({
          mint: resolved.mintAddress,
          from: tokenAccount,
          to: destination,
          amount: body.amount,
          owner,
          keys,
          feePayer: owner,
        })
      ),
  });

  return success(c, { transaction });
};

export const withdrawConfidential = async (
  c: ValidatedBodyContext<typeof confidentialAmountSchema>
) => {
  const { tokenId } = c.req.param();
  const body = c.req.valid("json");
  const resolved = await resolveConfidentialToken(c, tokenId);
  const { owner, tokenAccount } = await resolveHolderTarget(c, resolved, body.walletAddress);
  parsePositiveTokenAmount(body.amount, resolved.token.decimals);

  const transaction = await runConfidentialOperation({
    c,
    resolved,
    operation: "confidential_withdraw",
    signerAddress: owner,
    requestedCustodyWalletId: body.signingCustodyWalletId,
    params: { accountAddress: tokenAccount, walletAddress: owner, amount: body.amount },
    requestBody: body,
    run: (mosaic, walletId) =>
      withHolderKeys(c, resolved, owner, walletId, (keys) =>
        mosaic.withdrawConfidential({
          tokenAccount,
          mint: resolved.mintAddress,
          amount: body.amount,
          owner,
          keys,
          feePayer: owner,
        })
      ),
  });

  return success(c, { transaction });
};

export const emptyConfidentialAccount = async (
  c: ValidatedBodyContext<typeof confidentialAccountSchema>
) => {
  const { tokenId } = c.req.param();
  const body = c.req.valid("json");
  const resolved = await resolveConfidentialToken(c, tokenId);
  const { owner, tokenAccount } = await resolveHolderTarget(c, resolved, body.walletAddress);

  const transaction = await runConfidentialOperation({
    c,
    resolved,
    operation: "confidential_empty_account",
    signerAddress: owner,
    requestedCustodyWalletId: body.signingCustodyWalletId,
    params: { accountAddress: tokenAccount, walletAddress: owner },
    requestBody: body,
    run: (mosaic, walletId) =>
      withHolderKeys(c, resolved, owner, walletId, (keys) =>
        mosaic.emptyConfidentialAccount({ tokenAccount, owner, keys, feePayer: owner })
      ),
  });

  return success(c, { transaction });
};

/**
 * Read and decrypt a confidential account's balances. No transaction, no audit
 * ceremony — modeled on `listFrozenAccounts`, not on an execute handler. Keys
 * are derived for the read and released immediately; only plaintext amounts
 * leave this function.
 */
export const getConfidentialBalance = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const resolved = await resolveConfidentialToken(c, tokenId);

  const query = confidentialBalanceQuerySchema.safeParse(c.req.query());
  if (!query.success) {
    throw badRequest("Invalid query parameters", { issues: query.error.issues });
  }
  const { owner, tokenAccount } = await resolveHolderTarget(c, resolved, query.data.walletAddress);

  // The read never signs, but decrypting needs the owner's keys — so the caller
  // must be authorized for the owner's custody wallet, and the derivation has to
  // run against that wallet rather than the org default.
  const { providerWalletId: walletId } = await resolveAuthorityWallet({
    env: c.env,
    auth: resolved.auth,
    requestedCustodyWalletId: query.data.signingCustodyWalletId,
    currentAuthority: owner,
    requiredWalletPermissions: ["tokens:read"],
  });
  const mosaic = createIssuanceMosaicService(c, createNoopSigner(owner), "sponsored");

  const balance = await withHolderKeys(c, resolved, owner, walletId, (keys) =>
    mosaic.getConfidentialBalance({
      tokenAccount,
      keys,
      decryptPendingBalance: query.data.decryptPendingBalance,
    })
  );

  if (!balance) {
    throw new AppError(
      "TOKEN_ACCOUNT_NOT_FOUND",
      "This token account is not configured for confidential transfers.",
      { field: "walletAddress", hint: "Run the confidential configure operation first." }
    );
  }

  return success(c, {
    confidentialBalance: {
      tokenAccount: balance.tokenAccount,
      walletAddress: owner,
      approved: balance.approved,
      availableBalance: balance.availableBalance?.toString() ?? null,
      pendingBalance: balance.pendingBalance?.toString() ?? null,
    },
  });
};
