import { createClusterRpc } from "@sdp/rpc/factory";
import { assertValidAddress } from "@sdp/solana/address";
import type { Address } from "@solana/kit";
import type { CounterpartyAccountRow } from "@/db/repositories/counterparty-account.repository";
import { requireProjectId } from "@/lib/auth";
import { badRequest, internalError, notFound } from "@/lib/errors";
import { assertCallerMaySignWith } from "@/lib/money-admission";
import { type AppContext, getCounterpartyAccountsRepository } from "@/routes/payments/context";
import {
  type ResolvedScope,
  resolveScope,
  resolveWalletByCustodyWalletId,
} from "@/routes/payments/wallets";
import {
  assertPaymentProjectScope,
  assertPositivePaymentAmount,
  normalizePaymentToken,
  resolvePaymentAsset,
} from "@/services/payment-operation.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import { planTokenMovement } from "@/services/token-movement/build";
import type {
  CreateTransferBatchInput,
  ResolvedBatchRequest,
  TransferBatchRecipientInput,
} from "./types";

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

/** A recipient's destination and amount, before the batch is quoted. */
interface RecipientDestination {
  externalId: string | null;
  counterpartyId: string;
  counterpartyAccountId: string;
  destinationAddress: Address;
  amount: string;
}

/**
 * Resolves recipient inputs against the counterparty accounts `authorize`
 * loaded. An account archived since is refused here, as new work, never in
 * the access check.
 *
 * @param params.recipients - Recipient inputs from the request body.
 * @param params.accounts - The named accounts, by id, as authorize loaded them.
 * @returns Recipients with resolved destination addresses and their amounts.
 */
function resolveRecipientDestinations(params: {
  recipients: TransferBatchRecipientInput[];
  accounts: ReadonlyMap<string, CounterpartyAccountRow>;
}): RecipientDestination[] {
  return params.recipients.map((recipient, index) => {
    const account = params.accounts.get(recipient.counterpartyAccountId);
    if (account?.status !== "active") {
      throw notFound(`Counterparty account ${recipient.counterpartyAccountId}`);
    }

    return {
      externalId: recipient.externalId ?? null,
      counterpartyId: account.counterparty_id,
      counterpartyAccountId: recipient.counterpartyAccountId,
      destinationAddress: readCryptoWalletAddress(account, index),
      amount: assertPositivePaymentAmount(recipient.amount),
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
 * The access check for a batch (HOO-1918), for create and `/estimate`:
 * project scope, a source wallet the caller may sign with (in its scope, of a
 * purpose that may send), and every named counterparty account in the project
 * and under the counterparty the recipient names. Create runs it before the
 * Idempotency-Key is claimed, so a refused batch writes no failed recipients.
 * Status is state and is checked later, so a request that already ran is
 * still answered.
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
  assertCallerMaySignWith(scope.auth, sourceWallet, "payments.transfer_batch");

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
 * What a batch moves, resolved after its access check: one terms read for the
 * whole batch, and every recipient quoted on the debit and gated, so every
 * refusal is a 400 before the batch row exists. New work only; a replay never
 * reaches it.
 *
 * RPC budget: the mint read (with every recipient's token account, in pages
 * of 100) and the source accounts read, as the mint owner and source reads
 * before; for a hook mint, one more read for the whole batch.
 */
export async function resolveBatchMovement(
  input: CreateTransferBatchInput,
  authorized: AuthorizedBatchRequest
): Promise<ResolvedBatchRequest> {
  const destinations = resolveRecipientDestinations({
    recipients: input.recipients,
    accounts: authorized.accounts,
  });
  const plan = await planTokenMovement({
    asset: resolvePaymentAsset(input.token),
    basis: "debit",
    source: authorized.sourceAddress,
    destinations: destinations.map((destination) => ({
      owner: destination.destinationAddress,
      amount: destination.amount,
    })),
    memo: null,
  });
  return {
    scope: authorized.scope,
    projectId: authorized.projectId,
    sourceWallet: authorized.sourceWallet,
    sourceAddress: authorized.sourceAddress,
    token: normalizePaymentToken(input.token),
    plan,
    recipients: destinations.map((destination, index) => {
      const leg = plan.legs[index];
      if (leg === undefined) {
        throw internalError("A batch plan has one leg per recipient");
      }
      return {
        index,
        externalId: destination.externalId,
        counterpartyId: destination.counterpartyId,
        counterpartyAccountId: destination.counterpartyAccountId,
        destinationAddress: destination.destinationAddress,
        leg,
      };
    }),
    rpc: createClusterRpc(),
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
