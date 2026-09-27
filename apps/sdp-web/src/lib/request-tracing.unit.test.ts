import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  auth: vi.fn(),
  createSdpApiClient: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
}));

vi.mock("./sdp-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sdp-api")>();
  return {
    ...actual,
    createSdpApiClient: mocks.createSdpApiClient,
  };
});

import { withDashboardPageTrace } from "./dashboard-page-trace";
import { createTimedTrace, logRouteResult } from "./request-tracing";
import { SdpApiResponseError } from "./sdp-api";

/**
 * The dashboard trace sink (`console.info(JSON.stringify(...))`) is a server
 * log we own, so everything it emits must pass through `@sdp/redaction`.
 * Callers pass upstream response bodies and `Error.message` values straight
 * into `trace.log` / `logRouteResult` — and `SdpApiResponseError.message`
 * embeds the full failed API body — so the sink itself has to be the
 * scrubbing boundary (SOLA9-658).
 */

const PROVIDER_BODY = JSON.stringify({
  error: {
    code: "PROVIDER_VALIDATION_FAILED",
    message: "Counterparty jane.doe@example.com failed bank verification",
    providerBody: {
      accountNumber: "000123456789",
      ownerAddress: "7Yq3nRbFkMd2pXcLwT9vZs4HaJ1uE6gQoB8iVtNrK5mD",
      diagnostic: "provider case KYC-4481",
    },
  },
});

/** Substrings that must never reach the server trace output. */
const FORBIDDEN = [
  "jane.doe@example.com",
  "000123456789",
  "7Yq3nRbFkMd2pXcLwT9vZs4HaJ1uE6gQoB8iVtNrK5mD",
];

let infoLines: string[];

function lastLine(): string {
  const line = infoLines.at(-1);
  expect(line, "expected the trace sink to emit exactly one JSON line").toBeTruthy();
  return line ?? "";
}

beforeEach(() => {
  infoLines = [];
  vi.spyOn(console, "info").mockImplementation((line: unknown) => {
    infoLines.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  mocks.createSdpApiClient.mockReset();
});

describe("dashboard trace sink scrubbing (SOLA9-658)", () => {
  it("scrubs a serialized provider error body and SdpApiResponseError.message in trace.log", () => {
    const responseError = new SdpApiResponseError(502, PROVIDER_BODY);

    createTimedTrace("dashboard.issuance.token.page").log({
      ok: false,
      profileError: PROVIDER_BODY,
      error: responseError.message,
    });

    const line = lastLine();
    for (const forbidden of FORBIDDEN) {
      expect(line).not.toContain(forbidden);
    }
  });

  it("scrubs nested PII objects by key", () => {
    createTimedTrace("dashboard.issuance.token.page").log({
      ok: false,
      counterparty: {
        email: "jane.doe@example.com",
        bankDetails: {
          accountNumber: "000123456789",
          ownerAddress: "7Yq3nRbFkMd2pXcLwT9vZs4HaJ1uE6gQoB8iVtNrK5mD",
        },
      },
    });

    const line = lastLine();
    for (const forbidden of FORBIDDEN) {
      expect(line).not.toContain(forbidden);
    }
  });

  it("scrubs generic exception messages while keeping the remainder readable", () => {
    createTimedTrace("dashboard.issuance.token.page").log({
      ok: false,
      error: new Error("Transfer rejected for jane.doe@example.com (accountNumber=000123456789)")
        .message,
    });

    const line = lastLine();
    for (const forbidden of FORBIDDEN) {
      expect(line).not.toContain(forbidden);
    }
    // The message stays diagnosable rather than being dropped wholesale.
    expect(line).toContain("Transfer rejected for");
  });

  it("scrubs an unlabelled account number quoted in prose, with no key to vouch for it", () => {
    // The labelled forms are caught by the assignment rules; a provider that
    // folds the number into free text ("Transfer rejected for account …")
    // leaves nothing but the digit shape to recognize.
    createTimedTrace("dashboard.issuance.token.page").log({
      ok: false,
      error: "Transfer rejected for account 000123456789",
    });

    const line = lastLine();
    for (const forbidden of FORBIDDEN) {
      expect(line).not.toContain(forbidden);
    }
    expect(line).toContain("Transfer rejected for account");
  });

  it("scrubs logRouteResult extras carrying an upstream body", () => {
    const trace = createTimedTrace("dashboard.proxy");
    logRouteResult(trace, 502, { error: new SdpApiResponseError(502, PROVIDER_BODY).message });

    const line = lastLine();
    for (const forbidden of FORBIDDEN) {
      expect(line).not.toContain(forbidden);
    }
  });

  it("withDashboardPageTrace logs a scrubbed message before rethrowing", async () => {
    mocks.createSdpApiClient.mockRejectedValue(new SdpApiResponseError(502, PROVIDER_BODY));

    await expect(
      withDashboardPageTrace("dashboard.issuance.token.page", async () => {
        throw new Error("unreachable");
      })
    ).rejects.toBeInstanceOf(SdpApiResponseError);

    const line = lastLine();
    for (const forbidden of FORBIDDEN) {
      expect(line).not.toContain(forbidden);
    }
  });

  it("keeps non-PII trace fields readable", () => {
    // Over-redaction would blind on-call debugging: resource ids, Solana
    // wallet addresses (public by design), and plain failures are all
    // legitimate trace output.
    createTimedTrace("dashboard.issuance.token.page").log({
      ok: false,
      tokenId: "token_123",
      walletAddress: "7Yq3nRbFkMd2pXcLwT9vZs4HaJ1uE6gQoB8iVtNrK5mD",
      error: "Request failed with status 500",
    });

    const line = lastLine();
    expect(line).toContain("token_123");
    expect(line).toContain("7Yq3nRbFkMd2pXcLwT9vZs4HaJ1uE6gQoB8iVtNrK5mD");
    expect(line).toContain("Request failed with status 500");
  });
});
