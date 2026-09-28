import { describe, expect, it } from "vitest";
import { isAppLocale, supportedLocales } from "@/i18n/config";
import {
  englishSourceMessages,
  getMessages,
  loadMessages,
  mergeLocalizedMessages,
  mergeLocalizedMessagesWithEmbeddedYieldBrand,
  translate,
} from "@/i18n/messages";

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
    expect(isAppLocale("es")).toBe(true);
    expect(isAppLocale("fr")).toBe(true);
    expect(isAppLocale("pt")).toBe(true);
    expect(isAppLocale("vi")).toBe(true);
    expect(isAppLocale("de")).toBe(false);
  });

  it("resolves typed catalog entries", async () => {
    expect(translate(getMessages("en"), "Home.trySdp")).toBe("Try SDP");
    expect(translate(await loadMessages("es"), "Home.contactUs")).toBe("Contáctanos");
    expect(translate(await loadMessages("fr"), "Home.contactUs")).toBe("Nous contacter");
    expect(translate(await loadMessages("pt"), "Home.contactUs")).toBe("Fale conosco");
    expect(translate(await loadMessages("vi"), "Home.contactUs")).toBe("Liên hệ");
  });

  it("keeps the English catalog synchronous and localized catalogs behind loadMessages", () => {
    expect(getMessages("en")).toBe(englishSourceMessages);
    for (const locale of supportedLocales) {
      if (locale === "en") continue;
      expect(() => getMessages(locale)).toThrow(/loadMessages/);
    }
  });

  it("uses Embedded Yield as the product name in every locale", async () => {
    for (const locale of supportedLocales) {
      const messages = await loadMessages(locale);
      expect(translate(messages, "Shared.dashboardShell.earnProgram")).toBe("Embedded Yield");
      expect(translate(messages, "DashboardEarn.playground.productName")).toBe("Embedded Yield");
    }
  });

  it("defines the product name in the raw English source catalog", () => {
    expect(englishSourceMessages.Shared.dashboardShell.earnProgram).toBe("Embedded Yield");
    expect(englishSourceMessages.DashboardEarn.playground.productName).toBe("Embedded Yield");
  });

  it("only repairs stale localized branding when the source names Embedded Yield", () => {
    expect(
      mergeLocalizedMessagesWithEmbeddedYieldBrand(
        {
          product: "Compare Embedded Yield strategies",
          generic: "Earn yield on idle balances",
        },
        {
          product: "Compare Earn strategies",
          generic: "Earn yield on idle balances",
        }
      )
    ).toEqual({
      product: "Compare Embedded Yield strategies",
      generic: "Earn yield on idle balances",
    });
  });

  it("keeps non-English catalogs inventory-matched to English", async () => {
    const englishKeys = flattenKeys(getMessages("en")).sort();

    for (const locale of supportedLocales) {
      if (locale === "en") continue;
      expect(flattenKeys(await loadMessages(locale)).sort()).toEqual(englishKeys);
    }
  });

  it("falls back to English while release automation catches up", () => {
    expect(
      mergeLocalizedMessages(
        {
          Home: {
            title: "English title",
            description: "New English-only copy",
          },
        },
        {
          Home: {
            title: "Titre français",
          },
        }
      )
    ).toEqual({
      Home: {
        title: "Titre français",
        description: "New English-only copy",
      },
    });
  });

  it("keeps catalogs free of ICU syntax translate cannot render", async () => {
    // translate only substitutes {name}. An ICU construct such as
    // {count, plural, one {#} other {#}} matches nothing, throws nothing, and
    // reaches the user verbatim, so no catalog may contain one.
    for (const locale of supportedLocales) {
      const messages = (await loadMessages(locale)) as unknown;
      const offenders = flattenKeys(messages).filter((key) => {
        const value = key.split(".").reduce<unknown>((carry, segment) => {
          return carry && typeof carry === "object"
            ? (carry as Record<string, unknown>)[segment]
            : undefined;
        }, messages);
        return (
          typeof value === "string" && /\{\s*\w+\s*,\s*(plural|select|selectordinal)\b/.test(value)
        );
      });

      expect(offenders).toEqual([]);
    }
  });

  it("rejects missing interpolation values", () => {
    expect(() => translate(getMessages("en"), "DashboardCustody.rotateKey")).toThrow(
      "Missing interpolation value hours for DashboardCustody.rotateKey"
    );
  });
});
