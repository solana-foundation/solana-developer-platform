import { notImplemented, providerNotConfigured } from "@sdp/earn/errors";
import type { EarnRuntimeContext } from "@sdp/earn/types";
import type { SdpEnvironment } from "@sdp/types";
import { address } from "@solana/kit";
import { getDb } from "@/db";
import {
  createPostgresEarnVaultRepository,
  type EarnVaultMovementRow,
  type EarnVaultPositionRow,
} from "@/db/repositories/earn-vault.repository";
import { badRequest } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import * as solanaServices from "@/services/solana";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import {
  earnClusterFor,
  resolveClusterRpcUrl,
  resolveVaultDirectClient,
} from "./execution-registry";
import { simulateVaultPlan, submitVaultPlan, type VaultFeeMode } from "./vault-execution.service";

/**
 * Deposit into a non-custodial vault from an SDP custody wallet.
 *
 * Order of operations is the point, and it mirrors
 * `services/private-channels/deposit.ts`:
 *
 *   1. write the intent row (idempotency anchor) BEFORE anything is signed
 *   2. build the plan from the provider
 *   3. simulate — a third-party SDK assembled these accounts against live state
 *   4. sign with custody and submit
 *   5. advance the ledger by guarded CAS
 *
 * Step 1 first is not bookkeeping pedantry: the chain has no request-id dedupe,
 * so if the process dies between signing and recording, the row written here is
 * the only evidence the transfer happened.
 */

export interface VaultDepositInput {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  provider: string;
  /** Vault address — the strategy's providerReference. */
  providerReference: string;
  wallet: CustodyWallet;
  /** Decimal string in the vault token's units. */
  amount: string;
  /** Caller idempotency key. REQUIRED — see the migration header. */
  requestId: string;
  userId?: string | null;
  apiKeyId?: string | null;
  /** Slippage floor, decimal string. */
  minSharesOut?: string;
}

export interface VaultDepositResult {
  position: EarnVaultPositionRow;
  movement: EarnVaultMovementRow;
  /** True when the idempotency key had already been used — nothing was re-sent. */
  replayed: boolean;
}

export async function depositIntoVault(
  env: Env,
  input: VaultDepositInput
): Promise<VaultDepositResult> {
  const client = resolveVaultDirectClient(env, input.provider);
  if (!client) {
    // Same taxonomy the earn routes already raise, so the existing error
    // handler maps it to a clean 501 rather than a generic 500.
    throw notImplemented(input.provider as never, "direct vault deposits");
  }

  const cluster = earnClusterFor(input.environment);
  const rpcUrl = resolveClusterRpcUrl(env, cluster);
  if (!rpcUrl) {
    throw providerNotConfigured(
      `No Solana RPC endpoint is configured, so a ${cluster} vault deposit cannot be built.`
    );
  }

  const repo = createPostgresEarnVaultRepository(getDb(env));
  const runtime: EarnRuntimeContext = {
    env: env as unknown as Record<string, string | undefined>,
    environment: input.environment,
  };

  // 1. Claim the position and write the intent row.
  //
  // NOTE the two different wallet identifiers, which are easy to confuse and
  // fail in different ways: `wallet.id` is the SDP row (`cwlt_…`) and is what
  // the FK on both tables points at, while `wallet.walletId` is the PROVIDER's
  // own id (`privy_…`) and is what the signing service resolves an adapter by.
  // Swapping them yields a foreign-key violation here and a "wallet not found"
  // at signing time.
  const position = await repo.claimPosition({
    organizationId: input.organizationId,
    projectId: input.projectId,
    environment: input.environment,
    provider: input.provider,
    providerReference: input.providerReference,
    custodyWalletId: input.wallet.id,
    createdBy: input.userId ?? null,
  });

  const { row: movement, replayed } = await repo.createMovement({
    organizationId: input.organizationId,
    projectId: input.projectId,
    environment: input.environment,
    positionId: position.id,
    provider: input.provider,
    providerReference: input.providerReference,
    custodyWalletId: input.wallet.id,
    direction: "deposit",
    requestId: input.requestId,
    amount: input.amount,
    createdBy: input.userId ?? null,
    initiatedByKeyId: input.apiKeyId ?? null,
  });

  // A replay must NOT move money again. Return what the original attempt did.
  if (replayed) {
    return { position, movement, replayed: true };
  }

  const fail = async (reason: string) => {
    const failed = await repo.advanceMovement({
      movementId: movement.id,
      organizationId: input.organizationId,
      fromStatuses: ["pending"],
      toStatus: "failed",
      failureReason: reason,
    });
    return { position, movement: failed ?? movement, replayed: false };
  };

  // 2. Build.
  let plan: Awaited<ReturnType<typeof client.buildVaultDeposit>>;
  try {
    plan = await client.buildVaultDeposit(runtime, {
      providerReference: input.providerReference,
      owner: input.wallet.publicKey,
      amount: input.amount,
      ...(input.minSharesOut === undefined ? {} : { minSharesOut: input.minSharesOut }),
    });
  } catch (error) {
    getLogger().error({ movementId: movement.id, error }, "vault deposit: build failed");
    return await fail(error instanceof Error ? error.message : "Failed to build the deposit.");
  }

  // 3. Simulate before signing — cheaper than a landed failure the customer paid for.
  const simulation = await simulateVaultPlan(env, {
    plan,
    owner: address(input.wallet.publicKey),
    rpcUrl,
  });
  if (!simulation.ok) {
    getLogger().error(
      { movementId: movement.id, error: simulation.error, logs: simulation.logs.slice(-5) },
      "vault deposit: simulation failed"
    );
    return await fail(`Simulation failed: ${simulation.error}`);
  }

  // 4. Sign with custody and submit.
  const signer = await solanaServices.createOrgSigner(
    env,
    input.organizationId,
    input.projectId,
    input.wallet.walletId
  );
  if (signer.address !== input.wallet.publicKey) {
    // The same assertion private-channels makes: a resolved signer that is not
    // the wallet we priced the deposit for would move someone else's money.
    throw badRequest("Resolved signing wallet does not match the deposit wallet");
  }

  let signature: string;
  try {
    const submitted = await submitVaultPlan(env, {
      plan,
      owner: signer,
      rpcUrl,
      fee: resolveVaultFeeMode(),
    });
    signature = submitted.signature;
  } catch (error) {
    getLogger().error({ movementId: movement.id, error }, "vault deposit: submit failed");
    return await fail(error instanceof Error ? error.message : "Failed to submit the deposit.");
  }

  // 5. Advance. Guarded so a concurrent observer cannot regress the row.
  const advanced = await repo.advanceMovement({
    movementId: movement.id,
    organizationId: input.organizationId,
    fromStatuses: ["pending"],
    toStatus: "submitted",
    signature,
  });

  return { position, movement: advanced ?? movement, replayed: false };
}

/**
 * Who pays the transaction fee.
 *
 * WALLET-PAYS for now, unconditionally. Kora only sponsors transactions whose
 * programs are on its allowlist, and the Kamino kvault/klend programs are not on
 * it — the Private Channels escrow hit exactly this and still pays its own fee
 * today. Attempting sponsorship would fail at the relay with an opaque
 * rejection AFTER the customer's wallet had already signed.
 *
 * Flipping to sponsored is a one-line change here once `validation_config.allowed_programs`
 * carries the kvault, klend and farms ids on the relevant relay (an sdp-infra
 * change). The plumbing already exists: `submitVaultPlan` takes the mode.
 */
function resolveVaultFeeMode(): VaultFeeMode {
  return { kind: "wallet-pays" };
}
