import "server-only";

import {
  coreOperationSchema,
  type EarnOperation,
} from "../src/lib/core-operation";
import type {
  YieldMovement,
  YieldPosition,
  YieldStrategy,
  YieldWithdrawalRequest,
} from "../src/types";
import type { DemoConfig } from "./env";

interface SdpErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
  };
}

interface Page {
  hasMore: boolean;
  nextCursor: string | null;
}

export interface BuiltTransaction {
  transactionId: string;
  transaction: string;
  lastValidBlockHeight: string;
  ownerAddress: string;
  feePayer?: string;
  provider: string;
}

interface QueuedWithdrawalBuildResult {
  transaction: BuiltTransaction & {
    positionId: string;
    action: "request" | "cancel";
    requestAddress: string;
    withdrawalRequestId?: string;
  };
}

export class SdpApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /** Seconds to wait before retrying, when SDP says so (429). */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: number,
    code: string | undefined,
    message: string,
    retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "SdpApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Minimal server-side Embedded Yield client.
 *
 * The API key never crosses this boundary. Methods mirror the public guide so
 * this folder can be lifted into a partner BFF without translating concepts.
 */
export class EmbeddedYieldClient {
  private readonly config: DemoConfig;

  constructor(config: DemoConfig) {
    this.config = config;
  }

  async listStrategies(): Promise<YieldStrategy[]> {
    const strategies: YieldStrategy[] = [];
    const seenStrategyIds = new Set<string>();
    const pageSize = 100;
    const maximumPages = 100;
    for (let page = 1; page <= maximumPages; page += 1) {
      const query = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      const data = await this.request<{
        strategies: YieldStrategy[];
        total: number;
      }>(`/v1/earn/discovery?${query}`);
      let added = 0;
      for (const strategy of data.strategies) {
        if (seenStrategyIds.has(strategy.id)) continue;
        seenStrategyIds.add(strategy.id);
        strategies.push(strategy);
        added += 1;
      }
      if (strategies.length >= data.total) return strategies;
      if (added === 0) {
        throw new Error(
          "SDP strategy pagination made no progress before the reported total"
        );
      }
    }
    throw new Error(
      `SDP strategy pagination exceeded ${maximumPages} pages before the reported total`
    );
  }

  async submitDeposit(
    transactionId: string,
    signedTransaction: string,
    idempotencyKey: string
  ): Promise<YieldMovement> {
    const data = await this.request<{ deposit: YieldMovement }>(
      "/v1/earn/external-wallet/deposits",
      {
        method: "POST",
        body: { transactionId, signedTransaction },
        idempotencyKey,
      }
    );
    return data.deposit;
  }

  async submitWithdrawal(
    transactionId: string,
    signedTransaction: string,
    idempotencyKey: string
  ): Promise<YieldMovement> {
    const data = await this.request<{ withdrawal: YieldMovement }>(
      "/v1/earn/external-wallet/withdrawals",
      {
        method: "POST",
        body: { transactionId, signedTransaction },
        idempotencyKey,
      }
    );
    return data.withdrawal;
  }

  async submitQueuedWithdrawalRequest(
    transactionId: string,
    signedTransaction: string,
    idempotencyKey: string
  ): Promise<YieldWithdrawalRequest> {
    const data = await this.request<{
      withdrawalRequest: YieldWithdrawalRequest;
    }>("/v1/earn/external-wallet/withdrawal-requests", {
      method: "POST",
      body: { transactionId, signedTransaction },
      idempotencyKey,
    });
    return data.withdrawalRequest;
  }

  async listPendingWithdrawalRequests(
    ownerAddress: string
  ): Promise<YieldWithdrawalRequest[]> {
    return this.allowUnknownOwner(
      () =>
        this.collectPages<YieldWithdrawalRequest>(
          "/v1/earn/external-wallet/withdrawal-requests",
          "withdrawalRequests",
          ownerAddress,
          { settled: "false" }
        ),
      []
    );
  }

  async buildQueuedWithdrawalCancellation(input: {
    withdrawalRequestId: string;
    feePayer?: string;
  }): Promise<QueuedWithdrawalBuildResult["transaction"]> {
    const data = await this.request<QueuedWithdrawalBuildResult>(
      "/v1/earn/external-wallet/withdrawal-request-cancel-transactions",
      { method: "POST", body: input }
    );
    return data.transaction;
  }

  async submitQueuedWithdrawalCancellation(
    transactionId: string,
    signedTransaction: string,
    idempotencyKey: string
  ): Promise<YieldWithdrawalRequest> {
    const data = await this.request<{
      withdrawalRequest: YieldWithdrawalRequest;
    }>("/v1/earn/external-wallet/withdrawal-request-cancellations", {
      method: "POST",
      body: { transactionId, signedTransaction },
      idempotencyKey,
    });
    return data.withdrawalRequest;
  }

  /** Every recorded movement for the wallet, newest first, across all pages. */
  async listMovements(ownerAddress: string): Promise<YieldMovement[]> {
    return this.allowUnknownOwner(
      () =>
        this.collectPages<YieldMovement>(
          "/v1/earn/external-wallet/movements",
          "movements",
          ownerAddress
        ),
      []
    );
  }

  /** Read one movement through SDP's chain-aware detail endpoint. */
  async getMovement(movementId: string): Promise<YieldMovement> {
    const data = await this.request<{ movement: YieldMovement }>(
      `/v1/earn/external-wallet/movements/${encodeURIComponent(movementId)}`
    );
    return data.movement;
  }

  /** Core position reads preserve external identity without custody registration. */
  async listPositions(ownerAddress: string): Promise<YieldPosition[]> {
    const positions: YieldPosition[] = [];
    const seen = new Set<string>();
    let before: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({
        ownerKind: "external",
        ownerAddress,
        discover: "true",
        limit: "100",
      });
      if (before) query.set("before", before);
      const data = await this.request<
        Page & {
          positions: Array<
            Omit<YieldPosition, "ownerAddress"> & {
              source: { ownerAddress?: string };
            }
          >;
        }
      >(`/v1/earn/positions?${query}`);
      for (const position of data.positions) {
        if (position.source.ownerAddress !== ownerAddress)
          throw new Error("Invalid position owner");
        positions.push({ ...position, ownerAddress });
      }
      if (!data.hasMore) return positions;
      if (!data.nextCursor || seen.has(data.nextCursor))
        throw new Error("SDP position cursor did not advance");
      seen.add(data.nextCursor);
      before = data.nextCursor;
    }
    throw new Error("SDP position pagination exceeded its safety limit");
  }

  /** Preparation builds terms and unsigned bytes without asking a custodian to sign. */
  async prepareDeposit(
    input: {
      strategyId: string;
      source: { ownerAddress: string };
      amount: { mint: string; value: string };
      slippageBps?: number;
      feePayer?: string;
    },
    idempotencyKey: string
  ): Promise<EarnOperation> {
    const data = await this.request<{ operation: unknown }>(
      "/v1/earn/deposit",
      {
        method: "POST",
        body: input,
        idempotencyKey,
      }
    );
    return coreOperationSchema.parse(data.operation);
  }

  async prepareWithdrawal(
    input: {
      positionId: string;
      amount: { kind: "token"; mint: string; value: string };
      slippageBps?: number;
      feePayer?: string;
    },
    idempotencyKey: string
  ): Promise<EarnOperation> {
    const data = await this.request<{ operation: unknown }>(
      "/v1/earn/withdraw",
      {
        method: "POST",
        body: input,
        idempotencyKey,
      }
    );
    return coreOperationSchema.parse(data.operation);
  }

  async getOperation(id: string): Promise<EarnOperation> {
    const data = await this.request<{ operation: unknown }>(
      `/v1/operations/${encodeURIComponent(id)}`
    );
    return coreOperationSchema.parse(data.operation);
  }

  async listOperations(ownerAddress: string): Promise<EarnOperation[]> {
    const operations: EarnOperation[] = [];
    const seen = new Set<string>();
    let before: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({ ownerAddress, limit: "100" });
      if (before) query.set("cursor", before);
      const data = await this.request<{
        operations: unknown[];
        nextCursor: string | null;
      }>(`/v1/operations?${query}`);
      operations.push(
        ...data.operations.map((operation) =>
          coreOperationSchema.parse(operation)
        )
      );
      if (data.nextCursor === null) return operations;
      if (seen.has(data.nextCursor))
        throw new Error("SDP operation cursor did not advance");
      seen.add(data.nextCursor);
      before = data.nextCursor;
    }
    throw new Error("SDP operation pagination exceeded its safety limit");
  }

  async executeOperation(
    id: string,
    action: {
      actionId: string;
      version: number;
      signedTransaction?: string;
      optionId?: string;
    },
    idempotencyKey: string
  ): Promise<EarnOperation> {
    const data = await this.request<{ operation: unknown }>(
      `/v1/operations/${encodeURIComponent(id)}/execute`,
      {
        method: "POST",
        body: action,
        idempotencyKey,
      }
    );
    return coreOperationSchema.parse(data.operation);
  }

  async refreshOperation(
    id: string,
    idempotencyKey: string
  ): Promise<EarnOperation> {
    const data = await this.request<{ operation: unknown }>(
      `/v1/operations/${encodeURIComponent(id)}/refresh`,
      { method: "POST", body: {}, idempotencyKey }
    );
    return coreOperationSchema.parse(data.operation);
  }

  async cancelOperation(
    id: string,
    idempotencyKey: string
  ): Promise<EarnOperation> {
    const data = await this.request<{ operation: unknown }>(
      `/v1/operations/${encodeURIComponent(id)}/cancel`,
      {
        method: "POST",
        body: {},
        idempotencyKey,
      }
    );
    return coreOperationSchema.parse(data.operation);
  }

  private async collectPages<T>(
    path: string,
    key: "movements" | "positions" | "withdrawalRequests",
    ownerAddress: string,
    filters: Record<string, string> = {}
  ): Promise<T[]> {
    const items: T[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    while (true) {
      const query = new URLSearchParams({
        ownerAddress,
        limit: "100",
        ...filters,
      });
      if (cursor) query.set("before", cursor);
      const data = await this.request<Page & Record<typeof key, T[]>>(
        `${path}?${query}`
      );
      items.push(...data[key]);
      if (!data.hasMore) return items;
      if (!data.nextCursor || seenCursors.has(data.nextCursor)) {
        throw new Error(`SDP ${key} cursor did not advance`);
      }
      seenCursors.add(data.nextCursor);
      cursor = data.nextCursor;
    }
  }

  private async allowUnknownOwner<T>(
    load: () => Promise<T>,
    empty: T
  ): Promise<T> {
    try {
      return await load();
    } catch (error) {
      if (error instanceof SdpApiError && error.status === 404) return empty;
      throw error;
    }
  }

  private async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      idempotencyKey?: string;
    } = {}
  ): Promise<T> {
    const headers = new Headers({
      Authorization: `Bearer ${this.config.SDP_API_KEY}`,
      Accept: "application/json",
    });
    if (options.body !== undefined)
      headers.set("Content-Type", "application/json");
    if (options.idempotencyKey)
      headers.set("Idempotency-Key", options.idempotencyKey);
    const response = await fetch(
      `${this.config.SDP_API_BASE_URL.replace(/\/$/, "")}${path}`,
      {
        method: options.method ?? "GET",
        headers,
        cache: "no-store",
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      }
    );
    const payload = (await response.json().catch(() => null)) as
      | ({ data?: T } & SdpErrorEnvelope)
      | null;

    if (!response.ok) {
      const code = payload?.error?.code;
      const message =
        payload?.error?.message ?? `SDP request failed with ${response.status}`;
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new SdpApiError(
        response.status,
        code,
        message,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined
      );
    }
    if (!payload || payload.data === undefined)
      throw new Error("SDP returned an invalid response");
    return payload.data;
  }
}
