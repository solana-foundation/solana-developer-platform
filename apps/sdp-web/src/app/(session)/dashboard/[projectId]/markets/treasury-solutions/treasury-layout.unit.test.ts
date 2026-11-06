import { describe, expect, it } from "vitest";
import { tableColumnShares, tableColumnTotals } from "@/test/table-columns";
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

describe("Treasury table columns", () => {
  it.each(TABLES)("fill the %s table exactly on a phone and from @2xl", (_name, columns) => {
    expect(tableColumnTotals(columns)).toEqual({ phone: 100, wide: 100 });
  });

  it.each(TABLES)("keeps the %s table's row actions on a phone", (_name, columns) => {
    expect(columns.actions).not.toContain("hidden");
    expect(tableColumnShares(columns.actions).phone).toBeGreaterThan(0);
  });
});
