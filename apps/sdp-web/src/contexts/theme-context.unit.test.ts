import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { resolvePreference, resolveTheme, THEME_PREFERENCES, useTheme } from "./theme-context";

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

describe("theme preference resolution", () => {
  it("reports an explicit override as the stored preference", () => {
    expect(resolvePreference("light")).toBe("light");
    expect(resolvePreference("dark")).toBe("dark");
  });

  it("treats a missing or non-override value as following the system", () => {
    expect(resolvePreference("system")).toBe("system");
    expect(resolvePreference(undefined)).toBe("system");
    expect(resolvePreference("")).toBe("system");
    expect(resolvePreference("sepia")).toBe("system");
  });

  it("keeps system reachable so an override is never a one-way door", () => {
    // The bug this replaced: the toggle only ever wrote "light" or "dark", so once a
    // user touched it there was no value they could pick to hand control back to the OS.
    expect(THEME_PREFERENCES).toContain("system");
    expect(resolvePreference(THEME_PREFERENCES[0])).toBe("system");
  });

  it("offers exactly system, light and dark", () => {
    expect([...THEME_PREFERENCES]).toEqual(["system", "light", "dark"]);
  });
});
