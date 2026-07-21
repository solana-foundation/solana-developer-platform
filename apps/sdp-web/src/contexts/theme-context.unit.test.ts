import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { resolveTheme, useTheme } from "./theme-context";

function ThemeConsumer() {
  useTheme();
  return null;
}

describe("theme resolution", () => {
  it("exposes the resolved system theme to consumers", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("uses the server-safe light fallback before next-themes resolves", () => {
    expect(resolveTheme(undefined)).toBe("light");
    expect(resolveTheme("system")).toBe("light");
  });

  it("rejects consumers outside the SDP theme provider", () => {
    expect(() => renderToString(createElement(ThemeConsumer))).toThrow(
      "useTheme must be used within a ThemeProvider"
    );
  });
});
