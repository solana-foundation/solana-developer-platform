import { getDb } from "@/db";
import { createPiiCipher, type PiiCipher } from "@/services/pii-cipher/pii-cipher";
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
import type { PrivateChannelRepository } from "./private-channel.repository";
import { createPostgresPrivateChannelRepository } from "./private-channel.repository.postgres";
import type { PrivateChannelDepositRepository } from "./private-channel-deposit.repository";
import { createPostgresPrivateChannelDepositRepository } from "./private-channel-deposit.repository.postgres";
import type { PrivateChannelEventRepository } from "./private-channel-event.repository";
import { createPostgresPrivateChannelEventRepository } from "./private-channel-event.repository.postgres";
import type { PrivateChannelInstanceRepository } from "./private-channel-instance.repository";
import { createPostgresPrivateChannelInstanceRepository } from "./private-channel-instance.repository.postgres";
import type { PrivateChannelSettlementObservationRepository } from "./private-channel-settlement-observation.repository";
import { createPostgresPrivateChannelSettlementObservationRepository } from "./private-channel-settlement-observation.repository.postgres";
import type { PrivateChannelTransferRepository } from "./private-channel-transfer.repository";
import { createPostgresPrivateChannelTransferRepository } from "./private-channel-transfer.repository.postgres";
import type { PrivateChannelUserRepository } from "./private-channel-user.repository";
import { createPostgresPrivateChannelUserRepository } from "./private-channel-user.repository.postgres";
import type { PrivateChannelVerifiedWalletRepository } from "./private-channel-verified-wallet.repository";
import { createPostgresPrivateChannelVerifiedWalletRepository } from "./private-channel-verified-wallet.repository.postgres";
import type { PrivateChannelWithdrawalRepository } from "./private-channel-withdrawal.repository";
import { createPostgresPrivateChannelWithdrawalRepository } from "./private-channel-withdrawal.repository.postgres";
import type { ProjectUserRepository } from "./project-user.repository";
import { createPostgresProjectUserRepository } from "./project-user.repository.postgres";
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
  const testCipher = (env as Env & { counterpartyPiiCipher?: PiiCipher }).counterpartyPiiCipher;
  return createPostgresCounterpartiesRepository(getDb(env), testCipher ?? createPiiCipher(env));
}

export function createCounterpartyAccountsRepository(env: Env): CounterpartyAccountsRepository {
  const testCipher = (env as Env & { counterpartyPiiCipher?: PiiCipher }).counterpartyPiiCipher;
  return createPostgresCounterpartyAccountsRepository(
    getDb(env),
    testCipher ?? createPiiCipher(env)
  );
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

export function createPrivateChannelInstanceRepository(env: Env): PrivateChannelInstanceRepository {
  return createPostgresPrivateChannelInstanceRepository(getDb(env));
}

export function createPrivateChannelRepository(env: Env): PrivateChannelRepository {
  return createPostgresPrivateChannelRepository(getDb(env));
}

export function createPrivateChannelTransferRepository(env: Env): PrivateChannelTransferRepository {
  return createPostgresPrivateChannelTransferRepository(getDb(env));
}

export function createPrivateChannelDepositRepository(env: Env): PrivateChannelDepositRepository {
  return createPostgresPrivateChannelDepositRepository(getDb(env));
}

export function createPrivateChannelVerifiedWalletRepository(
  env: Env
): PrivateChannelVerifiedWalletRepository {
  return createPostgresPrivateChannelVerifiedWalletRepository(getDb(env));
}

export function createPrivateChannelEventRepository(env: Env): PrivateChannelEventRepository {
  return createPostgresPrivateChannelEventRepository(getDb(env));
}

export function createPrivateChannelUserRepository(env: Env): PrivateChannelUserRepository {
  return createPostgresPrivateChannelUserRepository(getDb(env));
}

export function createPrivateChannelWithdrawalRepository(
  env: Env
): PrivateChannelWithdrawalRepository {
  return createPostgresPrivateChannelWithdrawalRepository(getDb(env));
}

export function createPrivateChannelSettlementObservationRepository(
  env: Env
): PrivateChannelSettlementObservationRepository {
  return createPostgresPrivateChannelSettlementObservationRepository(getDb(env));
}

export function createProjectUserRepository(env: Env): ProjectUserRepository {
  return createPostgresProjectUserRepository(getDb(env));
}
