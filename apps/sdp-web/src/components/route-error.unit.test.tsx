// @vitest-environment jsdom
import { cleanup, fireEvent, render as mount } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { RouteError } from "./route-error";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

function render(error: Error & { digest?: string }) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <RouteError error={error} retry={vi.fn()} />
    </I18nProvider>
  );
}

afterEach(() => {
  cleanup();
});

describe("RouteError", () => {
  it("asks Next to retry the segment once per press", () => {
    const retry = vi.fn();
    const view = mount(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <RouteError error={new Error("boom")} retry={retry} />
      </I18nProvider>
    );

    fireEvent.click(view.getByRole("button", { name: /^Try again/ }));

    expect(retry).toHaveBeenCalledOnce();
  });

  it("offers a retry and says the rest of the dashboard still works", () => {
    const markup = render(new Error("Selected project required"));

    expect(markup).toContain("This view couldn&#x27;t load");
    expect(markup).toContain("Try again");
  });

  it("does not add a second h1 — the shell above the boundary owns the page title", () => {
    expect(render(new Error("boom"))).not.toContain("<h1");
  });

  it("shows the digest when Next supplies one, and nothing when it doesn't", () => {
    const withDigest = Object.assign(new Error("boom"), { digest: "1234567890" });
    expect(render(withDigest)).toContain("Reference 1234567890");
    expect(render(new Error("boom"))).not.toContain("Reference");
  });

  it("keeps the raw error message out of the page", () => {
    expect(render(new Error("Selected project required"))).not.toContain(
      "Selected project required"
    );
  });
});
