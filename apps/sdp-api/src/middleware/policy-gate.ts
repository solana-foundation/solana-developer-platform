import type { WalletOperationPolicyEnforcement } from "@sdp/policy";
import type { PolicyCandidate } from "@sdp/types";
import type { Context, MiddlewareHandler, Next } from "hono";
import { internalError } from "@/lib/errors";
import { success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import {
  approvedWalletOperationAttemptId,
  approvedWalletOperationId,
  walletOperationExecutionRequest,
} from "@/services/policy/approved-operation-replay";
import {
  dryRunPolicyCandidate,
  UNGOVERNED_POLICY_DRY_RUN_RESULT,
} from "@/services/policy/candidate-evaluation.service";
import { enforceWalletOperationPolicy } from "@/services/policy/enforcement.service";
import type { Env } from "@/types/env";
import { isDryRunRequest } from "./dry-run";
import { IDEMPOTENCY_KEY_HEADER } from "./idempotency-key";

type GateContext = Context<{ Bindings: Env }>;

export interface PolicyGateExtraction {
  candidate: PolicyCandidate | null;
  /** Per-leg evaluation views of a multi-leg operation (batch recipients); empty otherwise. */
  legs: PolicyCandidate[];
  body: Record<string, unknown>;
  resolved: unknown;
  rawPayload: Record<string, unknown>;
  /** HOO-1023: remove with K2 rollback support. */
  executionRequestBody?: Record<string, unknown>;
  /** Route-owned canonical key to persist on the policy operation. */
  idempotencyKey: string | null;
}

export interface PolicyGateConfig {
  extract: (c: GateContext) => Promise<PolicyGateExtraction>;
  findIdempotentKeyReplay?: (
    c: GateContext,
    extraction: PolicyGateExtraction,
    idempotencyKey: string
  ) => Promise<Response | null>;
  beforeEnforce?: (c: GateContext, extraction: PolicyGateExtraction) => Promise<void>;
}

export interface PolicyGateContext<
  TBody = unknown,
  TResolved = unknown,
  TEnforcement extends WalletOperationPolicyEnforcement | null = WalletOperationPolicyEnforcement,
> {
  body: TBody;
  candidate: PolicyCandidate | null;
  resolved: TResolved;
  enforcement: TEnforcement;
}

/**
 * Gate a route on wallet-operation policy. The route owns extraction and any
 * new-work admission hook; the gate owns the three generic exits:
 *
 * 1. `Dry-Run: true` → evaluate without writes and respond 200; the handler
 *    never runs, so a dry-run provably cannot persist or execute anything.
 * 2. Non-allow decision → enforcement records the operation, approval
 *    request, and evaluation, then throws the gated-response error (202
 *    SIGNING_PENDING or 403 FORBIDDEN).
 * 3. Allow, or an approved-operation replay → the validated body, resolved
 *    resources, and enforcement land on the context for the handler.
 *
 * The gate runs five explicit steps, first exit wins:
 *
 * 1. `extract` — always; one job: request → candidate + cargo.
 * 2. `Dry-Run: true` → respond 200 with the verdict; advisory, so the
 *    candidate is evaluated as a new intent even when an Idempotency-Key
 *    matches a recorded outcome.
 * 3. Idempotency-Key present and the route supplied `findIdempotentKeyReplay`
 *    → a matched recorded outcome returns verbatim; policy never runs and the
 *    handler is never invoked, because a replayed request is not a new intent.
 * 4. `beforeEnforce` → admit genuinely new work after advisory and completed
 *    replay exits, when the route supplied an admission hook.
 * 5. Enforce → non-allow throws (403 deny / 202 approval-pending); allow and
 *    approved replays fall through to the handler with the gate context set.
 *
 * The gate stores the replay envelope on the operation uniformly, so routes
 * no longer hand-build enforcement inputs.
 *
 * An extraction may return a null candidate when the operation resolves no
 * custody wallet and is therefore ungoverned: dry-run answers allow with no
 * criteria, enforcement is skipped, and the handler receives a null
 * enforcement.
 *
 * @param config - The route's extractor and optional idempotent-replay finder.
 * @returns Hono middleware enforcing policy ahead of the handler.
 */
export function policyGate(config: PolicyGateConfig): MiddlewareHandler<{ Bindings: Env }> {
  return async (c: GateContext, next: Next) => {
    const extraction = await config.extract(c);
    const {
      candidate,
      legs,
      body,
      resolved,
      rawPayload,
      idempotencyKey: operationIdempotencyKey,
    } = extraction;
    const scope = getRequestTenantScope(c);

    if (isDryRunRequest(c)) {
      return success(
        c,
        candidate === null
          ? UNGOVERNED_POLICY_DRY_RUN_RESULT
          : await dryRunPolicyCandidate(c.env, scope, candidate, legs)
      );
    }

    const idempotencyKey = c.req.header(IDEMPOTENCY_KEY_HEADER);
    if (config.findIdempotentKeyReplay !== undefined && idempotencyKey !== undefined) {
      const replayed = await config.findIdempotentKeyReplay(c, extraction, idempotencyKey);
      if (replayed !== null) {
        return replayed;
      }
    }

    await config.beforeEnforce?.(c, extraction);

    if (candidate === null) {
      c.set("policyGate", { body, candidate: null, resolved, enforcement: null });
      return next();
    }

    const enforcement = await enforceWalletOperationPolicy(
      c.env,
      scope,
      {
        ...candidate,
        legs,
        rawPayload: {
          ...rawPayload,
          executionRequest: walletOperationExecutionRequest(
            c,
            extraction.executionRequestBody ?? body
          ),
        },
        idempotencyKey: operationIdempotencyKey,
      },
      approvedWalletOperationId(c),
      approvedWalletOperationAttemptId(c)
    );

    c.set("policyGate", { body, candidate, resolved, enforcement });
    return next();
  };
}

/**
 * Read the policy-gate context a `policyGate` middleware stashed for the
 * handler, failing loudly when the route is not gated.
 *
 * @param c - Request context.
 * @returns The validated body, resolved resources, candidate, and enforcement.
 */
export function getPolicyGateContext<
  TBody,
  TResolved,
  TEnforcement extends WalletOperationPolicyEnforcement | null = WalletOperationPolicyEnforcement,
>(c: GateContext): PolicyGateContext<TBody, TResolved, TEnforcement> {
  const context = c.get("policyGate");
  if (context === undefined) {
    throw internalError("Policy gate context is unavailable");
  }
  return context as unknown as PolicyGateContext<TBody, TResolved, TEnforcement>;
}
