import { sumDecimalAmounts } from "@sdp/payments/decimal";
import * as solanaRpc from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { AmountError, formatDecimalAmount, parseDecimalAmount } from "@sdp/solana/amount";
import { WELL_KNOWN_TOKENS } from "@sdp/types";
import type { Address } from "@solana/kit";
import type { CounterpartyAccountRow } from "@/db/repositories/counterparty-account.repository";
import { requireProjectId } from "@/lib/auth";
import { badRequest, notFound } from "@/lib/errors";
import { assertApiKeyWalletAccess } from "@/services/api-key-scope.service";
import {
  assertPaymentProjectScope,
  assertPositivePaymentAmount,
  normalizePaymentToken,
} from "@/services/payment-operation.service";
import { type AppContext, getCounterpartyAccountsRepository } from "../../context";
import { resolveMintTokenProgram, resolveSourceTokenAccount } from "../../token-accounts";
import { resolveScope, resolveWallet } from "../../wallets";
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
  if (token === "SOL") {
    return { kind: "sol", token: "SOL", decimals: WELL_KNOWN_TOKENS.SOL.decimals };
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
 * Resolves recipient inputs against their counterparty accounts in one
 * batched lookup, validating ownership and normalizing amounts.
 *
 * @param params.recipients - Recipient inputs from the request body.
 * @param params.decimals - Decimal places of the batch token.
 * @returns Recipients with resolved destination addresses and base-unit amounts.
 */
async function resolveRecipients(params: {
  c: AppContext;
  organizationId: string;
  projectId: string;
  recipients: TransferBatchRecipientInput[];
  decimals: number;
}): Promise<ResolvedRecipient[]> {
  const accountsRepository = getCounterpartyAccountsRepository(params.c);

  const accounts = await accountsRepository.listCounterpartyAccountsByIdsInProject({
    counterpartyAccountIds: [...new Set(params.recipients.map((r) => r.counterpartyAccountId))],
    organizationId: params.organizationId,
    projectId: params.projectId,
  });
  const accountById = new Map(accounts.map((account) => [account.id, account]));

  return params.recipients.map((recipient, index) => {
    const account = accountById.get(recipient.counterpartyAccountId);
    if (!account) {
      throw notFound(`Counterparty account ${recipient.counterpartyAccountId}`);
    }
    if (recipient.counterpartyId && account.counterparty_id !== recipient.counterpartyId) {
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

/**
 * Resolves and authorizes a transfer-batch request: project scope, source
 * wallet access, token context, and all recipients.
 *
 * @param c - Request context.
 * @param input - Parsed create/estimate request body.
 * @param requiredWalletPermissions - Permissions the API key must hold on the source wallet.
 * @returns Everything the estimate and create paths need to build transactions.
 */
export async function resolveBatchRequest(
  c: AppContext,
  input: CreateTransferBatchInput,
  requiredWalletPermissions: Parameters<typeof assertApiKeyWalletAccess>[2]
): Promise<ResolvedBatchRequest> {
  const projectId = requireProjectId(c);
  const scope = await resolveScope(c);
  assertPaymentProjectScope(input.projectId, scope.auth.projectId);

  const sourceWallet = resolveWallet(scope.wallets, input.source);
  assertApiKeyWalletAccess(scope.auth, sourceWallet.walletId, requiredWalletPermissions);

  const sourceAddress = assertValidAddress(sourceWallet.publicKey, "source");
  const token = normalizePaymentToken(input.token, c.env);
  const rpc = solanaRpc.createRpc(c.env);
  const tokenContext = await resolveTokenContext(rpc, token, sourceAddress);
  const recipients = await resolveRecipients({
    c,
    organizationId: scope.auth.organizationId,
    projectId,
    recipients: input.recipients,
    decimals: tokenContext.decimals,
  });
  return {
    scope,
    projectId,
    sourceWallet,
    sourceAddress,
    tokenContext,
    recipients,
    totalAmount: sumDecimalAmounts(recipients.map((recipient) => recipient.amount)),
    rpc,
  };
}
