import { describe, expect, it } from "vitest";
import { resolveTheme } from "./theme-context";

describe("theme resolution", () => {
  it("exposes the resolved system theme to consumers", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("uses the server-safe light fallback before next-themes resolves", () => {
    expect(resolveTheme(undefined)).toBe("light");
    expect(resolveTheme("system")).toBe("light");
  });
});
