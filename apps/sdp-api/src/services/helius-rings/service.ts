import { createHash } from "node:crypto";
import type {
  AssetBalance,
  FailureCode,
  OperationEvent,
  OperationState,
  PrivateOperation,
  PrivateOperationInput,
  PrivateWallet,
  ReadIdentityResult,
  RuntimeHealth,
  TransitionGuard,
} from "@sdp/helius-rings";
import {
  HeliusRingsError,
  type HeliusRingsErrorCode,
  nextState,
  type RingsGatewayPort,
} from "@sdp/helius-rings";
import type { WalletOperationPolicyEnforcement } from "@sdp/policy";
import type { ApprovalRequestStatus, WalletOperationActor } from "@sdp/types";
import { getBase64Codec, getSignatureFromTransaction, getTransactionDecoder } from "@solana/kit";
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
import { enforceWalletOperationPolicy } from "@/services/policy/enforcement.service";
import type { Env } from "@/types/env";
import { RingsAdapterError } from "./adapter-error";
import { resolveRingsGateway } from "./gateway";
import { buildRingsWalletOperationInput } from "./policy-envelope";
import { submitRingsOuterTransaction } from "./rpc-adapter";
import { signRingsOuterTransaction } from "./signer-adapter";

/**
 * Orchestrates every Rings action: provisioning, sync, prepare-through-policy,
 * execution, retry lineage. State transitions run through the persisted state
 * machine with compare-and-swap guards, and every hop is recorded on the
 * operation's event feed.
 *
 * The gateway behind the port comes from `resolveRingsGateway`. Until an
 * operator configures the Rings upstreams it refuses every call, so any path
 * that reaches `buildOperation` ends in `failed:gateway_unavailable` — the UI
 * names what is unset instead of simulating a result.
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
  /**
   * Public key of that custody wallet. A shield stamps this as `from` so the
   * gateway knows who deposits and who must sign. Null when custody no longer
   * controls the backing wallet.
   */
  owner?: string | null;
}

export interface SyncWalletResult {
  balances: AssetBalance[];
  /**
   * The sync could not read everything it found. The balances below are still
   * the ones it did read, so this is what stops a partial answer from being
   * rendered as a complete one.
   */
  degraded: boolean;
  /** When the answer was true, not a position to resume from. */
  observedAt: string;
}

export interface WalletIdentityResult extends ReadIdentityResult {
  /**
   * The identity our own row records, which the gateway cannot know. Without
   * it "the chain publishes X" and "the chain publishes X and so do we" read
   * identically, and only the second means the row is up to date.
   */
  recordedShieldedAddress: string | null;
}

/** States `executeOperation` acts on; the rest return unchanged. */
const EXECUTABLE_STATES: ReadonlySet<OperationState> = new Set([
  "approval_required",
  "submitted",
  "indexing",
]);

/**
 * Domain port errors → operation fail-edge. Adapter errors carry their own
 * code and retryable bit and do not go through this table.
 *
 * `config_error` still lands as `gateway_unavailable`: there is no
 * `config_error` failure code, and the unconfigured-gateway path has always
 * offered a retry. `invalid_input` and `conflict` do not.
 */
const PORT_ERROR_FAILURE = {
  invalid_input: { code: "invalid_input", retryable: false },
  conflict: { code: "invalid_input", retryable: false },
  gateway_unavailable: { code: "gateway_unavailable", retryable: true },
  config_error: { code: "gateway_unavailable", retryable: true },
  not_found: { code: "gateway_unavailable", retryable: true },
} as const satisfies Record<HeliusRingsErrorCode, { code: FailureCode; retryable: boolean }>;

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
   * asks the gateway for a shielded identity. On a gateway that refuses, the
   * port throws and the wallet stays `pending` — the wizard renders that state.
   *
   * Key material is deliberately not persisted here. The deterministic key
   * authority recomputes it on demand and stores none of it, so there is
   * nothing to seal into `helius_rings_key_refs`; the gateway reports what kind
   * of material it used and that tag is the whole of what we keep.
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

    // The gateway is the only party that knows whether the identity it
    // published holds real material, so its tag is recorded rather than
    // inferred here. Getting this wrong in the optimistic direction would let a
    // simulated wallet be mistaken for one holding real funds.
    const provisioned = await this.wallets.markProvisioned({
      ...this.tenant,
      id: wallet.id,
      shieldedAddress: identity.shieldedAddress,
      materialTag: identity.materialTag,
      expectedStatus: "pending",
    });
    // A lost CAS means an operator paused the wallet mid-provision; honour it.
    return mapHeliusRingsWalletRow(provisioned ?? (await this.requireWallet(wallet.id)));
  }

  /**
   * Reads the wallet's shielded balances from Photon and records when the
   * answer was observed.
   *
   * `owner` is passed in rather than looked up: the identity is registered to a
   * specific custody key, and the caller has already resolved which custody
   * wallet backs this rings wallet. A null owner is a refusal, not a reason to
   * fall back to anything — there is no safe default for whose balances to read.
   *
   * The persisted `shielded_address` travels as `expectedShieldedAddress` so
   * the gateway re-derives the identity and compares. Without it a seed change,
   * a tenant mix-up or a wrong owner would answer with someone else's balances
   * instead of failing.
   */
  async syncWallet(walletId: string, owner: string | null): Promise<SyncWalletResult> {
    const wallet = await this.requireWallet(walletId);
    if (!wallet.shielded_address) {
      throw new HeliusRingsError(
        "invalid_input",
        "rings wallet has no shielded identity yet; provision it before syncing"
      );
    }
    if (!owner) {
      throw new HeliusRingsError(
        "invalid_input",
        "custody controls no active wallet for this rings wallet's owner"
      );
    }

    const synced = await this.gateway.syncPhoton({
      walletId: wallet.id,
      owner,
      cursor: wallet.sync_cursor,
      expectedShieldedAddress: wallet.shielded_address,
    });

    await this.wallets.updateSyncCursor({
      ...this.tenant,
      id: wallet.id,
      syncCursor: synced.cursor,
    });

    return {
      balances: await this.labelBalances(synced.balances),
      degraded: synced.degraded,
      observedAt: synced.cursor,
    };
  }

  /**
   * Reads what the registry publishes for this wallet's owner and whether it is
   * ours, alongside the identity our own row records.
   *
   * Deliberately without `syncWallet`'s `shielded_address` precondition. The
   * wallet this answers for is the one stuck `pending` — provisioning refused,
   * so no address was ever recorded — and refusing to read until one exists
   * would withhold the answer from exactly the case that needs it. A null owner
   * is still a refusal: there is no default account whose record to read.
   *
   * Writes nothing. No cursor, no health row, no wallet patch — the read
   * advances no stored observation, which is also why its route is a GET behind
   * the read permission rather than a POST behind write.
   */
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
    if (input.asset) {
      const allowed = await this.assets.getActiveByMint(input.asset.mint);
      if (!allowed) {
        throw new HeliusRingsError(
          "invalid_input",
          "this mint is not on the Rings asset allowlist"
        );
      }
    }

    const wallet = await this.requireWallet(input.walletId);
    const intentKey = computeIntentKey(input);

    const { operation, reserved } = await this.operations.reserveIntent({
      ...this.tenant,
      walletId: wallet.id,
      opType: input.opType,
      intentKey,
      assetMint: input.asset?.mint ?? null,
      amountRaw: input.asset?.amountRaw ?? null,
      // A shield always deposits from the backing owner. The request body is
      // not asked: a caller-supplied `from` would let someone name a different
      // fee payer than the identity they are shielding into.
      fromAddr: input.opType === "shield" ? (context.owner ?? null) : (input.from ?? null),
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
   *
   * The per-component reason is stored alongside the status, because the
   * response is rebuilt from these rows: a probe that classified why it failed,
   * or a gateway naming the variables it is missing, would otherwise be
   * discarded one layer above the only place that knew.
   */
  async probeHealth(): Promise<RuntimeHealth> {
    try {
      const health = await this.gateway.probeHealth();
      await Promise.all(
        (["rpc", "prover", "photon", "gateway"] as const).map((component) => {
          const reason = health.detail?.[component];
          return this.health.recordHealth({
            projectId: this.tenant.projectId,
            component,
            status: health[component],
            detail: reason === undefined ? null : { reason },
          });
        })
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
      const wallet = await this.requireWallet(current.wallet_id);
      const built = await this.gateway.buildOperation({
        // The port receives the domain view. No key refs: the deterministic
        // key authority recomputes material on demand and persists none of
        // it, so there is nothing to hand over.
        operation: this.toPrivateOperation(current),
        keyRefs: [],
        expectedShieldedAddress: wallet.shielded_address ?? undefined,
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
      //
      // The gateway names who must sign, and nobody else may be asked. Signing
      // with the organization's default wallet instead would produce a
      // perfectly valid signature from the wrong key and move the wrong money.
      const [owner, ...additionalSigners] = built.requiredSigners;
      if (!owner || additionalSigners.length > 0) {
        throw new RingsAdapterError(
          "signer_failed",
          "the built outer transaction does not name exactly one required signer",
          { retryable: false }
        );
      }
      const signed = await this.signOuterTransaction({
        env: this.env,
        organizationId: this.tenant.organizationId,
        projectId: this.tenant.projectId,
        owner,
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

      // Broadcast from inside `submitted`. A throw here is not evidence that
      // nothing landed: an RPC can time out or 503 after the node already
      // accepted the transaction, only the signature was persisted rather than
      // the signed bytes, and nothing available here tells the two readings
      // apart.
      //
      // So the failure is not taken. Failing `submit_failed` would mark the
      // operation retryable, and a retry files a *fresh* operation under a new
      // client nonce — a different intent key, a newly built transaction, a
      // second broadcast. Whenever the first one did land that shields the
      // amount twice. The identical ambiguity after a crash is already resolved
      // the other way by `executeOperation`, and this takes the same answer:
      // carry the signature into `indexing` and let Photon settle what actually
      // happened. A transaction that truly never left ends at
      // `indexing_timeout`, retryable only after Photon has had the full budget
      // to disagree.
      let broadcast: "accepted" | "unconfirmed" = "accepted";
      try {
        await this.submitOuterTransaction({ env: this.env, signedTxBase64: signed });
      } catch {
        broadcast = "unconfirmed";
      }

      // The RPC's own message is not recorded: it routinely quotes the endpoint
      // it failed on, and this deployment's endpoint carries a Helius API key.
      // The flag is the part that is actionable anyway — it tells an operator
      // reading the timeline that the signature below was never acknowledged,
      // so a `completed` here is Photon's word rather than the RPC's.
      await this.events.append({
        operationId: current.id,
        kind: "transaction.submitted",
        payload: { signature, broadcast },
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
    let failure: { code: FailureCode; message: string; retryable: boolean };
    if (error instanceof RingsAdapterError) {
      failure = { code: error.failureCode, message: error.message, retryable: error.retryable };
    } else {
      const mapped =
        error instanceof HeliusRingsError
          ? PORT_ERROR_FAILURE[error.code]
          : { code: "gateway_unavailable" as const, retryable: true };
      failure = {
        ...mapped,
        message: error instanceof Error ? error.message : "rings gateway failed",
      };
    }

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

  /**
   * Overlay allowlist symbol and decimals onto Photon balances. The SDK only
   * knows native SOL; every other mint arrives as UNKNOWN with a null scale.
   */
  private async labelBalances(balances: AssetBalance[]): Promise<AssetBalance[]> {
    if (balances.length === 0) return balances;
    const known = new Map(
      (await this.assets.listActive()).map((asset) => [asset.mint, asset] as const)
    );
    return balances.map((balance) => {
      const allowed = known.get(balance.mint);
      if (!allowed) return balance;
      return { ...balance, symbol: allowed.symbol, decimals: allowed.decimals };
    });
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
