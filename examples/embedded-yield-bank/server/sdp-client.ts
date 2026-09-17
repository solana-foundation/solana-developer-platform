import "server-only";

import type { YieldMovement, YieldPosition, YieldStrategy } from "../src/types";
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

interface DepositBuildResult {
  transaction?: BuiltTransaction & {
    amount: string;
    minSharesOut: string | null;
    strategy: Pick<
      YieldStrategy,
      "id" | "name" | "provider" | "providerReference" | "hostCluster"
    >;
  };
  requiresSeparateSwap?: true;
}

interface WithdrawalBuildResult {
  transaction: BuiltTransaction & {
    positionId: string;
    shares: string;
    minAmountOut: string | null;
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
    const data = await this.request<{ strategies: YieldStrategy[] }>(
      "/v1/earn/strategies"
    );
    return data.strategies;
  }

  async previewDeposit(strategyId: string, amount: string) {
    return this.request<{
      strategyId: string;
      sharesOut: string;
      shareDecimals: number;
      blockingIssues: Array<{ code: string; message: string }>;
    }>("/v1/earn/vault-deposit-previews", {
      method: "POST",
      body: { strategyId, amount },
    });
  }

  async buildDeposit(input: {
    strategyId: string;
    ownerAddress: string;
    feePayer?: string;
    amount: string;
    sourceTokenMint: string;
    minSharesOut?: string;
  }): Promise<BuiltTransaction> {
    const data = await this.request<DepositBuildResult>(
      "/v1/earn/external-wallet/deposit-transactions",
      { method: "POST", body: input }
    );
    if (data.requiresSeparateSwap || !data.transaction) {
      throw new Error(
        "The direct-deposit demo unexpectedly received a split-swap transaction"
      );
    }
    return data.transaction;
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

  async previewWithdrawal(positionId: string, shares: string) {
    return this.request<{
      positionId: string;
      assetsOut: string;
      assetDecimals: number;
      blockingIssues: Array<{ code: string; message: string }>;
    }>("/v1/earn/external-wallet/withdrawal-previews", {
      method: "POST",
      body: { positionId, shares },
    });
  }

  async buildWithdrawal(input: {
    positionId: string;
    shares: string;
    minAmountOut?: string;
    feePayer?: string;
  }): Promise<BuiltTransaction> {
    const data = await this.request<WithdrawalBuildResult>(
      "/v1/earn/external-wallet/withdrawal-transactions",
      { method: "POST", body: input }
    );
    return data.transaction;
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

  /** Open positions for the wallet. SDP omits a position once it is closed. */
  async listPositions(ownerAddress: string): Promise<YieldPosition[]> {
    return this.allowUnknownOwner(
      () =>
        this.collectPages<YieldPosition>(
          "/v1/earn/external-wallet/positions",
          "positions",
          ownerAddress
        ),
      []
    );
  }

  private async collectPages<T>(
    path: string,
    key: "movements" | "positions",
    ownerAddress: string
  ): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;

    while (true) {
      const query = new URLSearchParams({ ownerAddress, limit: "100" });
      if (cursor) query.set("before", cursor);
      const data = await this.request<Page & Record<typeof key, T[]>>(
        `${path}?${query}`
      );
      items.push(...data[key]);
      if (!data.hasMore) return items;
      if (!data.nextCursor || data.nextCursor === cursor) {
        throw new Error(`SDP ${key} cursor did not advance`);
      }
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
