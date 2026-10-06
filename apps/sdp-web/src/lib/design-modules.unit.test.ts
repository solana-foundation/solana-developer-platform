import { describe, expect, it } from "vitest";
import { isNewDesignPage } from "./design-modules";

describe("isNewDesignPage", () => {
  it.each(["/dashboard", "/dashboard/issuance", "/dashboard/integrations/private-channels/setup"])(
    "puts %s on NEW DESIGN alone",
    (pathname) => {
      expect(isNewDesignPage(pathname, { newDesign: true })).toBe(true);
      expect(isNewDesignPage(pathname, { newDesign: false })).toBe(false);
    }
  );

  it.each(["/dashboard/payments", "/dashboard/payments/pay"])(
    "keeps %s, which no design module has redesigned, on the previous design",
    (pathname) => {
      expect(isNewDesignPage(pathname, { newDesign: true })).toBe(false);
    }
  );

  it("keeps every page on the previous design outside the dashboard workspace", () => {
    expect(isNewDesignPage("/dashboard", undefined)).toBe(false);
  });
});
