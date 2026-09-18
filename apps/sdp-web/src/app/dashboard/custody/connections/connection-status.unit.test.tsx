import type { CustodyConnectionLifecycle } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { ConnectionStatusCell } from "./connection-status";

function render(
  status: CustodyConnectionLifecycle,
  isRuntimeExecutionAllowed: boolean,
  failureCode: Parameters<typeof ConnectionStatusCell>[0]["failureCode"] = null
): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ConnectionStatusCell
        status={status}
        failureCode={failureCode}
        isRuntimeExecutionAllowed={isRuntimeExecutionAllowed}
      />
    </I18nProvider>
  );
}

describe("connection status cell", () => {
  it("says signing is allowed on a healthy active connection", () => {
    const html = render("active", true);
    expect(html).toContain("Active");
    expect(html).toContain('data-signing-state="allowed"');
    expect(html).toContain("Signing allowed");
  });

  it("keeps the connection Active while reporting that signing is paused", () => {
    const html = render("active", false);

    // The whole point of the second line: an entitlement change stops signing
    // without touching the connection, and merging the two facts into one
    // badge would make that read as a deletion.
    expect(html).toContain("Active");
    expect(html).not.toContain("Deactivated");
    expect(html).toContain('data-signing-state="paused"');
    expect(html).toContain("Signing is disabled");
  });

  it("makes no claim about signing on a connection that is not active yet", () => {
    for (const status of ["pending", "checking", "failed", "deactivated"] as const) {
      const html = render(status, false);
      expect(html).not.toContain("data-signing-state");
      expect(html).not.toContain("Signing");
    }
  });

  it("explains a conclusive install failure without leaking provider detail", () => {
    const html = render("failed", false, "invalid_credentials");
    expect(html).toContain("Failed");
    expect(html).toContain("Credentials were rejected");
  });
});
