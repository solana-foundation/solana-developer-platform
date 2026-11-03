import type { FireblocksVaultPage } from "@sdp/custody/provisioning/fireblocks-vaults";
import {
  BYOK_CUSTODY_PROVIDERS,
  CUSTODY_CONNECTION_CHECK_STATUSES,
  CUSTODY_CONNECTION_FAILURE_CODES,
  CUSTODY_CONNECTION_LIFECYCLES,
  CUSTODY_PROVIDERS,
  type CustodySetupStatusResponse,
  PROVIDER_CREDENTIAL_STATUSES,
  WALLET_FAUCET_STATUSES,
  type WalletFaucetResponse,
} from "@sdp/types/custody";
import { z } from "zod";
import type { FireblocksDestinationResult } from "@/services/custody/fireblocks-address-book.service";
import type { FireblocksCsr } from "@/services/custody/fireblocks-registration.service";
import type {
  ProviderCredentialCompletionResult,
  SafeInstallationConnection,
} from "@/services/provider-credential-installation.service";
import type {
  ProviderCredentialLifecycle,
  ProviderCredentialRotationResult,
} from "@/services/provider-credential-lifecycle.service";
import type { SafeProviderCredential } from "@/services/provider-credential-submission.service";

// These DTOs intentionally contain only safe metadata; unknown response fields
// must not turn a credential-management response into plaintext credential output.
export const safeCredentialSchema = z.strictObject({
  id: z.string(),
  provider: z.string(),
  label: z.string(),
  scope: z.enum(["organization", "project"]),
  projectId: z.string().nullable(),
  status: z.enum(PROVIDER_CREDENTIAL_STATUSES),
  createdAt: z.string(),
  displayMetadata: z.strictObject({
    appIdSuffix: z.string().optional(),
    apiKeySuffix: z.string().optional(),
    primaryVaultId: z.string().optional(),
  }),
}) satisfies z.ZodType<SafeProviderCredential>;
const completionSchema = z.strictObject({
  status: z.enum(CUSTODY_CONNECTION_CHECK_STATUSES),
  attemptedAt: z.string(),
  code: z.enum(CUSTODY_CONNECTION_FAILURE_CODES).optional(),
});
export const installationConnectionSchema = z.strictObject({
  id: z.string(),
  provider: z.enum(BYOK_CUSTODY_PROVIDERS),
  label: z.string(),
  status: z.enum(CUSTODY_CONNECTION_LIFECYCLES),
  completion: completionSchema.nullable(),
  walletLabel: z.string().optional(),
  canComplete: z.boolean(),
  canReplaceCredentials: z.boolean(),
  canCancel: z.boolean(),
}) satisfies z.ZodType<SafeInstallationConnection>;
export const custodyCompletionSchema = z.strictObject({
  providerCredential: safeCredentialSchema,
  connectionId: z.string(),
  completion: completionSchema,
}) satisfies z.ZodType<ProviderCredentialCompletionResult>;
export const custodySubmissionSchema = z.strictObject({
  providerCredential: safeCredentialSchema,
  connectionId: z.string(),
});
const lifecycleCredential = safeCredentialSchema.extend({ source: z.enum(["stored", "runtime"]) });
export const credentialLifecycleSchema = z.strictObject({
  providerCredential: lifecycleCredential,
  rotationCandidate: lifecycleCredential.nullable(),
  impact: z.strictObject({
    projects: z.array(z.strictObject({ id: z.string(), name: z.string() })),
    connections: z.array(
      z.strictObject({ id: z.string(), projectId: z.string(), status: z.string() })
    ),
  }),
  rollback: z
    .strictObject({ providerCredential: lifecycleCredential, expiresAt: z.string() })
    .nullable(),
}) satisfies z.ZodType<ProviderCredentialLifecycle>;
export const credentialRotationSchema = z.strictObject({
  providerCredential: safeCredentialSchema,
  rotation: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("success") }),
    z.strictObject({
      status: z.literal("failed"),
      code: z.enum(["invalid_credentials", "provider_account_mismatch"]),
    }),
    z.strictObject({
      status: z.literal("retry_unknown"),
      code: z.literal("provider_response_unknown"),
    }),
  ]),
}) satisfies z.ZodType<ProviderCredentialRotationResult>;
export const custodyConnectionsSchema = z.strictObject({
  connections: z.array(
    z.strictObject({
      id: z.string(),
      provider: z.enum(CUSTODY_PROVIDERS),
      label: z.string(),
      status: z.enum(CUSTODY_CONNECTION_LIFECYCLES),
      isRuntimeExecutionAllowed: z.boolean(),
      createdAt: z.string(),
      activatedAt: z.string().nullable(),
      pendingWalletLabel: z.string().nullable(),
      lastCheck: z
        .strictObject({
          status: z.enum(CUSTODY_CONNECTION_CHECK_STATUSES),
          at: z.string().nullable(),
          failureCode: z.enum(CUSTODY_CONNECTION_FAILURE_CODES).nullable(),
        })
        .nullable(),
    })
  ),
  pagination: z.strictObject({ limit: z.number(), offset: z.number(), total: z.number() }),
});
export const custodySetupProvidersSchema = z.strictObject({
  providers: z.array(
    z.strictObject({
      provider: z.enum(CUSTODY_PROVIDERS),
      hasLegacyConfig: z.boolean(),
      effectiveTargetType: z.enum(["none", "config", "connection"]),
      connectionCounts: z.strictObject({
        pending: z.number(),
        checking: z.number(),
        active: z.number(),
        failed: z.number(),
        deactivated: z.number(),
      }),
    })
  ),
}) satisfies z.ZodType<CustodySetupStatusResponse>;
export const fireblocksCsrSchema = z.strictObject({
  id: z.string(),
  csrPem: z.string(),
  expiresAt: z.string(),
}) satisfies z.ZodType<FireblocksCsr>;
export const fireblocksVaultPageSchema = z.strictObject({
  vaults: z.array(
    z.strictObject({ id: z.string(), name: z.string(), hasSolanaWallet: z.boolean() })
  ),
  nextCursor: z.string().nullable(),
}) satisfies z.ZodType<FireblocksVaultPage>;
export const walletFaucetResponseSchema = z.strictObject({
  signature: z.string(),
  status: z.enum(WALLET_FAUCET_STATUSES),
  lamports: z.string(),
}) satisfies z.ZodType<WalletFaucetResponse>;
export const fireblocksDestinationSchema = z.strictObject({
  state: z.enum(["approved", "pending", "not_whitelisted"]),
  assetId: z.string(),
}) satisfies z.ZodType<FireblocksDestinationResult>;
