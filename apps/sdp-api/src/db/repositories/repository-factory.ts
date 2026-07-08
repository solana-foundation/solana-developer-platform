import { getDb } from "@/db";
import type { Env } from "@/types/env";
import type { AssetProfilesRepository } from "./asset-profile.repository";
import { createPostgresAssetProfilesRepository } from "./asset-profile.repository.postgres";
import type { CounterpartiesRepository } from "./counterparty.repository";
import { createPostgresCounterpartiesRepository } from "./counterparty.repository.postgres";
import type { CounterpartyAccountsRepository } from "./counterparty-account.repository";
import { createPostgresCounterpartyAccountsRepository } from "./counterparty-account.repository.postgres";
import type { PaymentRecurringPaymentsRepository } from "./payment-recurring-payments.repository";
import { createPostgresPaymentRecurringPaymentsRepository } from "./payment-recurring-payments.repository.postgres";
import type { PaymentRequestsRepository } from "./payment-requests.repository";
import { createPostgresPaymentRequestsRepository } from "./payment-requests.repository.postgres";
import type { PaymentSubscriptionsRepository } from "./payment-subscriptions.repository";
import { createPostgresPaymentSubscriptionsRepository } from "./payment-subscriptions.repository.postgres";
import type { PaymentTransferBatchesRepository } from "./payment-transfer-batches.repository";
import { createPostgresPaymentTransferBatchesRepository } from "./payment-transfer-batches.repository.postgres";
import type { PaymentsRepository } from "./payments.repository";
import { createPostgresPaymentsRepository } from "./payments.repository.postgres";
import type { PolicyRepository } from "./policy.repository";
import { createPostgresPolicyRepository } from "./policy.repository.postgres";
import type { TokenRepository } from "./token.repository";
import { createPostgresTokenRepository } from "./token.repository.postgres";

export function createPaymentsRepository(env: Env): PaymentsRepository {
  return createPostgresPaymentsRepository(getDb(env));
}

export function createPaymentSubscriptionsRepository(env: Env): PaymentSubscriptionsRepository {
  return createPostgresPaymentSubscriptionsRepository(getDb(env));
}

export function createPaymentRecurringPaymentsRepository(
  env: Env
): PaymentRecurringPaymentsRepository {
  return createPostgresPaymentRecurringPaymentsRepository(getDb(env));
}

export function createPaymentRequestsRepository(env: Env): PaymentRequestsRepository {
  return createPostgresPaymentRequestsRepository(getDb(env));
}

export function createPaymentTransferBatchesRepository(env: Env): PaymentTransferBatchesRepository {
  return createPostgresPaymentTransferBatchesRepository(getDb(env));
}

export function createCounterpartiesRepository(env: Env): CounterpartiesRepository {
  return createPostgresCounterpartiesRepository(getDb(env));
}

export function createCounterpartyAccountsRepository(env: Env): CounterpartyAccountsRepository {
  return createPostgresCounterpartyAccountsRepository(getDb(env));
}

export function createTokenRepository(env: Env): TokenRepository {
  return createPostgresTokenRepository(getDb(env));
}

export function createPolicyRepository(env: Env): PolicyRepository {
  return createPostgresPolicyRepository(getDb(env));
}

export function createAssetProfilesRepository(env: Env): AssetProfilesRepository {
  return createPostgresAssetProfilesRepository(getDb(env));
}
