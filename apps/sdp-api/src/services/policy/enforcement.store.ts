import type {
  CreateApprovalRequestInput,
  CreateWalletOperationInput,
  EffectiveOperationPolicies,
  PolicyEnforcementStore,
  RecordPolicyEvaluationInput,
  VelocityCandidate,
  VelocityObservation,
  VelocityObservationKey,
} from "@sdp/policy";
import {
  IMPLICIT_DEFAULT_ALLOW_POLICY,
  parseIsoDurationMs,
  serializeVelocityObservationKey,
  velocityObservationKeys,
} from "@sdp/policy";
import {
  type EffectiveApiKeyPolicy,
  type PolicyCandidate,
  type PolicyEvaluation,
  type VelocityPolicyRule,
  WALLET_OPERATION_FAMILIES,
  WALLET_OPERATION_TYPES,
  type WalletOperationActor,
  type WalletOperationContext,
  type WalletOperationEnvelope,
  type WalletOperationProviderExtensions,
} from "@sdp/types";
import { z } from "zod";
import type { PolicyEvaluationRow, PolicyRepository, WalletOperationRow } from "@/db/repositories";
import { internalError } from "@/lib/errors";
import { assertTenantClaim, type TenantScope } from "@/lib/tenant-scope";
import { ApiKeyPolicyStore } from "./api-key-policy.store";
import { WalletPolicyStore } from "./wallet-policy.store";

/** Velocity window sums in flight at once, per operation evaluation. */
const VELOCITY_SUM_CONCURRENCY = 8;

/**
 * Run `task` over every item with at most `limit` promises in flight, keeping
 * result order. A plain `Promise.all` would open every aggregate at once and
 * pool-slam the database; the worker count, not the item count, bounds it.
 *
 * @param items - The items to map over.
 * @param limit - The maximum concurrent tasks.
 * @param task - The async task per item.
 * @returns Results in input order.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await task(items[index]);
      }
    })
  );
  return results;
}

/**
 * Postgres-backed {@link PolicyEnforcementStore}: wallet-operation lifecycle
 * rows plus effective-policy resolution composed from the wallet and API-key
 * scope stores.
 */
export class PostgresPolicyEnforcementStore implements PolicyEnforcementStore {
  private readonly walletPolicies: WalletPolicyStore;
  private readonly apiKeyPolicies: ApiKeyPolicyStore;

  constructor(
    private readonly repository: PolicyRepository,
    private readonly scope: TenantScope
  ) {
    this.walletPolicies = new WalletPolicyStore(repository);
    this.apiKeyPolicies = new ApiKeyPolicyStore(repository);
  }

  async createWalletOperation(input: CreateWalletOperationInput): Promise<WalletOperationEnvelope> {
    const row = await this.repository.createWalletOperation(input);
    if (!row) {
      throw internalError("Failed to record wallet operation");
    }
    return mapWalletOperation(row);
  }

  /**
   * Resolve both policy scopes for a candidate, letting a binding-supplied
   * wallet policy or custody wallet from the API-key scope take precedence.
   * The candidate's claimed tenant must match the store's bound scope, so a
   * mismatched candidate fails before any lookup runs.
   *
   * @param candidate - The candidate whose scopes resolve the policies.
   * @returns The effective wallet and API-key policies.
   */
  async loadEffectivePolicies(
    candidate: Pick<
      PolicyCandidate,
      "organizationId" | "projectId" | "apiKeyId" | "custodyWalletId"
    >
  ): Promise<EffectiveOperationPolicies> {
    assertTenantClaim(this.scope, candidate, "PolicyEnforcementStore.loadEffectivePolicies");
    const apiKeyScope =
      candidate.apiKeyId !== null && candidate.custodyWalletId !== null
        ? await this.apiKeyPolicies.resolveOperationScope({
            apiKeyId: candidate.apiKeyId,
            custodyWalletId: candidate.custodyWalletId,
          })
        : null;

    let apiKeyPolicy: EffectiveApiKeyPolicy | null = null;
    if (apiKeyScope !== null) {
      apiKeyPolicy = apiKeyScope.apiKeyPolicy;
    } else if (candidate.apiKeyId !== null) {
      apiKeyPolicy = await this.apiKeyPolicies.resolveOperationPolicyWithoutCustodyWallet(
        candidate.apiKeyId
      );
    }

    if (apiKeyScope !== null && apiKeyScope.walletPolicy !== null) {
      return { walletPolicy: apiKeyScope.walletPolicy, apiKeyPolicy };
    }

    const custodyWalletId =
      apiKeyScope !== null && apiKeyScope.custodyWalletId !== null
        ? apiKeyScope.custodyWalletId
        : candidate.custodyWalletId;
    const walletPolicy =
      custodyWalletId !== null
        ? await this.walletPolicies.resolveEffectiveWalletPolicy(custodyWalletId)
        : IMPLICIT_DEFAULT_ALLOW_POLICY;

    return {
      walletPolicy,
      apiKeyPolicy,
    };
  }

  /**
   * Measure the rolling totals the velocity rules in play need, one per rule
   * asset, de-duplicated by key. Totals come from `wallet_operations`, the
   * generic ledger every policy-gated route writes, so payments can adopt the
   * rule unchanged; failed, canceled and still-undecided (`created`) rows
   * never count, so concurrent contenders do not veto each other, and the
   * operation under evaluation (already inserted by enforcement) is excluded
   * by id as well.
   * A rule whose window does not parse gets no observation and reviews.
   * The per-key sums run in parallel under a small concurrency cap: the
   * schema permits enough unique keys that measuring them one await at a
   * time would dominate the operation's latency.
   *
   * @param candidate - The candidate whose scopes narrow the sums.
   * @param rules - The velocity rules across both effective policies.
   * @returns One observation per distinct key.
   */
  async loadVelocityObservations(
    candidate: VelocityCandidate,
    rules: VelocityPolicyRule[]
  ): Promise<VelocityObservation[]> {
    assertTenantClaim(this.scope, candidate, "PolicyEnforcementStore.loadVelocityObservations");
    const now = Date.now();
    const seen = new Set<string>();
    const pending: { key: VelocityObservationKey; since: string }[] = [];

    for (const rule of rules) {
      for (const key of velocityObservationKeys(rule)) {
        const serialized = serializeVelocityObservationKey(key);
        const windowMs = parseIsoDurationMs(key.window);
        if (windowMs === null || seen.has(serialized)) {
          continue;
        }
        seen.add(serialized);
        pending.push({ key, since: new Date(now - windowMs).toISOString() });
      }
    }

    const totals = await mapWithConcurrency(pending, VELOCITY_SUM_CONCURRENCY, ({ key, since }) =>
      this.repository.sumWalletOperationAmounts({
        organizationId: candidate.organizationId,
        projectId: candidate.projectId,
        scope: key.scope,
        custodyWalletId: candidate.custodyWalletId,
        walletId: candidate.walletId,
        apiKeyId: candidate.apiKeyId,
        asset: key.asset,
        operationTypes: key.operationTypes,
        since,
        excludeWalletOperationId: candidate.id ?? null,
      })
    );

    return pending.map(({ key }, index) => ({ ...key, total: totals[index] }));
  }

  async createApprovalRequest(input: CreateApprovalRequestInput) {
    const row = await this.repository.createApprovalRequest(input);
    if (!row) {
      throw internalError("Failed to create wallet operation approval request");
    }
    return { id: row.id, status: row.status };
  }

  async recordPolicyEvaluation(input: RecordPolicyEvaluationInput): Promise<PolicyEvaluation> {
    const row = await this.repository.createPolicyEvaluation({
      walletOperationId: input.walletOperationId,
      walletPolicyRevisionId: input.walletPolicyRevisionId,
      apiKeyPolicyRevisionId: input.apiKeyPolicyRevisionId,
      decision: input.decision,
      reasonCode: input.reasonCode,
      reason: input.reason,
      matchedRules: input.matchedRules.map((rule) => ({ ...rule })),
      evaluationContext: input.evaluationContext,
      requiresApproval: input.requiresApproval,
      approvalRequestId: input.approvalRequestId,
    });
    if (!row) {
      throw internalError("Failed to record wallet operation policy evaluation");
    }
    return mapPolicyEvaluation(row);
  }

  async updateWalletOperationStatus(
    walletOperationId: string,
    status: WalletOperationEnvelope["status"]
  ) {
    const updated = await this.repository.updateWalletOperationStatus(walletOperationId, status);
    if (!updated) {
      throw internalError("Failed to update wallet operation policy status");
    }
    return { status: updated.status, updatedAt: updated.updated_at };
  }

  async failApprovalRequest(
    operation: WalletOperationEnvelope,
    approvalRequestId: string
  ): Promise<void> {
    await this.repository.updateApprovalRequestStatus({
      organizationId: operation.organizationId,
      projectId: operation.projectId,
      approvalRequestId,
      status: "failed",
      operationStatus: "failed",
    });
  }
}

const walletOperationFamilySchema = z.enum(WALLET_OPERATION_FAMILIES);
const walletOperationTypeSchema = z.enum(WALLET_OPERATION_TYPES);

/**
 * Map a wallet-operation row onto its domain envelope. Envelopes feed the
 * policy engine, so the family and type must be live vocabulary; historical
 * rows carrying retired values fail loudly rather than reach evaluation.
 *
 * @param row - The persisted row.
 * @returns The domain envelope.
 */
function mapWalletOperation(row: WalletOperationRow): WalletOperationEnvelope {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    custodyWalletId: row.custody_wallet_id,
    walletId: row.wallet_id,
    apiKeyId: row.api_key_id,
    actor: getWalletOperationActor(row),
    source: row.source,
    operationFamily: walletOperationFamilySchema.parse(row.operation_family),
    operationType: walletOperationTypeSchema.parse(row.operation_type),
    asset: row.asset,
    amount: row.amount,
    destination: row.destination,
    context: getJsonObject(row.raw_payload.context),
    providerExtensions: getWalletOperationProviderExtensions(row.raw_payload),
    rawPayload: row.raw_payload,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getWalletOperationActor(row: WalletOperationRow): WalletOperationActor | null {
  if (Object.hasOwn(row.raw_payload, "actor")) {
    return isJsonObject(row.raw_payload.actor)
      ? (row.raw_payload.actor as WalletOperationActor)
      : null;
  }
  if (row.api_key_id) {
    return {
      type: "api_key",
      id: row.api_key_id,
      apiKeyId: row.api_key_id,
    };
  }
  return null;
}

function getWalletOperationProviderExtensions(
  rawPayload: Record<string, unknown>
): WalletOperationProviderExtensions {
  if (isJsonObject(rawPayload.providerExtensions)) {
    return rawPayload.providerExtensions;
  }
  if (typeof rawPayload.provider === "string") {
    return { provider: rawPayload.provider };
  }
  return {};
}

function getJsonObject(value: unknown): WalletOperationContext {
  return isJsonObject(value) ? value : {};
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Map a policy-evaluation row onto its domain shape.
 *
 * @param row - The persisted row.
 * @returns The domain evaluation.
 */
function mapPolicyEvaluation(row: PolicyEvaluationRow): PolicyEvaluation {
  return {
    id: row.id,
    walletOperationId: row.wallet_operation_id,
    walletPolicyRevisionId: row.wallet_policy_revision_id,
    apiKeyPolicyRevisionId: row.api_key_policy_revision_id,
    decision: row.decision,
    reasonCode: row.reason_code,
    reason: row.reason,
    matchedRules: row.matched_rules,
    evaluationContext: row.evaluation_context,
    requiresApproval: row.requires_approval,
    approvalRequestId: row.approval_request_id,
    createdAt: row.created_at,
  };
}
