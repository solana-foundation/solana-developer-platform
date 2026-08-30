import { createHash } from "node:crypto";
import type {
  FailureCode,
  KnownAsset,
  OperationEvent,
  OperationState,
  PrivateOperation,
  PrivateOperationInput,
  PrivateWallet,
  ReadIdentityResult,
  RuntimeHealth,
  SyncPhotonResult,
  TransitionGuard,
  VerifyIndexedResult,
} from "@sdp/helius-rings";
import {
  HeliusRingsError,
  type HeliusRingsErrorCode,
  nextState,
  type RingsGatewayPort,
  RUNTIME_HEALTH_COMPONENTS,
} from "@sdp/helius-rings";
import type { WalletOperationPolicyEnforcement } from "@sdp/policy";
import type { ApprovalRequestStatus, WalletOperationActor } from "@sdp/types";
import {
  createHeliusRingsAssetRepository,
  createHeliusRingsEventRepository,
  createHeliusRingsHealthRepository,
  createHeliusRingsOperationRepository,
  createHeliusRingsWalletRepository,
  createPolicyRepository,
  type HeliusRingsAssetRepository,
  type HeliusRingsEventRepository,
  type HeliusRingsHealthRepository,
  type HeliusRingsOperationRepository,
  type HeliusRingsOperationRow,
  type HeliusRingsWalletRepository,
  mapHeliusRingsEventRow,
  mapHeliusRingsHealthRows,
  mapHeliusRingsWalletRow,
} from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import { enforceWalletOperationPolicy } from "@/services/policy/enforcement.service";
import type { Env } from "@/types/env";
import { RingsAdapterError, redactAdapterMessage } from "./adapter-error";
import {
  type RingsOuterTransactionPolicyInput,
  resolveRingsGateway,
  validateRingsOuterTransaction,
} from "./gateway";
import { buildRingsWalletOperationInput } from "./policy-envelope";
import { submitRingsOuterTransaction } from "./rpc-adapter";
import { assertRingsSignedTransactionMatches, signRingsOuterTransaction } from "./signer-adapter";

/**
 * Orchestrates every Rings action: provisioning, prepare-through-policy,
 * execution, retry lineage. State transitions run through the persisted state
 * machine with compare-and-swap guards, and every hop is recorded on the
 * operation's event feed.
 *
 * Any path reaching a port method the selected gateway has not implemented ends
 * in `failed:gateway_unavailable` (retryable) — the UI reports the pending
 * integration honestly instead of simulating it.
 */

export interface HeliusRingsTenant {
  organizationId: string;
  projectId: string;
}

export interface HeliusRingsActor {
  apiKeyId: string | null;
  actor: WalletOperationActor | null;
}

export interface HeliusRingsServiceDependencies {
  gateway?: RingsGatewayPort;
  wallets?: HeliusRingsWalletRepository;
  operations?: HeliusRingsOperationRepository;
  events?: HeliusRingsEventRepository;
  health?: HeliusRingsHealthRepository;
  assets?: HeliusRingsAssetRepository;
  enforcePolicy?: typeof enforceWalletOperationPolicy;
  /** Test seam; production always uses the SDK-backed local wrapper. */
  validateOuterTransaction?: typeof validateRingsOuterTransaction;
  signOuterTransaction?: typeof signRingsOuterTransaction;
  submitOuterTransaction?: typeof submitRingsOuterTransaction;
  /** Reads the approval verdict; defaults to the policy repository. */
  getApprovalStatus?: (approvalRequestId: string) => Promise<ApprovalRequestStatus | null>;
  now?: () => string;
}

/**
 * How deep a retry chain may grow. Retrying the same failure past this depth
 * is churn, not recovery, and the operator should look at the failure code.
 */
export const RINGS_MAX_RETRY_DEPTH = 5;

/**
 * How long a signed failure must have sat before it can be declared absent.
 *
 * A blockhash dies about ninety seconds after signing, but the two history
 * methods can miss a transaction for longer than that while it propagates into
 * block and archival storage. Voiding inside that window would release the
 * wallet for a payment that had in fact landed, so absence is only ever
 * concluded well after it.
 */
export const RINGS_RECONCILE_MIN_AGE_MS = 5 * 60 * 1000;

export interface WalletIdentityResult extends ReadIdentityResult {
  recordedShieldedAddress: string | null;
}

/** Op types that consume notes, and so can duplicate a payment. */
const SPEND_OP_TYPES = new Set<string>(["transfer_registered", "withdraw", "merge"]);

function assertOperationEnabled(opType: PrivateOperationInput["opType"]): void {
  if (opType === "merge") {
    throw new HeliusRingsError(
      "invalid_input",
      "merge is temporarily disabled until fresh wallet sync can replay merged state safely"
    );
  }
  if (opType === "transfer_anonymous") {
    throw new HeliusRingsError("invalid_input", "anonymous transfer is not enabled in this build");
  }
}

export interface ProvisionPrivateWalletInput {
  sdpWalletId: string;
  /** The custody wallet's public address, handed to the gateway. */
  sdpAddress: string;
  name: string;
  /**
   * The immutable custody_wallets row id. Recorded at creation so later
   * signing resolves the same wallet even if the provider reissues its own id.
   */
  custodyWalletId?: string | null;
}

export interface PrepareOperationContext extends HeliusRingsActor {
  /** The SDP custody wallet id backing the rings wallet, for the policy envelope. */
  custodyWalletId: string | null;
}

/** States `executeOperation` acts on; the rest return unchanged. */
/**
 * States `executeOperation` can move forward from.
 *
 * `proving` and `ready_to_sign` are here because a crash inside the pipeline
 * leaves an operation in one of them, and both sit in the unique indexes — so
 * without a way out they hold their wallet permanently, with retry refusing
 * them for not being `failed`.
 */
const EXECUTABLE_STATES: ReadonlySet<OperationState> = new Set([
  "approval_required",
  "proving",
  "ready_to_sign",
  "submitted",
  "indexing",
]);

export function createHeliusRingsService(
  env: Env,
  tenant: HeliusRingsTenant,
  dependencies: HeliusRingsServiceDependencies = {}
): HeliusRingsService {
  return new HeliusRingsService(env, tenant, dependencies);
}

export class HeliusRingsService {
  private readonly gateway: RingsGatewayPort;
  private readonly wallets: HeliusRingsWalletRepository;
  private readonly operations: HeliusRingsOperationRepository;
  private readonly events: HeliusRingsEventRepository;
  private readonly health: HeliusRingsHealthRepository;
  private readonly assets: HeliusRingsAssetRepository;
  private readonly enforcePolicy: typeof enforceWalletOperationPolicy;
  private readonly validateOuterTransaction: typeof validateRingsOuterTransaction;
  private readonly signOuterTransaction: typeof signRingsOuterTransaction;
  private readonly submitOuterTransaction: typeof submitRingsOuterTransaction;
  private readonly getApprovalStatus: (
    approvalRequestId: string
  ) => Promise<ApprovalRequestStatus | null>;
  private readonly now: () => string;

  constructor(
    private readonly env: Env,
    private readonly tenant: HeliusRingsTenant,
    dependencies: HeliusRingsServiceDependencies = {}
  ) {
    // The schema's network CHECK is the second half of this guard. Going to
    // mainnet is a deliberate migration, not a config flip.
    if ((env.SOLANA_NETWORK ?? "devnet") !== "devnet") {
      throw new AppError("SERVICE_UNAVAILABLE", "Helius Rings is devnet-only");
    }
    this.gateway = dependencies.gateway ?? resolveRingsGateway(env, tenant);
    this.wallets = dependencies.wallets ?? createHeliusRingsWalletRepository(env);
    this.operations = dependencies.operations ?? createHeliusRingsOperationRepository(env);
    this.events = dependencies.events ?? createHeliusRingsEventRepository(env);
    this.health = dependencies.health ?? createHeliusRingsHealthRepository(env);
    this.assets = dependencies.assets ?? createHeliusRingsAssetRepository(env);
    this.enforcePolicy = dependencies.enforcePolicy ?? enforceWalletOperationPolicy;
    this.validateOuterTransaction =
      dependencies.validateOuterTransaction ?? validateRingsOuterTransaction;
    this.signOuterTransaction = dependencies.signOuterTransaction ?? signRingsOuterTransaction;
    this.submitOuterTransaction =
      dependencies.submitOuterTransaction ?? submitRingsOuterTransaction;
    this.getApprovalStatus =
      dependencies.getApprovalStatus ??
      (async (approvalRequestId) => {
        const scope = createTenantScope({
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
        });
        const detail = await createPolicyRepository(env, scope).getApprovalRequestDetail({
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          approvalRequestId,
        });
        return detail?.approval_status ?? null;
      });
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  /**
   * Creates (or returns) the rings wallet bound to one custody wallet, then
   * asks the gateway for a shielded identity. While the gateway cannot yet
   * provision, the port throws and the wallet stays `pending` — the wizard
   * renders that state.
   *
   * Only the public identity crosses the port, so there is no key material to
   * persist here and none is held in this process beyond the gateway call.
   */
  async provisionPrivateWallet(input: ProvisionPrivateWalletInput): Promise<PrivateWallet> {
    const wallet = await this.wallets.createWallet({
      ...this.tenant,
      sdpWalletId: input.sdpWalletId,
      name: input.name,
      materialTag: "simulated",
      custodyWalletId: input.custodyWalletId ?? null,
    });
    if (!wallet) {
      throw new AppError("INTERNAL_ERROR", "rings wallet reservation returned no row");
    }
    if (wallet.status !== "pending") {
      return mapHeliusRingsWalletRow(wallet);
    }

    const provision = await this.gateway.provisionIdentity({
      walletId: wallet.id,
      sdpAddress: input.sdpAddress,
    });

    const provisioned = await this.wallets.markProvisioned({
      ...this.tenant,
      id: wallet.id,
      shieldedAddress: provision.identity.shieldedAddress,
      ownerAddress: provision.identity.owner,
      materialTag: provision.materialTag,
      expectedStatus: "pending",
    });
    // A lost CAS means an operator paused the wallet mid-provision; honour it.
    return mapHeliusRingsWalletRow(provisioned ?? (await this.requireWallet(wallet.id)));
  }

  async readWalletIdentity(walletId: string, owner: string | null): Promise<WalletIdentityResult> {
    const wallet = await this.requireWallet(walletId);
    if (!owner) {
      throw new HeliusRingsError(
        "invalid_input",
        "custody controls no active wallet for this rings wallet's owner"
      );
    }

    const identity = await this.gateway.readIdentity({ walletId: wallet.id, owner });
    return { ...identity, recordedShieldedAddress: wallet.shielded_address };
  }

  /**
   * Reserves the intent, then advances draft → preparing → policy. Idempotent:
   * a replayed request returns the operation already reserved, at whatever
   * state it has reached, without re-running policy.
   */
  async prepareOperation(
    input: PrivateOperationInput,
    context: PrepareOperationContext,
    retryOfOperationId: string | null = null
  ): Promise<PrivateOperation> {
    assertOperationEnabled(input.opType);
    const wallet = await this.requireWallet(input.walletId);
    await this.assertAssetAllowed(input);
    await this.assertNoUnresolvedOperation(input);
    const intentKey = computeIntentKey(input);

    const { operation, reserved } = await this.operations.reserveIntent({
      ...this.tenant,
      walletId: wallet.id,
      opType: input.opType,
      intentKey,
      assetMint: input.asset?.mint ?? null,
      amountRaw: input.asset?.amountRaw ?? null,
      fromAddr: input.from ?? null,
      toAddr: input.to ?? null,
      zoneId: input.zoneId ?? null,
      transferMode: input.transferMode ?? null,
      retryOfOperationId,
      timelock: input.timelock
        ? { unlockAt: input.timelock.unlockAt, beneficiaryAddr: input.timelock.beneficiary }
        : null,
    });
    if (!reserved) {
      return this.toPrivateOperation(operation);
    }

    await this.events.append({
      operationId: operation.id,
      kind: retryOfOperationId ? "operation.retried" : "operation.created",
      payload: retryOfOperationId ? { retryOfOperationId } : undefined,
    });
    const preparing = await this.transition(operation.id, "draft", undefined);
    if (!preparing) return this.toPrivateOperation(await this.requireOperation(operation.id));

    let enforcement: WalletOperationPolicyEnforcement;
    try {
      enforcement = await this.enforcePolicy(
        this.env,
        createTenantScope({
          organizationId: this.tenant.organizationId,
          projectId: this.tenant.projectId,
        }),
        buildRingsWalletOperationInput({
          organizationId: this.tenant.organizationId,
          projectId: this.tenant.projectId,
          custodyWalletId: context.custodyWalletId,
          sdpWalletId: wallet.sdp_wallet_id,
          apiKeyId: context.apiKeyId,
          actor: context.actor,
          operation: input,
          operationId: operation.id,
          intentKey,
        })
      );
    } catch (error) {
      const failed = await this.fail(operation.id, "preparing", {
        code: "invalid_input",
        message: error instanceof Error ? error.message : "policy evaluation failed",
        retryable: true,
      });
      return this.toPrivateOperation(failed ?? (await this.requireOperation(operation.id)));
    }

    const { evaluation } = enforcement;
    await this.events.append({
      operationId: operation.id,
      kind: "policy.evaluated",
      payload: { decision: evaluation.decision, policyEvaluationId: evaluation.id },
    });

    if (evaluation.decision === "deny") {
      const failed = await this.fail(operation.id, "preparing", {
        code: "policy_denied",
        message: evaluation.reason ?? "denied by wallet policy",
        retryable: false,
      });
      return this.toPrivateOperation(failed ?? (await this.requireOperation(operation.id)));
    }

    // The machine has no preparing → proving shortcut: an allowed operation
    // passes through approval_required with the `approved` guard immediately
    // satisfied, so the row's history reads the same either way.
    const paused = await this.transition(operation.id, "preparing", "policy_ok", {
      policyEvaluationId: evaluation.id,
      approvalRequestId: evaluation.approvalRequestId,
    });
    if (!paused) return this.toPrivateOperation(await this.requireOperation(operation.id));

    if (evaluation.requiresApproval) {
      await this.events.append({
        operationId: operation.id,
        kind: "approval.requested",
        payload: { approvalRequestId: evaluation.approvalRequestId },
      });
      return this.toPrivateOperation(paused);
    }

    const proving = await this.transition(operation.id, "approval_required", "approved");
    if (!proving) return this.toPrivateOperation(await this.requireOperation(operation.id));
    return this.toPrivateOperation(await this.runPipeline(proving));
  }

  /**
   * Advances an operation that is waiting on an external condition. Idempotent
   * per state: an approval still pending or a signature not yet indexed leaves
   * the row untouched. `submitted` is executable too, so a broadcast whose
   * indexing transition never committed is resumed rather than stranded.
   */
  async executeOperation(operationId: string): Promise<PrivateOperation> {
    let operation = await this.requireOperation(operationId);
    if (!EXECUTABLE_STATES.has(operation.state)) {
      return this.toPrivateOperation(operation);
    }
    assertOperationEnabled(operation.op_type);

    if (operation.state === "approval_required") {
      // The approval verdict is read from the approval request itself — never
      // from the caller. Trusting the request body here would let anyone with
      // write access skip a reviewer.
      if (!operation.approval_request_id) {
        const failed = await this.fail(operation.id, "approval_required", {
          code: "invalid_input",
          message: "approval_required without an approval request",
          retryable: false,
        });
        return this.toPrivateOperation(failed ?? (await this.requireOperation(operation.id)));
      }
      const status = await this.getApprovalStatus(operation.approval_request_id);
      if (status === "rejected" || status === "canceled" || status === "expired") {
        const failed = await this.fail(operation.id, "approval_required", {
          code: "approval_rejected",
          message: `approval request was ${status}`,
          retryable: false,
        });
        return this.toPrivateOperation(failed ?? (await this.requireOperation(operation.id)));
      }
      if (status !== "approved") {
        return this.toPrivateOperation(operation);
      }
      await this.events.append({ operationId: operation.id, kind: "approval.granted" });
      const proving = await this.transition(operation.id, "approval_required", "approved");
      if (!proving) return this.toPrivateOperation(await this.requireOperation(operation.id));
      return this.toPrivateOperation(await this.runPipeline(proving));
    }

    // proving: died mid-build. Nothing was signed, so rebuilding is safe;
    // `runPipeline` pins any notes a prior attempt recorded.
    if (operation.state === "proving") {
      return this.toPrivateOperation(await this.runPipeline(operation));
    }

    // ready_to_sign: the two halves of this state are not the same situation.
    if (operation.state === "ready_to_sign") {
      if (operation.signed_transaction) {
        // Bytes exist but the move to `submitted` never committed, so they may
        // never have been broadcast. `runPipeline` resends exactly these.
        return this.toPrivateOperation(await this.runPipeline(operation));
      }

      // No bytes, so nothing reached the chain. Failing retryably lets a retry
      // rebuild; the unsigned transaction was never persisted.
      const failed = await this.fail(operation.id, "ready_to_sign", {
        code: "signer_failed",
        message: "signing did not complete and no transaction bytes were recorded",
        retryable: true,
      });
      return this.toPrivateOperation(failed ?? (await this.requireOperation(operation.id)));
    }

    // submitted: the broadcast either landed or never left the process, and
    // nothing here tells the two apart, so recovery resends the exact persisted
    // bytes. Without this, a crash between the RPC call and the
    // submitted → indexing transition would strand a live transaction: the poll
    // skips non-`indexing` rows and retry requires `failed`. Falls through to
    // the poll below so one call both resumes and checks.
    if (operation.state === "submitted") {
      await this.resubmitPersistedBytes(operation);
      const resumed = await this.transition(operation.id, "submitted", "submitted");
      if (!resumed) return this.toPrivateOperation(await this.requireOperation(operation.id));
      operation = resumed;
    }

    // indexing: poll Photon through the port.
    if (!operation.outer_tx_signature) {
      const failed = await this.fail(operation.id, "indexing", {
        code: "invalid_input",
        message: "indexing without a submitted signature",
        retryable: false,
      });
      return this.toPrivateOperation(failed ?? (await this.requireOperation(operation.id)));
    }
    try {
      const indexed = await this.gateway.verifyIndexed(operation.outer_tx_signature);
      if (!indexed) return this.toPrivateOperation(operation);
      const completed = await this.transition(operation.id, "indexing", "indexed", {
        photonIndexedAt: indexed.indexedAt,
      });
      if (completed) {
        // The wallet's state changed at this slot, so every later read of it
        // has to reach here before it can be believed.
        await this.wallets.advanceIndexedSlot({
          ...this.tenant,
          id: operation.wallet_id,
          slot: indexed.slot,
        });
        await this.events.append({
          operationId: operation.id,
          kind: "operation.completed",
          payload: { photonRef: indexed.photonRef },
        });
      }
      return this.toPrivateOperation(completed ?? (await this.requireOperation(operation.id)));
    } catch (error) {
      return this.toPrivateOperation(await this.failFromPortError(operation, error));
    }
  }

  /**
   * Sends the persisted bytes again, for an operation resumed after signing.
   *
   * Best-effort on purpose: a duplicate of a landed transaction is rejected,
   * and so is an expired one, but neither is a reason to fail the operation.
   * Photon decides whether it settled. This only rules out the case nothing
   * else covers — bytes signed and recorded that never reached the network.
   */
  private async resubmitPersistedBytes(operation: HeliusRingsOperationRow): Promise<void> {
    if (!operation.signed_transaction) return;

    try {
      await this.submitOuterTransaction({
        env: this.env,
        signedTxBase64: operation.signed_transaction,
      });
    } catch (error) {
      await this.events.append({
        operationId: operation.id,
        kind: "transaction.submitted",
        payload: {
          signature: operation.outer_tx_signature,
          resubmit: "rejected",
          reason: redactAdapterMessage(error instanceof Error ? error.message : "unknown"),
        },
      });
    }
  }

  /**
   * Releases a signed failure after an operator confirms it never landed.
   *
   * The signature must match the row: voiding is an assertion, not an
   * observation, and naming the wrong transaction would release the wallet for
   * a payment that may still be in flight. A fresh Photon read backs the
   * assertion at commit time: if the transaction actually landed, this promotes
   * the row to `completed` and refuses the void, so the wallet slot is never
   * released while the value has already moved. `verifyIndexed` throws on
   * gateway or RPC error, so a transient outage fails the void loudly rather
   * than releasing the slot on stale evidence.
   */
  async voidOperation(
    operationId: string,
    signature: string,
    actor: HeliusRingsActor
  ): Promise<PrivateOperation> {
    const operation = await this.requireOperation(operationId);

    if (operation.state === "voided") {
      return this.toPrivateOperation(operation);
    }
    if (operation.state !== "failed") {
      throw new HeliusRingsError(
        "conflict",
        `operation ${operation.id} is ${operation.state}; only a signed failure can be voided`
      );
    }
    if (operation.failure_code !== "manual_reconciliation_required") {
      throw new HeliusRingsError(
        "conflict",
        "only an operation awaiting manual reconciliation can be voided"
      );
    }
    if (!operation.outer_tx_signature || operation.outer_tx_signature !== signature) {
      throw new HeliusRingsError(
        "conflict",
        "the signature does not match this operation's signed transaction"
      );
    }

    const indexed = await this.gateway.verifyIndexed(operation.outer_tx_signature);
    if (indexed) {
      await this.settleReconciled(operation, indexed);
      throw new HeliusRingsError(
        "conflict",
        `operation ${operation.id} settled on chain and has been completed; voiding is refused`
      );
    }

    const voided = await this.operations.voidOperation({ ...this.tenant, id: operation.id });
    if (!voided) return this.toPrivateOperation(await this.requireOperation(operation.id));

    await this.events.append({
      operationId: voided.id,
      kind: "operation.voided",
      payload: {
        signature,
        actor: actor.actor,
        apiKeyId: actor.apiKeyId,
      },
    });

    return this.toPrivateOperation(voided);
  }

  /**
   * Escalates a signed failure whose blockhash has expired to
   * `manual_reconciliation_required`, if Photon still has nothing.
   *
   * Never assumes absence on its own: asks Photon first, and only if the
   * indexer still holds nothing does the row's failure code change. That keeps
   * the invariant that positive evidence is the only path to `completed`.
   */
  async escalateToManualReconciliation(operationId: string): Promise<PrivateOperation> {
    const operation = await this.requireOperation(operationId);
    if (operation.state !== "failed" || !operation.signed_transaction) {
      return this.toPrivateOperation(operation);
    }
    if (operation.failure_code === "manual_reconciliation_required") {
      return this.toPrivateOperation(operation);
    }

    // A late Photon hit is the same answer as the happy path; take it.
    const settled = await this.completeIfIndexed(operationId);
    if (settled.state === "completed") return settled;

    const escalated = await this.operations.escalateToManualReconciliation({
      ...this.tenant,
      id: operation.id,
    });
    if (!escalated) return this.toPrivateOperation(await this.requireOperation(operation.id));

    await this.events.append({
      operationId: escalated.id,
      kind: "operation.escalated",
      payload: { fromCode: operation.failure_code },
    });

    return this.toPrivateOperation(escalated);
  }

  /**
   * Completes a signed failure if Photon now holds it, and does nothing if not.
   *
   * Never reads the chain or the blockhash, so it can never conclude absence —
   * which is what makes it safe for the poll to call unattended.
   */
  async completeIfIndexed(operationId: string): Promise<PrivateOperation> {
    const operation = await this.requireOperation(operationId);
    if (operation.state !== "failed" || !operation.outer_tx_signature) {
      return this.toPrivateOperation(operation);
    }

    const indexed = await this.gateway.verifyIndexed(operation.outer_tx_signature);
    if (!indexed) return this.toPrivateOperation(operation);

    return this.toPrivateOperation(await this.settleReconciled(operation, indexed));
  }

  /** Same writes as the happy-path indexing hit; it is that fact arriving late. */
  private async settleReconciled(
    operation: HeliusRingsOperationRow,
    indexed: VerifyIndexedResult
  ): Promise<HeliusRingsOperationRow> {
    const completed = await this.operations.completeFromFailed({
      ...this.tenant,
      id: operation.id,
      photonIndexedAt: indexed.indexedAt,
    });
    if (!completed) return this.requireOperation(operation.id);

    await this.wallets.advanceIndexedSlot({
      ...this.tenant,
      id: completed.wallet_id,
      slot: indexed.slot,
    });
    await this.events.append({
      operationId: completed.id,
      kind: "operation.completed",
      payload: { photonRef: indexed.photonRef, reconciledFrom: "failed" },
    });

    return completed;
  }

  /**
   * Files a fresh operation linked to a failed, retryable one and runs it
   * through the same prepare-through-policy path — a retry re-earns its policy
   * verdict, never inherits one. The original row stays exactly as it failed;
   * the lineage is audit evidence, capped at RINGS_MAX_RETRY_DEPTH.
   */
  async retryOperation(
    operationId: string,
    clientNonce: string,
    context: PrepareOperationContext
  ): Promise<PrivateOperation> {
    const failed = await this.requireOperation(operationId);
    if (failed.state !== "failed") {
      throw new AppError("CONFLICT", "only a failed operation can be retried");
    }
    if (!failed.retryable) {
      throw new AppError("CONFLICT", "operation failure is not retryable");
    }
    // A retry files a *fresh* operation, which builds and selects notes again.
    // That is safe right up until bytes exist: past that point the original may
    // have landed, and a second transaction for the same intent would pay the
    // recipient twice. The signed bytes are the line, not the state, because a
    // failure can be recorded after signing.
    if (failed.signed_transaction) {
      throw new AppError(
        "CONFLICT",
        "this operation was already signed and may have landed; reconcile its signature on chain instead of retrying"
      );
    }
    await this.assertRetryDepth(failed);

    const timelock = failed.timelock_unlock_at
      ? await this.operations.getTimelock({ operationId: failed.id })
      : null;

    const input: PrivateOperationInput = {
      walletId: failed.wallet_id,
      opType: failed.op_type,
      asset: failed.asset_mint
        ? {
            mint: failed.asset_mint,
            ...(failed.amount_raw ? { amountRaw: failed.amount_raw } : {}),
          }
        : undefined,
      from: failed.from_addr ?? undefined,
      to: failed.to_addr ?? undefined,
      zoneId: failed.zone_id ?? undefined,
      transferMode: failed.transfer_mode ?? undefined,
      timelock: timelock
        ? { unlockAt: timelock.unlock_at, beneficiary: timelock.beneficiary_addr }
        : undefined,
      clientNonce,
    };

    return this.prepareOperation(input, context, failed.id);
  }

  async getOperation(operationId: string): Promise<PrivateOperation> {
    return this.toPrivateOperation(await this.requireOperation(operationId));
  }

  /**
   * Probes the gateway and records the observation per component. A gateway
   * that cannot be reached records itself red — never having observed an
   * upstream is not evidence that it is healthy.
   */
  async probeHealth(): Promise<RuntimeHealth> {
    try {
      const health = await this.gateway.probeHealth();
      await Promise.all(
        RUNTIME_HEALTH_COMPONENTS.map((component) =>
          this.health.recordHealth({
            projectId: this.tenant.projectId,
            component,
            status: health[component],
            // The response is rebuilt from these rows, so a reason that is not
            // stored is a reason the operator never sees. The probe classifies
            // its failures precisely so this field can carry them.
            detail: health.detail?.[component] ? { reason: health.detail[component] } : null,
          })
        )
      );
    } catch (error) {
      // Every component, not just the gateway: the probe is the only thing that
      // observes the other three, so a probe that did not run leaves no
      // evidence about any of them, and a stale green would be read as one.
      const reason = error instanceof HeliusRingsError ? error.message : "gateway probe failed";
      await Promise.all(
        RUNTIME_HEALTH_COMPONENTS.map((component) =>
          this.health.recordHealth({
            projectId: this.tenant.projectId,
            component,
            status: "red",
            detail: { reason },
          })
        )
      );
    }
    return mapHeliusRingsHealthRows(
      await this.health.listHealthByProject({ projectId: this.tenant.projectId })
    );
  }

  /**
   * Drives an operation from `proving` as far as the port allows:
   * build → proof → sign → submit → indexing. The first port failure takes the
   * state's fail edge; adapter failures carry their own codes.
   */
  private async runPipeline(operation: HeliusRingsOperationRow): Promise<HeliusRingsOperationRow> {
    let current = operation;

    // Bytes already exist for this operation, so the build is immutable.
    // Recovery resends what was recorded; it never returns to note selection.
    if (current.signed_transaction) {
      await this.resubmitPersistedBytes(current);
      // The guard depends on where the crash left it: `ready_to_sign` advances
      // on `signed`, `submitted` on `submitted`. One step per resume — the next
      // sweep carries it the rest of the way.
      const guard = current.state === "ready_to_sign" ? "signed" : "submitted";
      const resumed = await this.transition(current.id, current.state, guard);
      return resumed ?? (await this.requireOperation(current.id));
    }

    // proving: build the outer tx and request the proof.
    try {
      // The one address involved in both halves of this pipeline: it is what
      // the outer transaction is built for, and the key that must sign it.
      const owner = await this.requireOwner(current.wallet_id);
      const wallet = await this.requireWallet(current.wallet_id);
      // Private transfers require the recipient wallet's ShieldedAddress; the
      // SDK reloads its material transiently to lift it out.
      const recipient =
        current.op_type === "transfer_registered"
          ? await this.resolveTransferRecipient(current)
          : undefined;
      const built = await this.gateway.buildOperation({
        operation: this.toPrivateOperation(current),
        owner,
        ...(wallet.shielded_address ? { expectedShieldedAddress: wallet.shielded_address } : {}),
        // Binding on a pre-sign rebuild: preserve deterministic note selection,
        // and fail if the refreshed wallet view no longer contains those notes.
        ...(current.input_notes ? { pinnedInputs: current.input_notes } : {}),
        // Wait for the indexer to catch up to whatever last touched this
        // wallet. Selecting notes from a view older than that can pick one
        // already consumed, and the chain rejects the transaction it goes into.
        ...(wallet.last_indexed_slot ? { requireSlot: wallet.last_indexed_slot } : {}),
        knownAssets: await this.knownAssets(),
        ...(recipient ? { recipient } : {}),
      });

      // Proving and building are one call: the SDK proves inside the builder, so
      // reaching here is what `proof_received` means.
      const proof = built.proof;
      const ready = await this.transition(current.id, "proving", "proof_received", {
        proofSource: proof.source,
        proofRef: proof.ref.reveal("adapter"),
        // Recorded before anything is signed, so a recovery knows what this
        // operation committed to even if it never reaches submission.
        inputNotes: built.inputNotes,
      });
      if (!ready) return this.requireOperation(current.id);
      current = ready;

      await this.events.append({
        operationId: current.id,
        kind: "proof.received",
        payload: { source: proof.source },
      });

      // The unsigned bytes are authoritative. This runs after the proof and
      // input-note commitment are durable, but before custody sees anything it
      // could sign.
      await this.validateOuterTransaction(
        outerTransactionPolicyInput(
          current,
          owner,
          wallet.shielded_address,
          built.outerUnsignedTxBase64
        )
      );

      // A gateway metadata consistency check, not the security boundary: the
      // wire policy above derives the signer set from the bytes custody signs.
      assertRequiredSignerMetadata(built.requiredSigners, owner);

      const signed = await this.signOuterTransaction({
        env: this.env,
        organizationId: this.tenant.organizationId,
        projectId: this.tenant.projectId,
        owner,
        unsignedTxBase64: built.outerUnsignedTxBase64,
      });
      const signature = await assertRingsSignedTransactionMatches({
        owner,
        unsignedTxBase64: built.outerUnsignedTxBase64,
        signedTxBase64: signed,
      });

      // The outbox, in the order that makes a lost response recoverable: bytes
      // and expiry land first, then the state moves, then the submission is
      // marked begun, and only then is anything sent. Broadcasting first would
      // leave a live transaction whose bytes were never recorded, and a spend
      // cannot be rebuilt from scratch to find out what happened.
      const persisted = await this.operations.persistSigned({
        ...this.tenant,
        id: current.id,
        signature,
        signedTransaction: signed,
        lastValidBlockHeight: built.lastValidBlockHeight,
      });
      if (!persisted) {
        // Bytes are already recorded for this operation, so another worker is
        // mid-submission. Signing a second set for the same intent is how the
        // same payment lands twice.
        throw new RingsAdapterError(
          "submit_failed",
          "this operation already has signed bytes recorded; refusing to sign a second set",
          { retryable: false }
        );
      }

      const submitted = await this.transition(current.id, "ready_to_sign", "signed", {
        outerTxSignature: signature,
      });
      if (!submitted) return this.requireOperation(current.id);
      current = submitted;

      const started = await this.operations.markSubmissionStarted({
        ...this.tenant,
        id: current.id,
        at: this.now(),
      });
      if (!started) {
        // Another worker already owns the broadcast. Not a failure — the bytes
        // are identical, so a duplicate send is harmless — but it is recorded,
        // because two workers on one operation is worth seeing in the feed.
        await this.events.append({
          operationId: current.id,
          kind: "transaction.submitted",
          payload: { signature, submissionAlreadyStarted: true },
        });
      }

      // Broadcast from inside `submitted`, so an RPC failure records
      // `submit_failed` against the state the state machine declares it for.
      const broadcast = await this.submitOuterTransaction({
        env: this.env,
        signedTxBase64: signed,
      });

      // The signature was derived locally from these exact bytes, so a different
      // one back means the RPC broadcast something else. Continuing would track
      // the wrong transaction and report an unrelated one as this operation's.
      if (broadcast !== signature) {
        throw new RingsAdapterError(
          "submit_failed",
          `the RPC returned signature ${broadcast} for locally signed ${signature}`,
          { retryable: false }
        );
      }

      await this.events.append({
        operationId: current.id,
        kind: "transaction.submitted",
        payload: { signature },
      });

      const indexing = await this.transition(current.id, "submitted", "submitted");
      return indexing ?? (await this.requireOperation(current.id));
    } catch (error) {
      return this.failFromPortError(current, error);
    }
  }

  /** Maps a port or adapter failure onto the operation's fail edge. */
  private async failFromPortError(
    operation: HeliusRingsOperationRow,
    error: unknown
  ): Promise<HeliusRingsOperationRow> {
    const failed = await this.fail(operation.id, operation.state, describeFailure(error));
    return failed ?? (await this.requireOperation(operation.id));
  }

  private async transition(
    operationId: string,
    expectedState: OperationState,
    guard: TransitionGuard | undefined,
    patch?: Parameters<HeliusRingsOperationRepository["transitionState"]>[0]["patch"]
  ): Promise<HeliusRingsOperationRow | null> {
    const to = nextState(expectedState, guard);
    if (!to) return null;
    const row = await this.operations.transitionState({
      ...this.tenant,
      id: operationId,
      expectedState,
      nextState: to,
      patch,
    });
    if (row) {
      await this.events.append({
        operationId,
        kind: "state.transitioned",
        payload: { from: expectedState, to },
      });
    }
    return row;
  }

  private async fail(
    operationId: string,
    expectedState: OperationState,
    failure: { code: HeliusRingsOperationRow["failure_code"]; message: string; retryable: boolean }
  ): Promise<HeliusRingsOperationRow | null> {
    if (!failure.code) return null;
    const row = await this.operations.failOperation({
      ...this.tenant,
      id: operationId,
      expectedState,
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
    });
    if (row) {
      // The message is already redacted by the time it reaches here, and it is
      // the only place the specific upstream fault is stated — the event
      // payload carries just the code, so without this it exists solely on the
      // row and an operator has nothing to grep.
      getLogger().warn(
        {
          operationId,
          opType: row.op_type,
          walletId: row.wallet_id,
          from: expectedState,
          code: failure.code,
          retryable: failure.retryable,
          reason: failure.message,
        },
        "rings operation failed"
      );
      await this.events.append({
        operationId,
        kind: "operation.failed",
        payload: { code: failure.code, retryable: failure.retryable },
      });
    }
    return row;
  }

  /**
   * Walks the retry lineage toward the original operation and refuses once the
   * chain reaches RINGS_MAX_RETRY_DEPTH. The DB's retry_not_self CHECK rules
   * out a self-loop; the walk is still bounded in case of a longer cycle.
   */
  private async assertRetryDepth(operation: HeliusRingsOperationRow): Promise<void> {
    let depth = 1;
    let ancestorId = operation.retry_of_operation_id;
    while (ancestorId && depth < RINGS_MAX_RETRY_DEPTH + 1) {
      depth += 1;
      const ancestor = await this.operations.getOperationById({
        ...this.tenant,
        id: ancestorId,
      });
      ancestorId = ancestor?.retry_of_operation_id ?? null;
    }
    // The retry being filed would sit at depth + 1.
    if (depth + 1 > RINGS_MAX_RETRY_DEPTH) {
      throw new AppError(
        "CONFLICT",
        `retry limit reached (${RINGS_MAX_RETRY_DEPTH}); inspect the failure instead of retrying`
      );
    }
  }

  private async requireWallet(walletId: string) {
    const wallet = await this.wallets.getWalletById({ ...this.tenant, id: walletId });
    if (!wallet) throw new AppError("NOT_FOUND", "rings wallet not found");
    return wallet;
  }

  /**
   * Recipient of a private transfer, matched by shielded address within this
   * project. The recipient must be an already-provisioned wallet in the same
   * tenant — cross-tenant transfers are not supported in this build.
   */
  private async resolveTransferRecipient(
    operation: HeliusRingsOperationRow
  ): Promise<{ walletId: string; owner: string; expectedShieldedAddress: string }> {
    const shieldedAddress = operation.to_addr;
    if (!shieldedAddress) {
      throw new HeliusRingsError(
        "invalid_input",
        "a private transfer must name a recipient shielded address"
      );
    }
    if (shieldedAddress === operation.wallet_id) {
      throw new HeliusRingsError("invalid_input", "cannot transfer to self");
    }
    const rows = await this.wallets.listWallets({ ...this.tenant });
    const recipient = rows.find((row) => row.shielded_address === shieldedAddress);
    if (!recipient?.owner_address || !recipient.shielded_address) {
      throw new HeliusRingsError(
        "invalid_input",
        "the private transfer recipient must be a provisioned wallet in this project"
      );
    }
    if (recipient.id === operation.wallet_id) {
      throw new HeliusRingsError("invalid_input", "cannot transfer to self");
    }
    return {
      walletId: recipient.id,
      owner: recipient.owner_address,
      expectedShieldedAddress: recipient.shielded_address,
    };
  }

  /**
   * The owner a provisioned wallet's identity is published under.
   *
   * A wallet with no owner recorded was never provisioned live, and every
   * gateway call needing one also needs key material that cannot be derived
   * without it, so this refuses rather than substituting anything.
   */
  private async requireOwner(walletId: string): Promise<string> {
    const wallet = await this.requireWallet(walletId);
    if (!wallet.owner_address) {
      throw new HeliusRingsError("conflict", "this rings wallet has no provisioned identity yet");
    }
    return wallet.owner_address;
  }

  /**
   * Refuses a mint the shielded pool is not known to support.
   *
   * Checked before the intent is reserved, so an unsupported mint never becomes
   * an operation row. The allowlist is what the pool and the platform's token
   * registry both support; building against anything else fails deep inside a
   * proof, where the error names none of this.
   */
  private async assertAssetAllowed(input: PrivateOperationInput): Promise<void> {
    if (!input.asset) return;

    const allowed = await this.assets.listActive();
    if (!allowed.some((asset) => asset.mint === input.asset?.mint)) {
      throw new HeliusRingsError(
        "invalid_input",
        `${input.asset.mint} is not an asset Rings supports on this network`
      );
    }
  }

  /**
   * Refuses a new operation while a comparable one is still unaccounted for.
   *
   * "Comparable" is the same op type for a shield, and any spend for a spend:
   * two spends share one note pool, whereas a deposit only conflicts with
   * another deposit. A shield does not block a withdrawal, because a deposit
   * that lands late only adds notes.
   *
   * Blocked while a comparable operation is in flight, or has failed with
   * signed bytes. Failing is not the same as not having happened, and a failure
   * code the dashboard marks retryable actively invites the caller to file this
   * again — which for a deposit means the owner's public balance is debited
   * twice, and for a spend means the recipient is paid twice.
   *
   * The unique indexes carry the same predicate and are the real enforcement;
   * this exists so the caller is told what actually happened rather than
   * receiving a constraint name.
   */
  private async assertNoUnresolvedOperation(input: PrivateOperationInput): Promise<void> {
    const opTypes = SPEND_OP_TYPES.has(input.opType) ? [...SPEND_OP_TYPES] : [input.opType];

    const unresolved = await this.operations.findBlockingOperation({
      ...this.tenant,
      walletId: input.walletId,
      opTypes,
    });

    if (unresolved) {
      throw new HeliusRingsError(
        "conflict",
        `operation ${unresolved.id} was already signed for this wallet and has not settled; reconcile it on chain before starting another ${input.opType}`
      );
    }
  }

  /** The project's allowlisted mints, for labelling and validation. */
  private async knownAssets(): Promise<KnownAsset[]> {
    const allowlist = await this.assets.listActive();
    return allowlist.map((asset) => ({
      mint: asset.mint,
      symbol: asset.symbol,
      decimals: asset.decimals,
    }));
  }

  private async requireOperation(operationId: string): Promise<HeliusRingsOperationRow> {
    const operation = await this.operations.getOperationById({
      ...this.tenant,
      id: operationId,
    });
    if (!operation) throw new AppError("NOT_FOUND", "rings operation not found");
    return operation;
  }

  private toPrivateOperation(
    row: HeliusRingsOperationRow,
    events: OperationEvent[] = []
  ): PrivateOperation {
    return {
      id: row.id,
      walletId: row.wallet_id,
      opType: row.op_type,
      state: row.state,
      approvalRequestId: row.approval_request_id,
      policyEvaluationId: row.policy_evaluation_id,
      proof: null,
      outerTxSignature: row.outer_tx_signature,
      photonIndexedAt: row.photon_indexed_at,
      failure:
        row.failure_code && row.failure_message !== null && row.retryable !== null
          ? { code: row.failure_code, message: row.failure_message, retryable: row.retryable }
          : null,
      input: {
        walletId: row.wallet_id,
        opType: row.op_type,
        asset: row.asset_mint
          ? {
              mint: row.asset_mint,
              ...(row.amount_raw ? { amountRaw: row.amount_raw } : {}),
            }
          : undefined,
        from: row.from_addr ?? undefined,
        to: row.to_addr ?? undefined,
        zoneId: row.zone_id ?? undefined,
        transferMode: row.transfer_mode ?? undefined,
        timelock: undefined,
        // Consumed by the intent key at reservation; not retained.
        clientNonce: "",
      },
      intentKey: row.intent_key,
      events,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      retryOfOperationId: row.retry_of_operation_id,
    };
  }

  /**
   * Reads a provisioned wallet's shielded state from Photon.
   *
   * Always a full sync — see `SyncPhotonResult.observedAt` for why there is no
   * cursor to resume from. The observation time is recorded in `sync_cursor`
   * for the dashboard to show, and deliberately never read back as a resume
   * position.
   */
  async syncWallet(walletId: string): Promise<SyncPhotonResult> {
    const wallet = await this.requireWallet(walletId);
    if (!(wallet.owner_address && wallet.shielded_address)) {
      throw new HeliusRingsError("conflict", "this rings wallet has no provisioned identity yet");
    }

    const allowlist = await this.assets.listActive();

    const result = await this.gateway.syncPhoton({
      walletId: wallet.id,
      owner: wallet.owner_address,
      // Re-derived and compared inside the gateway. A wallet whose material no
      // longer reproduces its persisted identity must not report balances.
      expectedShieldedAddress: wallet.shielded_address,
      // Balances read before the indexer has caught up would show the state as
      // of the operation before last, which reads as money having vanished.
      ...(wallet.last_indexed_slot ? { requireSlot: wallet.last_indexed_slot } : {}),
      knownAssets: allowlist.map((asset) => ({
        mint: asset.mint,
        symbol: asset.symbol,
        decimals: asset.decimals,
      })),
    });

    await this.wallets.updateSyncCursor({
      ...this.tenant,
      id: wallet.id,
      syncCursor: result.observedAt,
    });

    // A sync sees the whole history, so it can carry the read position further
    // than the last completed operation did — a note received from someone
    // else's transfer arrives without an operation of ours behind it.
    //
    // Never from a degraded sync, though: `observedSlot` is the highest slot the
    // sync could *parse*, which is not the same as having seen everything up to
    // it. Advancing on that would make the next read gate on a position this
    // wallet has not actually been read through, and report the result as fresh.
    if (result.observedSlot && !result.report.degraded) {
      await this.wallets.advanceIndexedSlot({
        ...this.tenant,
        id: wallet.id,
        slot: result.observedSlot,
      });
    }

    return result;
  }

  /** The operation with its event feed joined in, for the detail panel. */
  async getOperationWithEvents(operationId: string): Promise<PrivateOperation> {
    const row = await this.requireOperation(operationId);
    const events = await this.events.listByOperation({ operationId: row.id });
    return this.toPrivateOperation(row, events.map(mapHeliusRingsEventRow));
  }
}

function requiredOuterPolicyField(value: string | null): string {
  if (!value) {
    throw new HeliusRingsError(
      "invalid_input",
      "the persisted Rings operation is missing final-wire policy context"
    );
  }
  return value;
}

function outerTransactionPolicyInput(
  operation: HeliusRingsOperationRow,
  owner: string,
  shieldedAddress: string | null,
  outerUnsignedTxBase64: string
): RingsOuterTransactionPolicyInput {
  const mint = requiredOuterPolicyField(operation.asset_mint);
  const amountRaw = requiredOuterPolicyField(operation.amount_raw);
  const common = { mint, amountRaw };

  switch (operation.op_type) {
    case "shield":
      return {
        outerUnsignedTxBase64,
        owner,
        intent: {
          opType: "shield",
          ...common,
          expectedShieldedAddress: requiredOuterPolicyField(shieldedAddress),
        },
      };
    case "withdraw":
      return {
        outerUnsignedTxBase64,
        owner,
        intent: {
          opType: "withdraw",
          ...common,
          to: requiredOuterPolicyField(operation.to_addr),
        },
      };
    case "transfer_registered":
      return {
        outerUnsignedTxBase64,
        owner,
        intent: {
          opType: "transfer_registered",
          ...common,
        },
      };
    default:
      throw new HeliusRingsError(
        "invalid_input",
        "this Rings operation type is not enabled for final-wire signing"
      );
  }
}

/**
 * Refuses inconsistent gateway signer metadata after wire validation passed.
 *
 * Advisory rather than authoritative: `validateRingsOuterTransaction` derives
 * the fee payer and required signers from serialized bytes. This metadata still
 * catches an internally inconsistent gateway result with a clearer failure.
 */
function assertRequiredSignerMetadata(requiredSigners: readonly string[], owner: string): void {
  const unexpected = requiredSigners.filter((signer) => signer !== owner);

  if (unexpected.length > 0 || !requiredSigners.includes(owner)) {
    throw new RingsAdapterError(
      "signer_failed",
      `the built transaction requires [${requiredSigners.join(", ")}] to sign, not ${owner} alone`,
      { retryable: false }
    );
  }
}

interface OperationFailure {
  code: FailureCode;
  message: string;
  retryable: boolean;
}

/**
 * Turns whatever the pipeline threw into the row's failure columns.
 *
 * `retryable` is the field that matters most: it decides whether the dashboard
 * offers a retry button, so a failure that cannot possibly succeed on a second
 * attempt must not claim it can.
 */
function describeFailure(error: unknown): OperationFailure {
  // Adapters classify their own failures; they know whether a signer refused
  // or merely timed out.
  if (error instanceof RingsAdapterError) {
    return { code: error.failureCode, message: error.message, retryable: error.retryable };
  }

  if (error instanceof HeliusRingsError) {
    const { code, retryable } = GATEWAY_FAILURES[error.code];
    return { code, message: error.message, retryable };
  }

  // An unrecognised throw is the one message nobody has vetted, so it gets the
  // same scrubbing the adapters apply to theirs before it reaches the row.
  return {
    code: "gateway_unavailable",
    message: redactAdapterMessage(error instanceof Error ? error.message : "rings gateway failed"),
    retryable: true,
  };
}

/**
 * Every code the gateway can raise, and what it becomes on the row.
 *
 * A total map rather than a switch with a default: a default is what let
 * `manual_reconciliation_required` be recorded as a retryable outage, which is
 * the one failure that must never offer a retry. Adding a code upstream is now
 * a build error here instead of a silent fallthrough.
 */
const GATEWAY_FAILURES: Record<HeliusRingsErrorCode, { code: FailureCode; retryable: boolean }> = {
  // No amount of retrying supplies an environment variable.
  config_error: { code: "config_error", retryable: false },
  // The wallet's identity is unusable for this spend: never provisioned, or
  // provisioned under material that no longer derives it. Both re-derive the
  // same way on every read, so a retry cannot change the answer.
  conflict: { code: "invalid_input", retryable: false },
  invalid_input: { code: "invalid_input", retryable: false },
  not_found: { code: "invalid_input", retryable: false },
  // The caller asked to move more than the wallet holds. Their input, and a
  // second attempt with the same amount fails the same way.
  insufficient_balance: { code: "insufficient_balance", retryable: false },
  // Reserved for post-sign recovery, where persisted signed bytes may already
  // have settled and a fresh operation could pay twice.
  manual_reconciliation_required: {
    code: "manual_reconciliation_required",
    retryable: false,
  },
  gateway_unavailable: { code: "gateway_unavailable", retryable: true },
};

/**
 * The idempotency contract: one deterministic key per (wallet, op, canonical
 * input, client nonce). Field order is pinned here — object spread order is
 * not part of the contract.
 */
export function computeIntentKey(input: PrivateOperationInput): string {
  const canonical = JSON.stringify({
    walletId: input.walletId,
    opType: input.opType,
    asset: input.asset ? { mint: input.asset.mint, amountRaw: input.asset.amountRaw } : null,
    from: input.from ?? null,
    to: input.to ?? null,
    zoneId: input.zoneId ?? null,
    transferMode: input.transferMode ?? null,
    timelock: input.timelock
      ? { unlockAt: input.timelock.unlockAt, beneficiary: input.timelock.beneficiary }
      : null,
    clientNonce: input.clientNonce,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
