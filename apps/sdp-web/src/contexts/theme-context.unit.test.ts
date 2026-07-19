import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { isTheme, resolveTheme, THEME_NO_FLASH_SCRIPT } from "./theme-context";

function runNoFlashScript({
  storedValue,
  prefersDark,
  storageThrows = false,
}: {
  storedValue: string | null;
  prefersDark: boolean;
  storageThrows?: boolean;
}): boolean {
  let darkClassApplied = false;

  runInNewContext(THEME_NO_FLASH_SCRIPT, {
    localStorage: {
      getItem: () => {
        if (storageThrows) throw new Error("storage unavailable");
        return storedValue;
      },
    },
    window: {
      matchMedia: () => ({ matches: prefersDark }),
    },
    document: {
      documentElement: {
        classList: {
          toggle: (className: string, enabled: boolean) => {
            expect(className).toBe("dark");
            darkClassApplied = enabled;
          },
        },
      },
    },
  });

  return darkClassApplied;
}

describe("theme resolution", () => {
  it("accepts only supported explicit preferences", () => {
    expect(isTheme("light")).toBe(true);
    expect(isTheme("dark")).toBe(true);
    expect(isTheme("system")).toBe(false);
    expect(isTheme(null)).toBe(false);
  });

  it("uses an explicit preference before the system preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("falls back to the system for absent or invalid preferences", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme("invalid", false)).toBe("light");
  });
});

describe("no-flash theme script", () => {
  it("applies valid stored preferences before hydration", () => {
    expect(runNoFlashScript({ storedValue: "dark", prefersDark: false })).toBe(true);
    expect(runNoFlashScript({ storedValue: "light", prefersDark: true })).toBe(false);
  });

  it("follows the system when storage is absent or invalid", () => {
    expect(runNoFlashScript({ storedValue: null, prefersDark: true })).toBe(true);
    expect(runNoFlashScript({ storedValue: "sepia", prefersDark: false })).toBe(false);
  });

  it("still follows the system when storage access throws", () => {
    expect(runNoFlashScript({ storedValue: null, prefersDark: true, storageThrows: true })).toBe(
      true
    );
  });
});
