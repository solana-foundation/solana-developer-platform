// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { type RpcTestResult, RpcTestResultPanel } from "./rpc-connection";

function renderResult(result: Partial<RpcTestResult> = {}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
  return render(
    <RpcTestResultPanel
      result={{
        status: "error",
        message: "something went wrong",
        requestedProvider: "helius",
        ...result,
      }}
    />,
    { wrapper }
  );
}

afterEach(cleanup);

describe("RpcTestResultPanel", () => {
  it("does not call a mismatch unreachable", () => {
    // The endpoint answered 200. Reporting "Unreachable" beside its own
    // "200 OK" row is the contradiction this state exists to remove.
    renderResult({
      reason: "mismatch",
      resolvedProvider: "alchemy",
      upstreamStatus: 200,
      upstreamStatusText: "OK",
      latencyMs: 1341,
    });

    expect(screen.queryByText("Unreachable")).toBeNull();
    expect(screen.getByText("Another provider answered")).toBeTruthy();
  });

  it("still reports a genuinely unreachable upstream as unreachable", () => {
    renderResult({ reason: "upstream", upstreamStatus: 502, upstreamStatusText: "Bad Gateway" });

    expect(screen.getByText("Unreachable")).toBeTruthy();
    expect(screen.queryByText("Another provider answered")).toBeNull();
  });

  it("reports a passing check as reachable", () => {
    renderResult({ status: "success", reason: undefined, upstreamStatus: 200 });

    expect(screen.getByText("Reachable")).toBeTruthy();
  });

  it("renders the relay's selection mode as words, not its enum", () => {
    // `project_connection` is the API's spelling; nobody reading the dashboard
    // has a reason to know it.
    renderResult({ reason: "mismatch", selectionMode: "project_connection" });

    expect(screen.queryByText("project_connection")).toBeNull();
    expect(screen.getByText("This project's own connection")).toBeTruthy();
  });

  it("falls back to the raw mode when the relay adds one we do not map", () => {
    renderResult({ reason: "mismatch", selectionMode: "some_future_mode" });

    expect(screen.getByText("some_future_mode")).toBeTruthy();
  });
});
