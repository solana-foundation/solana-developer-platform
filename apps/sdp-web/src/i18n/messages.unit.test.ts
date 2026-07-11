import { describe, expect, it } from "vitest";
import { isAppLocale, supportedLocales } from "@/i18n/config";
import { getMessages, translate } from "@/i18n/messages";

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") {
    return [prefix];
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  return Object.entries(value).flatMap(([key, nested]) => {
    const next = prefix ? `${prefix}.${key}` : key;
    return flattenKeys(nested, next);
  });
}

describe("i18n messages", () => {
  it("only accepts configured locales", () => {
    expect(isAppLocale("en")).toBe(true);
    expect(isAppLocale("fr")).toBe(true);
    expect(isAppLocale("de")).toBe(false);
  });

  it("resolves typed catalog entries", () => {
    expect(translate(getMessages("en"), "Home.joinWaitlist")).toBe("Join the waitlist");
    expect(translate(getMessages("fr"), "Home.joinWaitlist")).toBe(
      "Rejoindre la liste d’attente"
    );
  });

  it("keeps non-English catalogs inventory-matched to English", () => {
    const englishKeys = flattenKeys(getMessages("en")).sort();

    for (const locale of supportedLocales) {
      if (locale === "en") continue;
      expect(flattenKeys(getMessages(locale)).sort()).toEqual(englishKeys);
    }
  });

  it("rejects missing interpolation values", () => {
    expect(() => translate(getMessages("en"), "DashboardCustody.rotateKey")).toThrow(
      "Missing interpolation value hours for DashboardCustody.rotateKey"
    );
  });
});
