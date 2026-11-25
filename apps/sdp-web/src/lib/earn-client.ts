import type {
  EarnCorePosition,
  EarnDiscoveryResponse,
  EarnPositionsResponse,
} from "@sdp/types/earn-core";
import {
  type Operation,
  type OperationIntent,
  type OperationStatusFilter,
  operationResponseSchema,
  operationsPageSchema,
  type RefreshOperation,
  type SubmitOperation,
} from "@sdp/types/operations";
import type { SolanaCluster } from "@sdp/types/well-known-tokens";
import {
  earnCorePositionSchema,
  earnDiscoveryResponseSchema,
  earnPositionsResponseSchema,
} from "./earn-response-schemas";

/** Transport owns authentication and project scope; the client never sees credentials. */
export type EarnTransport = (path: string, init?: RequestInit) => Promise<Response>;

/** Filters refer to strategies, while admission remains a server decision. */
export interface EarnDiscoveryQuery {
  id?: string;
  provider?: string;
  depositMint?: string;
  sourceKind?: string;
  apyType?: string;
  minApy?: string;
  maxApy?: string;
  liquidityTerm?: string;
  cluster?: SolanaCluster;
  page?: number;
  pageSize?: number;
}

/** A unified holding read can include project aggregates without a request per owner. */
export interface EarnPositionsQuery {
  walletId?: string;
  ownerAddress?: string;
  sourceType?: "wallet" | "address";
  discover?: boolean;
  limit?: number;
  before?: string;
  afterMovementIds?: string;
  includeSummary?: boolean;
  includeOwnerAddresses?: boolean;
  includePositions?: boolean;
}

/** A single holding uses the same movement-verification floor as the list. */
export type EarnPositionQuery = Pick<EarnPositionsQuery, "afterMovementIds">;

/** Recovery filters are independent of the initiating dashboard surface. */
export interface EarnOperationsQuery {
  operationIds?: string;
  kind?: Operation["kind"];
  status?: OperationStatusFilter;
  ownerAddress?: string;
  walletId?: string;
  positionId?: string;
  limit?: number;
  cursor?: string;
}

/** An HTTP failure preserves its status and retry hint for callers' recovery policy. */
export class EarnApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "EarnApiError";
  }
}

function queryPath(path: string, query: object): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) params.set(name, String(value));
  }
  return params.size === 0 ? path : `${path}?${params}`;
}

function errorDetails(body: unknown): { code?: string; message?: string } {
  if (!body || typeof body !== "object" || !("error" in body)) return {};
  const error = body.error;
  if (!error || typeof error !== "object") return {};
  return {
    code: "code" in error && typeof error.code === "string" ? error.code : undefined,
    message: "message" in error && typeof error.message === "string" ? error.message : undefined,
  };
}

/**
 * The dashboard's typed Earn contract, shared by its data hooks and action dialogs.
 * Preparing returns terms; callers submit the advertised action after review.
 */
export function createEarnClient(transport: EarnTransport) {
  async function read(path: string, init?: RequestInit): Promise<unknown> {
    const response = await transport(path, init);
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = errorDetails(body);
      const retry = Number(response.headers.get("Retry-After"));
      throw new EarnApiError(
        response.status,
        error.code,
        error.message ?? `SDP request failed (${response.status})`,
        Number.isFinite(retry) && retry > 0 ? retry : undefined
      );
    }
    if (!body || typeof body !== "object" || !("data" in body)) {
      throw new Error("Invalid SDP response envelope");
    }
    return body.data;
  }

  async function mutate(
    path: string,
    body: unknown,
    idempotencyKey: string,
    signal?: AbortSignal
  ): Promise<Operation> {
    if (!idempotencyKey) throw new Error("An idempotency key is required");
    const data = await read(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
      signal,
    });
    return operationResponseSchema.parse(data).operation;
  }

  function operationPath(id: string, action = ""): string {
    return `/v1/operations/${encodeURIComponent(id)}${action}`;
  }

  return {
    async discovery(
      query: EarnDiscoveryQuery = {},
      signal?: AbortSignal
    ): Promise<EarnDiscoveryResponse> {
      return earnDiscoveryResponseSchema.parse(
        await read(queryPath("/v1/earn/discovery", query), { signal })
      );
    },
    async positions(
      query: EarnPositionsQuery = {},
      signal?: AbortSignal
    ): Promise<EarnPositionsResponse> {
      return earnPositionsResponseSchema.parse(
        await read(queryPath("/v1/earn/positions", query), { signal })
      );
    },
    async position(
      id: string,
      query: EarnPositionQuery = {},
      signal?: AbortSignal
    ): Promise<EarnCorePosition> {
      return earnCorePositionSchema.parse(
        await read(queryPath(`/v1/earn/positions/${encodeURIComponent(id)}`, query), { signal })
      );
    },
    deposit(
      intent: Omit<Extract<OperationIntent, { kind: "earn.deposit" }>, "kind">,
      idempotencyKey: string,
      signal?: AbortSignal
    ) {
      return mutate("/v1/earn/deposit", intent, idempotencyKey, signal);
    },
    withdraw(
      intent: Omit<Extract<OperationIntent, { kind: "earn.withdraw" }>, "kind">,
      idempotencyKey: string,
      signal?: AbortSignal
    ) {
      return mutate("/v1/earn/withdraw", intent, idempotencyKey, signal);
    },
    async operations(query: EarnOperationsQuery = {}, signal?: AbortSignal) {
      return operationsPageSchema.parse(await read(queryPath("/v1/operations", query), { signal }));
    },
    async operation(id: string, signal?: AbortSignal): Promise<Operation> {
      return operationResponseSchema.parse(await read(operationPath(id), { signal })).operation;
    },
    submit(id: string, action: SubmitOperation, idempotencyKey: string, signal?: AbortSignal) {
      return mutate(operationPath(id, "/submit"), action, idempotencyKey, signal);
    },
    refresh(id: string, action: RefreshOperation, idempotencyKey: string, signal?: AbortSignal) {
      return mutate(operationPath(id, "/refresh"), action, idempotencyKey, signal);
    },
    cancel(id: string, idempotencyKey: string, signal?: AbortSignal) {
      return mutate(operationPath(id, "/cancel"), {}, idempotencyKey, signal);
    },
  };
}

/** The client has no provider-specific signing or financial state machine. */
export type EarnClient = ReturnType<typeof createEarnClient>;
