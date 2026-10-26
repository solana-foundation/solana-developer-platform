import { describe, expect, it } from "vitest";
import {
  TREASURY_POSITION_COLUMNS,
  TREASURY_PROGRAM_COLUMNS,
  TREASURY_STRATEGY_COLUMNS,
} from "./treasury-layout";

const TABLES = [
  ["positions", TREASURY_POSITION_COLUMNS],
  ["strategies", TREASURY_STRATEGY_COLUMNS],
  ["programs", TREASURY_PROGRAM_COLUMNS],
] as const;

function percent(token: string | undefined): number | undefined {
  const match = token?.match(/w-\[(\d+)%\]$/);
  return match ? Number(match[1]) : undefined;
}

/** A column's share of the table on a phone and from `@2xl`; 0 where the column is hidden. */
function shares(className: string): { phone: number; wide: number } {
  const tokens = className.split(/\s+/);
  const phoneWidth = percent(tokens.find((token) => token.startsWith("w-[")));
  const wideWidth = percent(tokens.find((token) => token.startsWith("@2xl:w-["))) ?? phoneWidth;
  const hiddenOnPhone = tokens.includes("hidden");
  const shownWide = !hiddenOnPhone || tokens.includes("@2xl:table-cell");
  return {
    phone: hiddenOnPhone ? 0 : (phoneWidth ?? Number.NaN),
    wide: shownWide ? (wideWidth ?? Number.NaN) : 0,
  };
}

describe("Treasury table columns", () => {
  it.each(TABLES)("fill the %s table exactly on a phone and from @2xl", (_name, columns) => {
    const columnShares = Object.values(columns).map(shares);
    const total = (width: "phone" | "wide") =>
      columnShares.reduce((sum, share) => sum + share[width], 0);

    expect(total("phone")).toBe(100);
    expect(total("wide")).toBe(100);
  });

  it.each(TABLES)("keeps the %s table's row actions on a phone", (_name, columns) => {
    expect(columns.actions).not.toContain("hidden");
    expect(shares(columns.actions).phone).toBeGreaterThan(0);
  });
});
