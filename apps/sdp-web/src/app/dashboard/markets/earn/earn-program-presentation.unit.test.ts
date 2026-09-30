import { describe, expect, it } from "vitest";
import type { MessageKey } from "@/i18n/messages";
import { strategySourceLabel } from "./earn-program-presentation";

const t = (key: MessageKey) => `translated:${key}`;

describe("strategySourceLabel", () => {
  it("translates a source whose label describes the asset", () => {
    expect(
      strategySourceLabel({ underlyingSource: "figure-democratized-prime-home-equity" }, t)
    ).toBe("translated:DashboardEarn.deposit.vaultBackingFigureHomeEquity");
  });

  it("keeps brand names and unknown sources as they are", () => {
    expect(strategySourceLabel({ underlyingSource: "kamino" }, t)).toBe("Kamino");
    expect(strategySourceLabel({ underlyingSource: "Upshift" }, t)).toBe("Upshift");
    expect(strategySourceLabel({ underlyingSource: "  " }, t)).toBeUndefined();
    expect(strategySourceLabel({}, t)).toBeUndefined();
  });
});
