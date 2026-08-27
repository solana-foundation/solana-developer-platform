import type { ZolanaClient } from "@heliuslabs/zolana/client";
import type { RuntimeHealth, RuntimeHealthStatus } from "@sdp/helius-rings";

/**
 * Probes are a health endpoint's dependency, not its workload: a slow answer is
 * a red answer, because the caller is a dashboard waiting on it.
 */
const DEFAULT_TIMEOUT_MS = 2_000;

/** Photon's liveness method. Not a Zolana client call, so it goes over raw JSON-RPC. */
const INDEXER_HEALTH_METHOD = "getIndexerHealth";

export interface RingsHealthInput {
  /**
   * Only `getLatestBlockhash` is used. Passed as a client rather than a URL
   * because the URL carries the Helius API key and must not be handled here.
   */
  readonly client: Pick<ZolanaClient, "getLatestBlockhash">;
  readonly indexerUrl: string;
  readonly proverUrl: string;
  /** Per-probe budget. Defaults to two seconds. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

interface ProbeOutcome {
  readonly status: RuntimeHealthStatus;
  /** Absent when green. Never carries a URL or an upstream error message. */
  readonly reason?: string;
}

/**
 * Why probe failures are classified rather than reported verbatim: the RPC URL
 * embeds an API key and upstream error messages routinely quote the URL they
 * failed on, so forwarding a message would publish the key through the health
 * endpoint. Callers get a fixed reason instead.
 */
function classify(error: unknown): ProbeOutcome {
  if (error instanceof Error && error.name === "TimeoutError") {
    return { status: "red", reason: "timed out" };
  }

  return { status: "red", reason: "unreachable" };
}

/**
 * Rejects with a `TimeoutError` when `work` outlives the budget.
 *
 * Exported so the gateway can hold client construction to the same budget as
 * the probes it precedes; a health answer is only bounded if every step is.
 */
export function withHealthTimeout<T>(work: Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  return withTimeout(work, timeoutMs);
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`probe exceeded ${timeoutMs}ms`);
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);

    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function probeRpc(input: RingsHealthInput, timeoutMs: number): Promise<ProbeOutcome> {
  try {
    // The signal is what actually cancels the request. `withTimeout` still
    // wraps it because the SDK is alpha and this is a health endpoint: if the
    // signal were ever ignored, the dashboard would hang on the one call it
    // made to find out whether things are hanging.
    await withTimeout(
      input.client.getLatestBlockhash({ signal: AbortSignal.timeout(timeoutMs) }),
      timeoutMs
    );
    return { status: "green" };
  } catch (error) {
    return classify(error);
  }
}

async function probePhoton(input: RingsHealthInput, timeoutMs: number): Promise<ProbeOutcome> {
  const send = input.fetch ?? globalThis.fetch;

  try {
    // Wrapped for the same reason as the RPC probe, and covering the body read
    // as well as the request: the budget has to bound the whole probe, not just
    // the part a caller-supplied `fetch` chooses to honour the signal for.
    return await withTimeout(
      (async () => {
        const response = await send(input.indexerUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: INDEXER_HEALTH_METHOD }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          return { status: "red", reason: `http ${response.status}` } as const;
        }

        const body = (await response.json()) as { result?: unknown; error?: unknown };
        if (body.error !== undefined) {
          // Answering at all means the indexer is up; its state is what is off.
          return { status: "amber", reason: "reported unhealthy" } as const;
        }

        return body.result === "ok"
          ? ({ status: "green" } as const)
          : ({ status: "amber", reason: "not ok" } as const);
      })(),
      timeoutMs
    );
  } catch (error) {
    return classify(error);
  }
}

/**
 * Resolved relative to the configured path, not from the host root, so a prover
 * mounted behind a prefix keeps it. `new URL("/health", ...)` would discard it.
 */
function proverHealthUrl(proverUrl: string): URL {
  return new URL("health", proverUrl.endsWith("/") ? proverUrl : `${proverUrl}/`);
}

async function probeProver(input: RingsHealthInput, timeoutMs: number): Promise<ProbeOutcome> {
  const send = input.fetch ?? globalThis.fetch;

  try {
    const response = await withTimeout(
      send(proverHealthUrl(input.proverUrl), {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
      }),
      timeoutMs
    );

    return response.ok ? { status: "green" } : { status: "red", reason: `http ${response.status}` };
  } catch (error) {
    return classify(error);
  }
}

/**
 * Reports one status per upstream the shielded flows depend on.
 *
 * `gateway` is always green here: unlike the sidecar design this replaced, the
 * adapter runs in this process, so there is no separate service whose liveness
 * could differ from the caller's. It stays on the response because the
 * dashboard and the ops runbook are written against the four components.
 */
export async function probeRingsHealth(input: RingsHealthInput): Promise<RuntimeHealth> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const [rpc, photon, prover] = await Promise.all([
    probeRpc(input, timeoutMs),
    probePhoton(input, timeoutMs),
    probeProver(input, timeoutMs),
  ]);

  const detail: Record<string, string> = {};
  for (const [component, outcome] of [
    ["rpc", rpc],
    ["photon", photon],
    ["prover", prover],
  ] as const) {
    if (outcome.reason !== undefined) {
      detail[component] = outcome.reason;
    }
  }

  const health: RuntimeHealth = {
    rpc: rpc.status,
    photon: photon.status,
    prover: prover.status,
    gateway: "green",
  };

  return Object.keys(detail).length === 0 ? health : { ...health, detail };
}
