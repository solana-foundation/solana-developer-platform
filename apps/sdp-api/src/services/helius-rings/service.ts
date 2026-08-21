import { createHash } from "node:crypto";
import type {
  OperationEvent,
  OperationState,
  PrivateOperation,
  PrivateOperationInput,
  PrivateWallet,
  RuntimeHealth,
  TransitionGuard,
} from "@sdp/helius-rings";
import {
  HeliusRingsError,
  NotImplementedRingsGateway,
  nextState,
  type RingsGatewayPort,
} from "@sdp/helius-rings";
import type { WalletOperationPolicyEnforcement } from "@sdp/policy";
import type { ApprovalRequestStatus, WalletOperationActor } from "@sdp/types";
import { getBase64Codec, getSignatureFromTransaction, getTransactionDecoder } from "@solana/kit";
import {
  createHeliusRingsEventRepository,
  createHeliusRingsHealthRepository,
  createHeliusRingsOperationRepository,
  createHeliusRingsWalletRepository,
  createPolicyRepository,
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
import { enforceWalletOperationPolicy } from "@/services/policy/enforcement.service";
import type { Env } from "@/types/env";
import { RingsAdapterError } from "./adapter-error";
import { buildRingsWalletOperationInput } from "./policy-envelope";
import { submitRingsOuterTransaction } from "./rpc-adapter";
import { signRingsOuterTransaction } from "./signer-adapter";

/**
 * Orchestrates every Rings action: provisioning, prepare-through-policy,
 * execution, retry lineage. State transitions run through the persisted state
 * machine with compare-and-swap guards, and every hop is recorded on the
 * operation's event feed.
 *
 * Until Track B lands the live gateway, any path that reaches the port ends in
 * `failed:gateway_unavailable` (retryable) — the UI reports the pending
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
  enforcePolicy?: typeof enforceWalletOperationPolicy;
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

export interface ProvisionPrivateWalletInput {
  sdpWalletId: string;
  /** The custody wallet's public address, handed to the gateway. */
  sdpAddress: string;
  name: string;
}

export interface PrepareOperationContext extends HeliusRingsActor {
  /** The SDP custody wallet id backing the rings wallet, for the policy envelope. */
  custodyWalletId: string | null;
}

/** States `executeOperation` acts on; the rest return unchanged. */
const EXECUTABLE_STATES: ReadonlySet<OperationState> = new Set([
  "approval_required",
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
  private readonly enforcePolicy: typeof enforceWalletOperationPolicy;
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
    this.gateway = dependencies.gateway ?? new NotImplementedRingsGateway();
    this.wallets = dependencies.wallets ?? createHeliusRingsWalletRepository(env);
    this.operations = dependencies.operations ?? createHeliusRingsOperationRepository(env);
    this.events = dependencies.events ?? createHeliusRingsEventRepository(env);
    this.health = dependencies.health ?? createHeliusRingsHealthRepository(env);
    this.enforcePolicy = dependencies.enforcePolicy ?? enforceWalletOperationPolicy;
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
   * asks the gateway for a shielded identity. Until Track B lands, the port
   * throws and the wallet stays `pending` — the wizard renders that state.
   *
   * Key material is deliberately not persisted here: sealing it through
   * custody-cipher into `helius_rings_key_refs` is the key-authority work
   * (Track B4), and holding it unsealed anywhere is not an option.
   */
  async provisionPrivateWallet(input: ProvisionPrivateWalletInput): Promise<PrivateWallet> {
    const wallet = await this.wallets.createWallet({
      ...this.tenant,
      sdpWalletId: input.sdpWalletId,
      name: input.name,
      materialTag: "simulated",
    });
    if (!wallet) {
      throw new AppError("INTERNAL_ERROR", "rings wallet reservation returned no row");
    }
    if (wallet.status !== "pending") {
      return mapHeliusRingsWalletRow(wallet);
    }

    const identity = await this.gateway.provisionIdentity({
      walletId: wallet.id,
      sdpAddress: input.sdpAddress,
    });

    const materialTag = identity.keyRefs.every((keyRef) => keyRef.materialTag === "live")
      ? "live"
      : "simulated";
    const provisioned = await this.wallets.markProvisioned({
      ...this.tenant,
      id: wallet.id,
      shieldedAddress: identity.shieldedAddress,
      materialTag,
      expectedStatus: "pending",
    });
    // A lost CAS means an operator paused the wallet mid-provision; honour it.
    return mapHeliusRingsWalletRow(provisioned ?? (await this.requireWallet(wallet.id)));
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
    const wallet = await this.requireWallet(input.walletId);
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

    // submitted: the broadcast either landed or never left the process, and
    // nothing here can tell the two apart — only the signature is persisted, not
    // the signed bytes, so there is nothing to resubmit. Both readings resolve
    // the same way: hand the signature to Photon and let the indexing budget
    // settle it. A hit completes the operation; a miss times out as
    // `indexing_timeout` (retryable). Without this, a crash between the RPC
    // call and the submitted → indexing transition left a live transaction
    // outside reconciliation forever — the poll skips non-`indexing` rows,
    // execute ignored `submitted`, and retry requires `failed`.
    if (operation.state === "submitted") {
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
    await this.assertRetryDepth(failed);

    const timelock = failed.timelock_unlock_at
      ? await this.operations.getTimelock({ operationId: failed.id })
      : null;

    const input: PrivateOperationInput = {
      walletId: failed.wallet_id,
      opType: failed.op_type,
      asset:
        failed.asset_mint && failed.amount_raw
          ? { mint: failed.asset_mint, amountRaw: failed.amount_raw }
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
        (["rpc", "prover", "photon", "gateway"] as const).map((component) =>
          this.health.recordHealth({
            projectId: this.tenant.projectId,
            component,
            status: health[component],
          })
        )
      );
    } catch (error) {
      await this.health.recordHealth({
        projectId: this.tenant.projectId,
        component: "gateway",
        status: "red",
        detail: {
          reason: error instanceof HeliusRingsError ? error.message : "gateway probe failed",
        },
      });
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

    // proving: build the outer tx and request the proof.
    try {
      const built = await this.gateway.buildOperation({
        // The port receives the domain view; key refs arrive with Track B4.
        operation: this.toPrivateOperation(current),
        keyRefs: [],
      });
      const proof = await this.gateway.requestProof({
        operationId: current.id,
        ringsMetadata: built.ringsMetadata,
      });
      const ready = await this.transition(current.id, "proving", "proof_received", {
        proofSource: proof.source,
        proofRef: proof.ref.reveal("adapter"),
      });
      if (!ready) return this.requireOperation(current.id);
      current = ready;

      await this.events.append({
        operationId: current.id,
        kind: "proof.received",
        payload: { source: proof.source },
      });

      // ready_to_sign → submitted: sign with custody, then persist the signature
      // *before* broadcasting. The signature is a property of the signed
      // transaction, so it is knowable without the network — which is what makes
      // `submitted` durable ahead of the RPC call. Broadcasting first would leave
      // a live on-chain transaction whose signature was never recorded if the
      // process died in between, and nothing sweeps `ready_to_sign` to find it.
      const signed = await this.signOuterTransaction({
        env: this.env,
        organizationId: this.tenant.organizationId,
        projectId: this.tenant.projectId,
        unsignedTxBase64: built.outerUnsignedTxBase64,
      });
      let signature: string;
      try {
        signature = getSignatureFromTransaction(
          getTransactionDecoder().decode(getBase64Codec().encode(signed))
        );
      } catch (cause) {
        // The signer returned something that is not a transaction. Retrying the
        // same inputs cannot change that, so this is the signer's failure.
        throw new RingsAdapterError("signer_failed", "signer returned undecodable bytes", {
          retryable: false,
          cause,
        });
      }

      const submitted = await this.transition(current.id, "ready_to_sign", "signed", {
        outerTxSignature: signature,
      });
      if (!submitted) return this.requireOperation(current.id);
      current = submitted;

      // Broadcast from inside `submitted`, so an RPC failure records
      // `submit_failed` against the state the state machine declares it for. The
      // intent key makes a resubmission safe.
      await this.submitOuterTransaction({ env: this.env, signedTxBase64: signed });

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
    const failure =
      error instanceof RingsAdapterError
        ? { code: error.failureCode, message: error.message, retryable: error.retryable }
        : error instanceof HeliusRingsError && error.code === "gateway_unavailable"
          ? { code: "gateway_unavailable" as const, message: error.message, retryable: true }
          : {
              code: "gateway_unavailable" as const,
              message: error instanceof Error ? error.message : "rings gateway failed",
              retryable: true,
            };

    const failed = await this.fail(operation.id, operation.state, failure);
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
        asset:
          row.asset_mint && row.amount_raw
            ? { mint: row.asset_mint, amountRaw: row.amount_raw }
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
    };
  }

  /** The operation with its event feed joined in, for the detail panel. */
  async getOperationWithEvents(operationId: string): Promise<PrivateOperation> {
    const row = await this.requireOperation(operationId);
    const events = await this.events.listByOperation({ operationId: row.id });
    return this.toPrivateOperation(row, events.map(mapHeliusRingsEventRow));
  }
}

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
