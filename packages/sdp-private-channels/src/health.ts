import { type ProbeTransport, truncateProbeDetail } from "./transport";
import type { GatewayHealth } from "./types";
import { normalizeHttpBase } from "./url";

const PROBE_TIMEOUT_MS = 5000;

export type GatewayHealthResult =
  | {
      status: "ready";
      latencyMs: number;
      health: GatewayHealth;
      ready: GatewayHealth;
    }
  | {
      status: "degraded";
      latencyMs: number;
      health: GatewayHealth;
      ready: GatewayHealth;
      reason: string;
    }
  | {
      status: "unreachable";
      latencyMs: number;
      error: string;
      health?: GatewayHealth;
      ready?: GatewayHealth;
    };

/**
 * One endpoint's outcome. `reason` is a short string lifted out of the body,
 * never the body: the caller renders a status badge, and relaying an arbitrary
 * upstream response through it would turn the probe into a read primitive for
 * whatever the gateway URL points at.
 */
interface ProbeOutcome {
  health: GatewayHealth;
  reason: string | null;
}

/** `reason`, else `status`, from a JSON body. Anything else yields nothing. */
function extractReason(text: string): string | null {
  if (!text) return null;

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON bodies carry no field we are willing to echo.
    return null;
  }
  if (!body || typeof body !== "object") return null;

  const record = body as Record<string, unknown>;
  for (const key of ["reason", "status"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return truncateProbeDetail(value);
  }
  return null;
}

async function probe(transport: ProbeTransport, url: string): Promise<ProbeOutcome> {
  const res = await transport({
    url,
    method: "GET",
    headers: { Accept: "application/json", "Cache-Control": "no-store" },
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return {
    health: { status: res.status, ok: res.ok },
    reason: extractReason(res.text),
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // `AbortSignal.timeout` rejects with a `TimeoutError`; keep `AbortError` too.
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return `Timed out after ${PROBE_TIMEOUT_MS} ms.`;
    }
    return truncateProbeDetail(error.message) || "Request failed.";
  }
  return "Request failed.";
}

/**
 * Probe the SPC gateway's `/health` and `/ready` endpoints. Pure: no side effects
 * beyond the two HTTP requests, which are issued by the caller's `transport` —
 * see `./transport` for why this module never dials the gateway itself.
 */
export async function probeGatewayHealth(
  gatewayUrl: string,
  transport: ProbeTransport
): Promise<GatewayHealthResult> {
  const startedAt = Date.now();
  const normalized = normalizeHttpBase(gatewayUrl, "Gateway URL");
  if ("error" in normalized) {
    return { status: "unreachable", latencyMs: 0, error: normalized.error };
  }

  const { base } = normalized;
  const [healthResult, readyResult] = await Promise.allSettled([
    probe(transport, `${base}/health`),
    probe(transport, `${base}/ready`),
  ]);
  const latencyMs = Date.now() - startedAt;
  const readyHealth = readyResult.status === "fulfilled" ? readyResult.value.health : undefined;

  if (healthResult.status === "rejected") {
    return {
      status: "unreachable",
      latencyMs,
      error: toErrorMessage(healthResult.reason),
      ready: readyHealth,
    };
  }

  const health = healthResult.value.health;

  if (!health.ok) {
    return {
      status: "unreachable",
      latencyMs,
      error: `GET ${base}/health returned ${health.status}.`,
      health,
      ready: readyHealth,
    };
  }

  if (readyResult.status === "rejected") {
    return {
      status: "degraded",
      latencyMs,
      health,
      ready: { status: 0, ok: false },
      reason: `GET ${base}/ready failed: ${toErrorMessage(readyResult.reason)}`,
    };
  }

  const ready = readyResult.value;
  if (!ready.health.ok) {
    return {
      status: "degraded",
      latencyMs,
      health,
      ready: ready.health,
      reason: ready.reason ?? "Gateway reported degraded state.",
    };
  }

  return { status: "ready", latencyMs, health, ready: ready.health };
}
