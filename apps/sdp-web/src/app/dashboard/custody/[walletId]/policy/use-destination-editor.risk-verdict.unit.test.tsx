// @vitest-environment jsdom

/**
 * Regression for SOLA9-160 (APE-722), exercised through the real destination
 * editor's single-add handler: an `ok` screening whose verdict maps to nothing
 * (an unrecognized label, or no score with no recognized completion) must
 * block the unattended allowlist add, and a recognized-clean screening must
 * still commit. This drives `useDestinationEditor.requestAdd` — the handler
 * that auto-commits clean addresses — so the blocking decision cannot drift
 * away from the classification it is supposed to read.
 */

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComplianceSnapshot } from "@/app/dashboard/payments/payments-workspace.types";
import type { ComplianceProviderResult } from "@/lib/compliance";
import { EnglishTestI18n } from "../../../markets/test-i18n";
import { useDestinationEditor } from "./use-destination-editor";
import type { PolicyAuthoringState } from "./wallet-policy-authoring";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const ADDRESS = "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ";
const SECOND_ADDRESS = "So11111111111111111111111111111111111111112";
const CHECKED_AT = "2026-09-24T00:00:00.000Z";

function withI18n({ children }: { children: ReactNode }) {
  return <EnglishTestI18n>{children}</EnglishTestI18n>;
}

function providerResult(overrides: Partial<ComplianceProviderResult>): ComplianceProviderResult {
  return {
    provider: "range",
    status: "ok",
    riskScore: null,
    evaluatedAt: CHECKED_AT,
    ...overrides,
  };
}

/** The shape the real adapters produce for the SOLA9-160 provider responses. */
const UNKNOWN_VERDICT_RESULTS = [
  providerResult({ provider: "elliptic", riskLevel: "unknown" }),
  providerResult({ provider: "range", riskLevel: "unknown" }),
  providerResult({ provider: "trm", riskLevel: "unknown" }),
];

function screeningEnvelope(providers: ComplianceProviderResult[]) {
  const snapshot: ComplianceSnapshot = { address: ADDRESS, checkedAt: CHECKED_AT, providers };
  return { data: { screening: snapshot } };
}

function authoringState(overrides?: Partial<PolicyAuthoringState>): PolicyAuthoringState {
  return {
    defaultAction: "deny",
    categories: ["destinations"],
    limits: [],
    assets: [],
    destinationMode: "allowlist",
    destinationAllowText: "",
    destinationBlockText: "",
    familyActions: {},
    operationTypeRules: [],
    passthroughRules: [],
    ...overrides,
  };
}

/**
 * Mounts the real editor hook over a mutable authoring state and mocks the
 * two fetches it makes: the counterparty account list (SWR) and the
 * address screening behind `runComplianceCheck`.
 */
function renderEditor(screening: { providers: ComplianceProviderResult[] }) {
  let state = authoringState();
  const setPolicyState = (update: (current: PolicyAuthoringState) => PolicyAuthoringState) => {
    state = update(state);
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.includes("/api/dashboard/compliance/address-screenings")) {
      return Response.json(screeningEnvelope(screening.providers));
    }
    if (url.includes("/api/dashboard/counterparty/accounts")) {
      return Response.json({ data: { accounts: [] } });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const rendered = renderHook(() => useDestinationEditor(state, setPolicyState, true), {
    wrapper: withI18n,
  });
  return { ...rendered, readState: () => state };
}

describe("useDestinationEditor single-add on an ambiguous screening (SOLA9-160)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not auto-commit an unrecognized verdict and surfaces it for review", async () => {
    const { result, readState, rerender } = renderEditor({
      providers: UNKNOWN_VERDICT_RESULTS,
    });

    await act(async () => {
      await result.current.requestAdd(ADDRESS);
    });
    rerender();

    // The screening itself "succeeded" (every provider answered ok) — the
    // add is blocked purely because the verdict maps to nothing.
    expect(result.current.snapshot?.providers.map((p) => p.status)).toEqual(["ok", "ok", "ok"]);
    expect(readState().destinationAllowText).not.toContain(ADDRESS);
    expect(result.current.phase).toBe("revealing");

    act(() => {
      result.current.onScreeningComplete();
    });
    expect(result.current.phase).toBe("risk");
  });

  it("does not auto-commit a verdictless ok result", async () => {
    // No score and no label is only a recognized completion for some
    // providers; Range's is contract drift and must require review.
    const { result, readState } = renderEditor({
      providers: [providerResult({ provider: "range" })],
    });

    await act(async () => {
      await result.current.requestAdd(ADDRESS);
    });

    expect(readState().destinationAllowText).not.toContain(ADDRESS);
  });

  it("still auto-commits a recognized-clean screening", async () => {
    // TRM's documented no-attribution response is a completed clean check.
    const { result, readState } = renderEditor({
      providers: [providerResult({ provider: "trm" })],
    });

    await act(async () => {
      await result.current.requestAdd(ADDRESS);
    });

    expect(readState().destinationAllowText).toContain(ADDRESS);
  });
});

describe("useDestinationEditor bulk paste on an ambiguous screening (SOLA9-160)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not auto-commit unrecognized verdicts and queues them for review", async () => {
    // The bulk-paste handler reaches the same blocking decision through
    // screenDestination, so a drift there cannot silently commit an
    // ambiguous screening from a multi-address paste either.
    const { result, readState } = renderEditor({
      providers: UNKNOWN_VERDICT_RESULTS,
    });

    await act(async () => {
      result.current.handleQueryChange(`${ADDRESS}, ${SECOND_ADDRESS}`);
    });

    expect(readState().destinationAllowText).not.toContain(ADDRESS);
    expect(readState().destinationAllowText).not.toContain(SECOND_ADDRESS);
    expect(result.current.flagged.map((entry) => entry.address)).toEqual([ADDRESS, SECOND_ADDRESS]);
    expect(result.current.flagged.every((entry) => !entry.unavailable)).toBe(true);
  });

  it("still commits a recognized-clean bulk paste", async () => {
    const { result, readState } = renderEditor({
      providers: [providerResult({ provider: "trm" })],
    });

    await act(async () => {
      result.current.handleQueryChange(`${ADDRESS}, ${SECOND_ADDRESS}`);
    });

    expect(readState().destinationAllowText).toContain(ADDRESS);
    expect(readState().destinationAllowText).toContain(SECOND_ADDRESS);
    expect(result.current.flagged).toEqual([]);
  });
});
