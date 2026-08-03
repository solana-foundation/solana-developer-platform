import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import DashboardError from "./error";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

function render(error: Error & { digest?: string }) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DashboardError error={error} reset={vi.fn()} />
    </I18nProvider>
  );
}

describe("DashboardError", () => {
  it("offers a retry and says the rest of the dashboard still works", () => {
    const markup = render(new Error("Selected project required"));

    expect(markup).toContain("This view couldn&#x27;t load");
    expect(markup).toContain("Try again");
  });

  it("does not add a second h1 — the shell above the boundary owns the page title", () => {
    // The shell's <h1> is how role-based locators (and the e2e specs) find the
    // current page; a heading of the same level in the error card would make that
    // ambiguous exactly when something has already gone wrong.
    expect(render(new Error("boom"))).not.toContain("<h1");
  });

  it("shows the digest when Next supplies one, and nothing when it doesn't", () => {
    const withDigest = Object.assign(new Error("boom"), { digest: "1234567890" });
    expect(render(withDigest)).toContain("Reference 1234567890");
    expect(render(new Error("boom"))).not.toContain("Reference");
  });

  it("keeps the raw error message out of the page", () => {
    // Server-thrown messages can name internal endpoints or config; the digest is
    // the handle for support, not the message.
    expect(render(new Error("Selected project required"))).not.toContain(
      "Selected project required"
    );
  });
});
