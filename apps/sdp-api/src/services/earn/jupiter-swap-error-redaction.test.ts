import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { WELL_KNOWN_TOKENS } from "@sdp/types";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import { fetchJupiterSwapLeg, fetchJupiterSwapQuote } from "./jupiter-swap.service";
import { createVaultDeadline } from "./vault-deadline";

/**
 * Regression test for SOLA9-506: a provider-selected `error` string must never
 * cross the Jupiter adapter's boundaries uncontained.
 *
 * The insecure adapter forwarded ANY nonblank upstream `error` string into (a)
 * the client-facing `AppError` message on 4xx and (b) the structured telemetry
 * log on 429/5xx, without the shared provider error extractor, a length bound,
 * or the telemetry scrubber. An opaque serialized provider body therefore
 * reached the HTTP caller verbatim and unbounded log lines.
 *
 * The secure contract asserted here:
 * - 4xx: a stable, client-facing refusal that carries no provider text;
 * - 429/5xx: telemetry detail is bounded and scrubbed — no unbounded bodies,
 *   no credential-shaped material from the provider body.
 *
 * The local HTTP server is a controlled provider boundary, not a stub of the
 * target code: the real fetchJupiterSwapLeg/fetchJupiterSwapQuote functions
 * perform an ordinary network fetch and process the server's HTTP response.
 */

const USDC = WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address;
const PYUSD = WELL_KNOWN_TOKENS.PYUSD.mints["mainnet-beta"].address;
const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OPAQUE_MARKER = "CUSTOMER-PII-12345";
/** The synthetic exploit body from the finding: opaque serialized container. */
const PROVIDER_BODY = `{"providerBody":{"identity":{"opaque":"${OPAQUE_MARKER}"}}}`;
/**
 * A longer provider body (well past any diagnostic bound) that also carries a
 * credential-shaped field placed inside the retained window, so the bound and
 * the scrubber are exercised independently: truncation alone cannot account
 * for the credential's absence from the logged detail.
 */
const TELEMETRY_BODY = `route rebuild failed after {"x-api-key":"sk_live_supersecret"} ${"A".repeat(600)} ${PROVIDER_BODY}`;

let server: Server;
let baseUrl: string;
let upstreamStatus = 400;
let upstreamBody = PROVIDER_BODY;

function swapEnv(): Env {
  return {
    ...env,
    JUPITER_SWAP_API_URL: baseUrl,
    JUPITER_SWAP_API_KEY: "synthetic-test-provider-key",
  } as Env;
}

function legRequest() {
  return {
    inputMint: USDC,
    outputMint: PYUSD,
    sourceAmount: "25",
    owner: OWNER,
    slippageBps: 50,
  };
}

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.statusCode = upstreamStatus;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: upstreamBody }));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("provider server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}/swap/v2`;
});

afterAll(() => server.close());

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Jupiter provider error redaction boundary", () => {
  it("keeps a 4xx provider error body out of the client-facing leg refusal", async () => {
    upstreamStatus = 400;
    upstreamBody = PROVIDER_BODY;

    const attempt = fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), legRequest());
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    const error = (await attempt.catch((caught: unknown) => caught)) as AppError;
    const message = error.toResponse().error.message;
    expect(message).not.toContain(OPAQUE_MARKER);
    expect(message).not.toContain(PROVIDER_BODY);
    // Stable caller-fault taxonomy is preserved: the caller's request is the
    // thing to change, and the upstream status stays visible as our own fact.
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.statusCode).toBe(400);
    expect(message).toMatch(/upstream 400/);
  });

  it("keeps a 4xx provider error body out of the client-facing quote refusal", async () => {
    upstreamStatus = 400;
    upstreamBody = PROVIDER_BODY;

    const attempt = fetchJupiterSwapQuote(swapEnv(), createVaultDeadline(), {
      inputMint: USDC,
      outputMint: PYUSD,
      sourceAmount: "25",
    });
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    const error = (await attempt.catch((caught: unknown) => caught)) as AppError;
    const message = error.toResponse().error.message;
    expect(message).not.toContain(OPAQUE_MARKER);
    expect(message).not.toContain(PROVIDER_BODY);
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.statusCode).toBe(400);
  });

  it("bounds and scrubs the provider detail logged for a 5xx", async () => {
    upstreamStatus = 502;
    upstreamBody = TELEMETRY_BODY;
    const errorLog = vi.spyOn(getLogger(), "error").mockImplementation(() => {});

    await expect(
      fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), legRequest())
    ).rejects.toMatchObject({ code: "BAD_REQUEST", statusCode: 400 });

    expect(errorLog).toHaveBeenCalledTimes(1);
    const payload = errorLog.mock.calls[0]?.[0] as { status?: number; detail?: string };
    expect(payload.status).toBe(502);
    expect(typeof payload.detail).toBe("string");
    const detail = payload.detail as string;
    // Bounded: no unbounded provider body lands in structured logs.
    expect(detail.length).toBeLessThanOrEqual(300);
    // Scrubbed: credential-shaped provider material is redacted.
    expect(detail).not.toContain("sk_live_supersecret");
  });

  it("bounds and scrubs the provider detail logged for a 429", async () => {
    upstreamStatus = 429;
    upstreamBody = TELEMETRY_BODY;
    const errorLog = vi.spyOn(getLogger(), "error").mockImplementation(() => {});

    await expect(
      fetchJupiterSwapQuote(swapEnv(), createVaultDeadline(), {
        inputMint: USDC,
        outputMint: PYUSD,
        sourceAmount: "25",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", statusCode: 400 });

    expect(errorLog).toHaveBeenCalledTimes(1);
    const payload = errorLog.mock.calls[0]?.[0] as { status?: number; detail?: string };
    expect(payload.status).toBe(429);
    expect(typeof payload.detail).toBe("string");
    const detail = payload.detail as string;
    expect(detail.length).toBeLessThanOrEqual(300);
    expect(detail).not.toContain("sk_live_supersecret");
  });
});
