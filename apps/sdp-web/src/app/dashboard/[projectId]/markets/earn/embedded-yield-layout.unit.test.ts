import { describe, expect, it } from "vitest";
import { tableColumnShares, tableColumnTotals } from "@/test/table-columns";
import {
  EMBEDDED_YIELD_STRATEGY_COLUMNS,
  EMBEDDED_YIELD_WALLET_GRID,
} from "./embedded-yield-layout";

/** A grid's track widths in percent, on a phone or from `@2xl`. */
function gridTracks(className: string, width: "phone" | "wide"): number[] {
  const prefix = width === "phone" ? "grid-cols-[" : "@2xl:grid-cols-[";
  const token = className.split(/\s+/).find((candidate) => candidate.startsWith(prefix));
  return (token?.slice(prefix.length, -1).split("_") ?? []).map((track) =>
    Number.parseFloat(track)
  );
}

describe("Embedded Yield table columns", () => {
  it("fill the strategy table exactly on a phone and from @2xl", () => {
    expect(tableColumnTotals(EMBEDDED_YIELD_STRATEGY_COLUMNS)).toEqual({ phone: 100, wide: 100 });
  });

  it("keeps a strategy's live value and its toggle on a phone", () => {
    for (const column of [
      EMBEDDED_YIELD_STRATEGY_COLUMNS.value,
      EMBEDDED_YIELD_STRATEGY_COLUMNS.toggle,
    ]) {
      expect(column).not.toContain("hidden");
      expect(tableColumnShares(column).phone).toBeGreaterThan(0);
    }
  });

  it("sets a strategy's wallets on the table's own tracks", () => {
    const share = (id: keyof typeof EMBEDDED_YIELD_STRATEGY_COLUMNS) =>
      tableColumnShares(EMBEDDED_YIELD_STRATEGY_COLUMNS[id]);
    const address = (width: "phone" | "wide") =>
      share("strategy")[width] + share("wallets")[width] + share("positions")[width];

    // The address spans the strategy and both counts, so the value lands under the live value.
    expect(gridTracks(EMBEDDED_YIELD_WALLET_GRID, "phone")).toEqual([
      address("phone"),
      share("value").phone,
      share("toggle").phone,
    ]);
    expect(gridTracks(EMBEDDED_YIELD_WALLET_GRID, "wide")).toEqual([
      address("wide"),
      share("lastDeposit").wide,
      share("value").wide,
      share("toggle").wide,
    ]);
  });
});
