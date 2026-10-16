import { describe, expect, it } from "vitest";
import { dataApiMetricsResponseSchema, indexMetricRows } from "./metrics";

const row = (metric: string, date: string, value: string | number) => ({
  date,
  metric_name: metric,
  unit: "USD",
  provider_name: "Allium",
  value,
});

/** The rows as a read built at `generatedAt` returns them, parsed and indexed. */
const read = (rows: readonly (Record<string, unknown> | null)[], generatedAt: string) =>
  indexMetricRows(
    dataApiMetricsResponseSchema.parse({ data: { generatedAt, truncated: false, rows } }).data
  );

const days = (table: ReturnType<typeof indexMetricRows>, metric: string) => [
  ...(table.values.get(metric) ?? []),
];

describe("indexMetricRows", () => {
  it("reads the API's decimal strings as numbers, by metric and day", () => {
    const table = read(
      [
        row("Circulating Supply", "2026-10-11", "16316485299.5"),
        row("Circulating Supply", "2026-10-12", "16269669914.0"),
        row("Transfer Count", "2026-10-12", 14477324),
      ],
      "2026-10-13T13:45:57Z"
    );
    expect(days(table, "Circulating Supply")).toEqual([
      ["2026-10-11", 16316485299.5],
      ["2026-10-12", 16269669914],
    ]);
    expect(days(table, "Transfer Count")).toEqual([["2026-10-12", 14477324]]);
    expect(table.rejectedRows).toBe(0);
  });

  it("leaves out the day still in progress when the API built its answer", () => {
    const table = read(
      [row("Total Stake", "2026-10-12", "1"), row("Total Stake", "2026-10-13", "2")],
      "2026-10-13T16:45:54.240736+00:00"
    );
    expect(days(table, "Total Stake")).toEqual([["2026-10-12", 1]]);
    expect(table.rejectedRows).toBe(0);
  });

  it("tells a closed day by UTC, whatever offset the API stamps", () => {
    // 23:00 on the 12th in UTC-5 is the 13th in UTC, so the 12th has closed.
    const table = read([row("Fees", "2026-10-12", "1")], "2026-10-12T23:00:00-05:00");
    expect(days(table, "Fees")).toEqual([["2026-10-12", 1]]);
  });

  it("keeps a day's first value and rejects a second, since the data team picks one", () => {
    const table = read(
      [row("Fees", "2026-10-12", "8008.03"), row("Fees", "2026-10-12", "9000")],
      "2026-10-13T00:00:00Z"
    );
    expect(days(table, "Fees")).toEqual([["2026-10-12", 8008.03]]);
    expect(table.rejectedRows).toBe(1);
  });

  it("leaves out and counts rows it cannot read, keeping the rest", () => {
    const table = read(
      [
        row("Fees", "2026-10-12", "8010.4"),
        row("Fees", "2026-10-11", ""),
        row("Fees", "2026-10-10", "NaN"),
        row("Fees", "not-a-day", "1"),
        { metric_name: "Fees" },
        null,
      ],
      "2026-10-13T00:00:00Z"
    );
    expect(days(table, "Fees")).toEqual([["2026-10-12", 8010.4]]);
    expect(table.rejectedRows).toBe(5);
  });
});

describe("dataApiMetricsResponseSchema", () => {
  const envelope = {
    source: "memory_cache",
    data: { generatedAt: "2026-10-13T16:45:54.240736+00:00", truncated: false, rows: [] },
  };

  it("requires the envelope the API sends: when it was built and whether it was truncated", () => {
    expect(dataApiMetricsResponseSchema.safeParse(envelope).success).toBe(true);
    expect(dataApiMetricsResponseSchema.safeParse({ data: { rows: [] } }).success).toBe(false);
  });

  it("refuses a build time that cannot date the day in progress", () => {
    const undated = { data: { ...envelope.data, generatedAt: "2026-10-13" } };
    expect(dataApiMetricsResponseSchema.safeParse(undated).success).toBe(false);
  });
});
