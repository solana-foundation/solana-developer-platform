// @vitest-environment jsdom
import type { ProviderPolicyCheck } from "@sdp/types/custody";
import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { ProviderPolicyCallout } from "./provider-policy-callout";

function view(check: ProviderPolicyCheck | undefined) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ProviderPolicyCallout check={check} provider="fireblocks" />
    </I18nProvider>
  );
}
describe("provider policy advisory", () => {
  afterEach(cleanup);
  it("shows a missing-policy warning without disabling wallet actions", () => {
    render(view({ status: "missing", reason: "no_policy", checkedAt: null }));
    expect(screen.getByText("No provider policy detected")).toBeTruthy();
    expect(screen.getByText(/SDP still allows signing/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("distinguishes denied reads from confirmed absence", () => {
    render(view({ status: "unknown", reason: "access_denied", checkedAt: null }));
    expect(screen.getByText("Provider policy not verified")).toBeTruthy();
    expect(screen.getByText(/credential cannot read policies/)).toBeTruthy();
    expect(screen.queryByText("No provider policy detected")).toBeNull();
  });
  it("does not describe a detected policy as secure and renders server markup", () => {
    const html = renderToStaticMarkup(
      view({ status: "present", reason: "policy_detected", checkedAt: "2026-11-12T12:00:00.000Z" })
    );
    expect(html).toContain("Provider policy detected");
    expect(html).toContain("does not assess how restrictive");
    expect(html).toContain("Last checked");
  });
  it("omits the advisory where there is no BYOK observation", () => {
    expect(renderToStaticMarkup(view(undefined))).toBe("");
  });
});
