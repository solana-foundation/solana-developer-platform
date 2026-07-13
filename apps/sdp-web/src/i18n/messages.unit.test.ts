import { describe, expect, it } from "vitest";
import { isAppLocale } from "@/i18n/config";
import { getMessages, translate } from "@/i18n/messages";

describe("i18n messages", () => {
  it("only accepts configured locales", () => {
    expect(isAppLocale("en")).toBe(true);
    expect(isAppLocale("fr")).toBe(false);
  });

  it("resolves typed catalog entries", () => {
    expect(translate(getMessages("en"), "Home.joinWaitlist")).toBe("Join the waitlist");
  });

  it("rejects missing interpolation values", () => {
    expect(() => translate(getMessages("en"), "DashboardCustody.rotateKey")).toThrow(
      "Missing interpolation value hours for DashboardCustody.rotateKey"
    );
  });
});
