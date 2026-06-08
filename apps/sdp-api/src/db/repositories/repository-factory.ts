import { getDb } from "@/db";
import type { Env } from "@/types/env";
import type { CounterpartiesRepository } from "./counterparty.repository";
import { createPostgresCounterpartiesRepository } from "./counterparty.repository.postgres";
import type { CounterpartyAccountsRepository } from "./counterparty-account.repository";
import { createPostgresCounterpartyAccountsRepository } from "./counterparty-account.repository.postgres";
import type { PaymentRecurringPaymentsRepository } from "./payment-recurring-payments.repository";
import { createPostgresPaymentRecurringPaymentsRepository } from "./payment-recurring-payments.repository.postgres";
import type { PaymentSubscriptionsRepository } from "./payment-subscriptions.repository";
import { createPostgresPaymentSubscriptionsRepository } from "./payment-subscriptions.repository.postgres";
import type { PaymentsRepository } from "./payments.repository";
import { createPostgresPaymentsRepository } from "./payments.repository.postgres";
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

export function createCounterpartiesRepository(env: Env): CounterpartiesRepository {
  return createPostgresCounterpartiesRepository(getDb(env));
}

export function createCounterpartyAccountsRepository(env: Env): CounterpartyAccountsRepository {
  return createPostgresCounterpartyAccountsRepository(getDb(env));
}

export function createTokenRepository(env: Env): TokenRepository {
  return createPostgresTokenRepository(getDb(env));
}
