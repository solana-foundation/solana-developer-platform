// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { TokenDisplayAmount } from "./token-display-amount";

function markup(displayRule: "plain" | "scaled" | "interest", displayAsOf: string | null): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <TokenDisplayAmount balance={{ displayRule, displayAsOf }} formatted="1.0234 USDX" />
    </I18nProvider>
  );
}

describe("TokenDisplayAmount", () => {
  it("shows a plain or scaled amount as exact", () => {
    expect(markup("plain", null)).toBe("1.0234 USDX");
    expect(markup("scaled", "2026-10-22T12:00:00.000Z")).toBe("1.0234 USDX");
  });

  it("shows an interest-bearing amount as approximate, its time formatted in the browser only", () => {
    // The server renders no time, so its time zone never reaches the markup.
    expect(markup("interest", "2026-10-22T12:00:00.000Z")).toBe("≈ 1.0234 USDX");

    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <TokenDisplayAmount
          balance={{ displayRule: "interest", displayAsOf: "2026-10-22T12:00:00.000Z" }}
          formatted="1.0234 USDX"
        />
      </I18nProvider>
    );

    expect(screen.getByText(/≈ 1\.0234 USDX/)).toBeTruthy();
    expect(screen.getByText(/as of Oct 22/)).toBeTruthy();
  });
});
