// biome-ignore-all lint/security/noSecrets: repository and method identifiers are not credentials
import { getDb } from "@/db";
import { bindRepositoryToTenant, type TenantScope } from "@/lib/tenant-scope";
import { createPiiCipher, type PiiCipher } from "@/services/pii-cipher/pii-cipher";
import type { Env } from "@/types/env";
import type { AssetProfilesRepository } from "./asset-profile.repository";
import { createPostgresAssetProfilesRepository } from "./asset-profile.repository.postgres";
import type { AssetWorkflowsRepository } from "./asset-workflow.repository";
import { createPostgresAssetWorkflowsRepository } from "./asset-workflow.repository.postgres";
import type { CounterpartiesRepository } from "./counterparty.repository";
import { createPostgresCounterpartiesRepository } from "./counterparty.repository.postgres";
import type { CounterpartyAccountsRepository } from "./counterparty-account.repository";
import { createPostgresCounterpartyAccountsRepository } from "./counterparty-account.repository.postgres";
import type { EarnRepository } from "./earn.repository";
import { createPostgresEarnRepository } from "./earn.repository.postgres";
import type { KycWalletsRepository } from "./kyc-wallet.repository";
import { createPostgresKycWalletsRepository } from "./kyc-wallet.repository.postgres";
import type { NotificationsRepository } from "./notification.repository";
import { createPostgresNotificationsRepository } from "./notification.repository.postgres";
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
import type { PrivateChannelReferenceRepository } from "./private-channel-reference.repository";
import { createPostgresPrivateChannelReferenceRepository } from "./private-channel-reference.repository.postgres";
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
import type { WalletAssetEnrollmentsRepository } from "./wallet-asset-enrollment.repository";
import { createPostgresWalletAssetEnrollmentsRepository } from "./wallet-asset-enrollment.repository.postgres";
import type { WorkflowExecutionsRepository } from "./workflow-execution.repository";
import { createPostgresWorkflowExecutionsRepository } from "./workflow-execution.repository.postgres";
import type { WorkflowSecretRetirementsRepository } from "./workflow-secret-retirement.repository";
import { createPostgresWorkflowSecretRetirementsRepository } from "./workflow-secret-retirement.repository.postgres";

export function createPaymentsRepository(env: Env, scope: TenantScope): PaymentsRepository {
  return bindRepositoryToTenant(
    createPostgresPaymentsRepository(getDb(env), scope),
    scope,
    "PaymentsRepository",
    ["listTransfersByStatus"]
  );
}

export function createSystemPaymentsRepository(env: Env): PaymentsRepository {
  return createPostgresPaymentsRepository(getDb(env));
}

export function createPaymentSubscriptionsRepository(
  env: Env,
  scope: TenantScope
): PaymentSubscriptionsRepository {
  return bindRepositoryToTenant(
    createPostgresPaymentSubscriptionsRepository(getDb(env)),
    scope,
    "PaymentSubscriptionsRepository"
  );
}

export function createPaymentRecurringPaymentsRepository(
  env: Env,
  scope: TenantScope
): PaymentRecurringPaymentsRepository {
  return bindRepositoryToTenant(
    createPostgresPaymentRecurringPaymentsRepository(getDb(env)),
    scope,
    "PaymentRecurringPaymentsRepository"
  );
}

export function createPaymentRequestsRepository(
  env: Env,
  scope: TenantScope
): PaymentRequestsRepository {
  return bindRepositoryToTenant(
    createPostgresPaymentRequestsRepository(getDb(env)),
    scope,
    "PaymentRequestsRepository",
    ["getPaymentRequestByPublicToken"]
  );
}

export function createSystemPaymentRequestsRepository(env: Env): PaymentRequestsRepository {
  return createPostgresPaymentRequestsRepository(getDb(env));
}

export function createPaymentTransferBatchesRepository(
  env: Env,
  scope: TenantScope
): PaymentTransferBatchesRepository {
  return bindRepositoryToTenant(
    createPostgresPaymentTransferBatchesRepository(getDb(env)),
    scope,
    "PaymentTransferBatchesRepository",
    ["settleTransferBatch"]
  );
}

export function createSystemPaymentTransferBatchesRepository(
  env: Env
): PaymentTransferBatchesRepository {
  return createPostgresPaymentTransferBatchesRepository(getDb(env));
}

export function createCounterpartiesRepository(
  env: Env,
  scope: TenantScope
): CounterpartiesRepository {
  const testCipher = (env as Env & { counterpartyPiiCipher?: PiiCipher }).counterpartyPiiCipher;
  return bindRepositoryToTenant(
    createPostgresCounterpartiesRepository(getDb(env), testCipher ?? createPiiCipher(env)),
    scope,
    "CounterpartiesRepository",
    [
      "findActiveCounterpartyById",
      "findActiveCounterpartyByBvnkCustomerReference",
      "findCounterpartyByMuralOrganizationId",
      "patchMuralOrganizationById",
    ]
  );
}

export function createSystemCounterpartiesRepository(env: Env): CounterpartiesRepository {
  const testCipher = (env as Env & { counterpartyPiiCipher?: PiiCipher }).counterpartyPiiCipher;
  return createPostgresCounterpartiesRepository(getDb(env), testCipher ?? createPiiCipher(env));
}

export function createCounterpartyAccountsRepository(
  env: Env,
  scope: TenantScope
): CounterpartyAccountsRepository {
  const testCipher = (env as Env & { counterpartyPiiCipher?: PiiCipher }).counterpartyPiiCipher;
  return bindRepositoryToTenant(
    createPostgresCounterpartyAccountsRepository(getDb(env), testCipher ?? createPiiCipher(env)),
    scope,
    "CounterpartyAccountsRepository"
  );
}

export function createTokenRepository(env: Env, scope: TenantScope): TokenRepository {
  return createPostgresTokenRepository(getDb(env), scope);
}

export function createPolicyRepository(env: Env, scope: TenantScope): PolicyRepository {
  return createPostgresPolicyRepository(getDb(env), scope);
}

export function createAssetProfilesRepository(
  env: Env,
  scope: TenantScope
): AssetProfilesRepository {
  return bindRepositoryToTenant(
    createPostgresAssetProfilesRepository(getDb(env)),
    scope,
    "AssetProfilesRepository",
    ["getPublicMetadataByTokenId"]
  );
}

export function createSystemAssetProfilesRepository(env: Env): AssetProfilesRepository {
  return createPostgresAssetProfilesRepository(getDb(env));
}

export function createKycWalletsRepository(env: Env): KycWalletsRepository {
  return createPostgresKycWalletsRepository(getDb(env));
}

export function createWalletAssetEnrollmentsRepository(env: Env): WalletAssetEnrollmentsRepository {
  return createPostgresWalletAssetEnrollmentsRepository(getDb(env));
}

export function createAssetWorkflowsRepository(env: Env): AssetWorkflowsRepository {
  return createPostgresAssetWorkflowsRepository(getDb(env));
}

export function createWorkflowExecutionsRepository(env: Env): WorkflowExecutionsRepository {
  return createPostgresWorkflowExecutionsRepository(getDb(env));
}

export function createWorkflowSecretRetirementsRepository(
  env: Env
): WorkflowSecretRetirementsRepository {
  return createPostgresWorkflowSecretRetirementsRepository(getDb(env));
}

export function createNotificationsRepository(env: Env): NotificationsRepository {
  return createPostgresNotificationsRepository(getDb(env));
}

export function createEarnRepository(env: Env): EarnRepository {
  return createPostgresEarnRepository(getDb(env));
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

export function createPrivateChannelReferenceRepository(
  env: Env
): PrivateChannelReferenceRepository {
  return createPostgresPrivateChannelReferenceRepository(getDb(env));
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
