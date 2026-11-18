import "server-only";

import {
  coreOperationSchema,
  type EarnOperation,
} from "../src/lib/core-operation";
import type { YieldPosition, YieldStrategy } from "../src/types";
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

  /** Read positions belonging to the configured owner address. */
  async listPositions(ownerAddress: string): Promise<YieldPosition[]> {
    const positions: YieldPosition[] = [];
    const seen = new Set<string>();
    let before: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({
        sourceType: "address",
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
