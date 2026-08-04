import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { ApprovalInbox } from "./approval-inbox";

function renderInbox(overrides: Partial<Parameters<typeof ApprovalInbox>[0]> = {}): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ApprovalInbox
        initialRequests={[]}
        apiKeyNames={{}}
        canDecide
        renderedAt={0}
        {...overrides}
      />
    </I18nProvider>
  );
}

describe("ApprovalInbox filters", () => {
  it("renders the date presets with every catalog key resolved (regression: missing translation)", () => {
    // Rendering exercises DateRangeFilter, which throws if any dateX key is absent;
    // the closed select only shows the active preset in the trigger.
    const markup = renderInbox();
    expect(markup).toContain("All time");
  });

  it("defaults the date range to All time with no date fields shown", () => {
    const markup = renderInbox();
    // All time is the active preset by default; custom From/To inputs stay hidden.
    expect(markup).toContain('aria-label="Date"');
    expect(markup).not.toContain('type="date"');
  });

  it("shows the wallet, operation, and API-key filters on the pending tab", () => {
    const markup = renderInbox();
    expect(markup).toContain("All wallets");
    expect(markup).toContain("All operations");
    expect(markup).toContain("All API keys");
  });
});
