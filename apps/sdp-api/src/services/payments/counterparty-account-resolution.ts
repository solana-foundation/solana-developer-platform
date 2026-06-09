import type { Address } from "@solana/kit";
import {
  createCounterpartiesRepository,
  createCounterpartyAccountsRepository,
} from "@/db/repositories";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import type { CounterpartyAccountRow } from "@/db/repositories/counterparty-account.repository";
import { AppError } from "@/lib/errors";
import { assertValidAddress } from "@/lib/solana";
import type { Env } from "@/types/env";

export interface ResolvedSolanaCounterpartyAccount {
  counterparty: CounterpartyRow;
  account: CounterpartyAccountRow;
  destinationAddress: Address;
}

function readSolanaCryptoWalletAddress(details: Record<string, unknown>): Address {
  if (details.network !== "solana" || typeof details.address !== "string") {
    throw new AppError(
      "BAD_REQUEST",
      'counterpartyAccountId must reference a crypto_wallet account with details.network = "solana" and details.address'
    );
  }

  return assertValidAddress(details.address, "details.address");
}

export async function resolveSolanaCounterpartyAccount(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  counterpartyId: string;
  counterpartyAccountId: string;
}): Promise<ResolvedSolanaCounterpartyAccount> {
  const counterparty = await createCounterpartiesRepository(input.env).getCounterpartyById({
    counterpartyId: input.counterpartyId,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (!counterparty) {
    throw new AppError("NOT_FOUND", "Counterparty not found");
  }
  if (counterparty.status !== "active") {
    throw new AppError(
      "BAD_REQUEST",
      "Counterparty must be active before creating a recurring payment"
    );
  }

  const account = await createCounterpartyAccountsRepository(input.env).getCounterpartyAccountById({
    counterpartyAccountId: input.counterpartyAccountId,
    counterpartyId: input.counterpartyId,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (!account) {
    throw new AppError("NOT_FOUND", "Counterparty account not found");
  }
  if (account.status !== "active") {
    throw new AppError(
      "BAD_REQUEST",
      "Counterparty account must be active before creating a recurring payment"
    );
  }
  if (account.account_kind !== "crypto_wallet") {
    throw new AppError(
      "BAD_REQUEST",
      "Recurring payments require a crypto_wallet counterparty account"
    );
  }

  return {
    counterparty,
    account,
    destinationAddress: readSolanaCryptoWalletAddress(account.details),
  };
}
