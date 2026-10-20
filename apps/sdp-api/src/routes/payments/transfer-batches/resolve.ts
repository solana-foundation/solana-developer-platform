import { sumDecimalAmounts } from "@sdp/payments/decimal";
import { createClusterRpc } from "@sdp/rpc/factory";
import { assertValidAddress } from "@sdp/solana/address";
import { AmountError, formatDecimalAmount, parseDecimalAmount } from "@sdp/solana/amount";
import { SOL_DECIMALS, SOL_MINT } from "@sdp/types/well-known-tokens";
import type { Address } from "@solana/kit";
import type { CounterpartyAccountRow } from "@/db/repositories/counterparty-account.repository";
import { requireProjectId } from "@/lib/auth";
import { badRequest, notFound } from "@/lib/errors";
import { type AppContext, getCounterpartyAccountsRepository } from "@/routes/payments/context";
import {
  resolveMintTokenProgram,
  resolveSourceTokenAccount,
} from "@/routes/payments/token-accounts";
import {
  type ResolvedScope,
  resolveScope,
  resolveWalletByCustodyWalletId,
} from "@/routes/payments/wallets";
import {
  assertPaymentProjectScope,
  assertPositivePaymentAmount,
  isNativePaymentToken,
  normalizePaymentToken,
} from "@/services/payment-operation.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type {
  CreateTransferBatchInput,
  ResolvedBatchRequest,
  ResolvedRecipient,
  Rpc,
  TokenContext,
  TransferBatchRecipientInput,
} from "./types";

/**
 * Parses a recipient amount into token base units, mapping amount-format
 * violations to a 400 response.
 *
 * @param amount - Decimal amount string from the request body.
 * @param decimals - Decimal places of the batch token.
 * @returns The amount in token base units.
 */
function parseRecipientAmount(amount: string, decimals: number): bigint {
  try {
    return parseDecimalAmount(assertPositivePaymentAmount(amount), decimals);
  } catch (error) {
    if (error instanceof AmountError) {
      throw badRequest(error.message);
    }
    throw error;
  }
}

/**
 * Resolves the batch token into transfer parameters: native SOL, or an SPL
 * mint with its token program and the source wallet's token account.
 *
 * @param rpc - Solana RPC client.
 * @param token - "SOL" or an SPL mint address.
 * @param sourceAddress - Source wallet address holding the token.
 * @returns The token context used to build transfer instructions.
 */
async function resolveTokenContext(
  rpc: Rpc,
  token: string,
  sourceAddress: Address
): Promise<TokenContext> {
  if (isNativePaymentToken(token)) {
    return { kind: "sol", token: SOL_MINT, decimals: SOL_DECIMALS };
  }

  const mintAddress = assertValidAddress(token, "token");
  const tokenProgram = await resolveMintTokenProgram(rpc, mintAddress);
  const sourceTokenAccount = await resolveSourceTokenAccount(
    rpc,
    sourceAddress,
    mintAddress,
    tokenProgram
  );

  return {
    kind: "spl",
    token,
    decimals: sourceTokenAccount.decimals,
    mintAddress,
    tokenProgram,
    sourceTokenAccount: sourceTokenAccount.tokenAccount,
  };
}

/**
 * Reads the Solana wallet address off a counterparty account, rejecting
 * non-crypto and non-Solana accounts with a 400 response.
 *
 * @param account - Counterparty account row referenced by the recipient.
 * @param index - Recipient index, used in error messages.
 * @returns The validated destination address.
 */
function readCryptoWalletAddress(account: CounterpartyAccountRow, index: number): Address {
  if (account.account_kind !== "crypto_wallet") {
    throw badRequest(`recipients.${index}.counterpartyAccountId must be a crypto wallet account`);
  }

  const { network, address } = account.details;
  if (network !== "solana") {
    throw badRequest(`recipients.${index}.counterpartyAccountId must be a Solana wallet account`);
  }
  if (typeof address !== "string") {
    throw badRequest(`recipients.${index}.counterpartyAccountId is missing a wallet address`);
  }

  return assertValidAddress(address, `recipients.${index}.counterpartyAccountId`);
}

/**
 * Resolves recipient inputs against the counterparty accounts `authorize`
 * loaded, normalizing amounts. An account archived since is refused here, as
 * new work, never in the access check.
 *
 * @param params.recipients - Recipient inputs from the request body.
 * @param params.accounts - The named accounts, by id, as authorize loaded them.
 * @param params.decimals - Decimal places of the batch token.
 * @returns Recipients with resolved destination addresses and base-unit amounts.
 */
function resolveRecipients(params: {
  recipients: TransferBatchRecipientInput[];
  accounts: ReadonlyMap<string, CounterpartyAccountRow>;
  decimals: number;
}): ResolvedRecipient[] {
  return params.recipients.map((recipient, index) => {
    const account = params.accounts.get(recipient.counterpartyAccountId);
    if (account?.status !== "active") {
      throw notFound(`Counterparty account ${recipient.counterpartyAccountId}`);
    }

    const amountBaseUnits = parseRecipientAmount(recipient.amount, params.decimals);
    return {
      index,
      externalId: recipient.externalId ?? null,
      counterpartyId: account.counterparty_id,
      counterpartyAccountId: recipient.counterpartyAccountId,
      destinationAddress: readCryptoWalletAddress(account, index),
      amount: formatDecimalAmount(amountBaseUnits, params.decimals),
      amountBaseUnits,
    };
  });
}

/** What a batch's access check loads: no RPC, no state checks. */
export interface AuthorizedBatchRequest {
  scope: ResolvedScope;
  projectId: string;
  sourceWallet: CustodyWallet;
  sourceAddress: Address;
  /** Every account the recipients name, whatever its status. */
  accounts: ReadonlyMap<string, CounterpartyAccountRow>;
}

/**
 * The access check for a batch (HOO-1918): project scope and every named
 * counterparty account in the project and under the counterparty the
 * recipient names. Whether the caller may sign with the source wallet is the
 * custody signer's decision (HOO-2099). Status is state and
 * is checked later, so a request that already ran is still answered.
 *
 * @param retainedCustodyWalletId - Resolve this wallet even when inactive, so a replay of a request that ran is answered.
 */
export async function authorizeBatchRequest(
  c: AppContext,
  input: CreateTransferBatchInput,
  retainedCustodyWalletId?: string
): Promise<AuthorizedBatchRequest> {
  const projectId = requireProjectId(c);
  const scope = await resolveScope(c, retainedCustodyWalletId);
  assertPaymentProjectScope(input.projectId, projectId);

  const sourceWallet = resolveWalletByCustodyWalletId(scope.wallets, input.sourceCustodyWalletId);

  const sourceAddress = assertValidAddress(sourceWallet.publicKey, "source");

  const rows = await getCounterpartyAccountsRepository(c).listCounterpartyAccountsByIdsInProject({
    counterpartyAccountIds: [...new Set(input.recipients.map((r) => r.counterpartyAccountId))],
    organizationId: scope.auth.organizationId,
    projectId,
    status: "any",
  });
  const accounts = new Map(rows.map((account) => [account.id, account]));
  for (const recipient of input.recipients) {
    const account = accounts.get(recipient.counterpartyAccountId);
    if (
      !account ||
      (recipient.counterpartyId && account.counterparty_id !== recipient.counterpartyId)
    ) {
      throw notFound(`Counterparty account ${recipient.counterpartyAccountId}`);
    }
  }
  return { scope, projectId, sourceWallet, sourceAddress, accounts };
}

/**
 * What a batch moves, resolved after its access check: the token context (RPC)
 * and each recipient's destination and amount. New work only; a replay never
 * reaches it.
 */
export async function resolveBatchMovement(
  input: CreateTransferBatchInput,
  authorized: AuthorizedBatchRequest
): Promise<ResolvedBatchRequest> {
  const token = normalizePaymentToken(input.token);
  const rpc = createClusterRpc();
  const tokenContext = await resolveTokenContext(rpc, token, authorized.sourceAddress);
  const recipients = resolveRecipients({
    recipients: input.recipients,
    accounts: authorized.accounts,
    decimals: tokenContext.decimals,
  });
  return {
    scope: authorized.scope,
    projectId: authorized.projectId,
    sourceWallet: authorized.sourceWallet,
    sourceAddress: authorized.sourceAddress,
    tokenContext,
    recipients,
    totalAmount: sumDecimalAmounts(recipients.map((recipient) => recipient.amount)),
    rpc,
  };
}

/**
 * Resolves and authorizes a transfer-batch request in one go, for the estimate.
 *
 * @param c - Request context.
 * @param input - Parsed create/estimate request body.
 * @returns Everything the estimate path needs to build transactions.
 */
export async function resolveBatchRequest(
  c: AppContext,
  input: CreateTransferBatchInput
): Promise<ResolvedBatchRequest> {
  return resolveBatchMovement(input, await authorizeBatchRequest(c, input));
}
