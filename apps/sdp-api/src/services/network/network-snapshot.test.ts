import {
  NETWORK_METRIC_IDS,
  type NetworkMetricId,
  networkSnapshotSchema,
} from "@sdp/types/network-metrics";
import { describe, expect, it } from "vitest";
import { dataApiMetricsResponseSchema, indexMetricRows } from "@/lib/data-api/metrics";
import { buildNetworkReadings } from "./network-snapshot";

type Day = Record<string, number | undefined>;

/** A table where each day maps metric names to their preferred value, read mid-day on the 13th. */
function tableOf(days: Record<string, Day>) {
  const rows = Object.entries(days).flatMap(([date, figures]) =>
    Object.entries(figures).flatMap(([metric, value]) =>
      value === undefined
        ? []
        : [{ date, metric_name: metric, unit: "", provider_name: "p", value: String(value) }]
    )
  );
  const generatedAt = "2026-10-13T12:00:00Z";
  return indexMetricRows(
    dataApiMetricsResponseSchema.parse({ data: { generatedAt, truncated: false, rows } }).data
  );
}

const FULL_DAY: Day = {
  "Circulating Supply": 15.89e9,
  "Transfer Count": 14.28e6,
  "Non Vote Transaction Count (Success)": 118.1e6,
  Fees: 8010,
  "SOL Price": 110,
};

function series(snapshot: ReturnType<typeof buildNetworkReadings>, id: NetworkMetricId) {
  if (snapshot === null) throw new Error("No readings were built");
  return snapshot.metrics[id];
}

/** Each reading's last day, in the contract's order. */
function lastDays(snapshot: ReturnType<typeof buildNetworkReadings>) {
  return NETWORK_METRIC_IDS.map((id) => series(snapshot, id).at(-1)?.date);
}

describe("buildNetworkReadings", () => {
  it("derives every reading from metrics read on the same day", () => {
    const snapshot = buildNetworkReadings(tableOf({ "2026-10-12": FULL_DAY }));
    const withHealth = snapshot && { ...snapshot, health: null };
    expect(withHealth && networkSnapshotSchema.parse(withHealth)).toEqual(withHealth);
    expect(snapshot?.asOf).toBe("2026-10-12");
    expect(series(snapshot, "stablecoinSupply")).toEqual([{ date: "2026-10-12", value: 15.89e9 }]);
    expect(series(snapshot, "stablecoinTransfers")).toEqual([
      { date: "2026-10-12", value: 14.28e6 },
    ]);
    expect(series(snapshot, "stablecoinShare")[0]?.value).toBeCloseTo((14.28e6 / 118.1e6) * 100);
    expect(series(snapshot, "costPerTransaction")[0]?.value).toBeCloseTo((8010 * 110) / 118.1e6);
  });

  it("leaves out today, still in progress, so every series ends on the last closed day", () => {
    const snapshot = buildNetworkReadings(
      tableOf({
        "2026-10-11": FULL_DAY,
        "2026-10-12": FULL_DAY,
        // Mid-day today only the price and the supply have landed.
        "2026-10-13": { "SOL Price": 106, "Circulating Supply": 15.9e9 },
      })
    );
    expect(snapshot?.asOf).toBe("2026-10-12");
    expect(lastDays(snapshot)).toEqual(Array(4).fill("2026-10-12"));
  });

  it("dates the snapshot to the day most readings share while one input has yet to report", () => {
    const snapshot = buildNetworkReadings(
      tableOf({
        "2026-10-11": FULL_DAY,
        // The 12th has closed, but its transaction count has not landed yet.
        "2026-10-12": { ...FULL_DAY, "Non Vote Transaction Count (Success)": undefined },
      })
    );
    expect(snapshot?.asOf).toBe("2026-10-11");
    expect(lastDays(snapshot)).toEqual(Array(4).fill("2026-10-11"));
  });

  it("gives every headline the same day, even when the readings' last days differ", () => {
    const snapshot = buildNetworkReadings(
      tableOf({
        "2026-10-09": FULL_DAY,
        "2026-10-10": FULL_DAY,
        // Transfers skip the 11th; supply stops after it.
        "2026-10-11": { ...FULL_DAY, "Transfer Count": undefined },
        "2026-10-12": { ...FULL_DAY, "Circulating Supply": undefined },
      })
    );
    expect(snapshot?.asOf).toBe("2026-10-10");
    expect(lastDays(snapshot)).toEqual(Array(4).fill("2026-10-10"));
  });

  it("skips a day a reading cannot be made on rather than drawing a zero", () => {
    const snapshot = buildNetworkReadings(
      tableOf({
        "2026-10-10": FULL_DAY,
        "2026-10-11": { ...FULL_DAY, "Non Vote Transaction Count (Success)": 0 },
        "2026-10-12": FULL_DAY,
      })
    );
    expect(series(snapshot, "stablecoinShare").map(({ date }) => date)).toEqual([
      "2026-10-10",
      "2026-10-12",
    ]);
    expect(series(snapshot, "stablecoinSupply")).toHaveLength(3);
  });

  it("drops a reading that stopped reporting instead of dating the whole snapshot to it", () => {
    const snapshot = buildNetworkReadings(
      tableOf({
        "2026-10-01": FULL_DAY,
        "2026-10-12": { ...FULL_DAY, Fees: undefined },
      })
    );
    expect(snapshot?.asOf).toBe("2026-10-12");
    expect(series(snapshot, "costPerTransaction")).toEqual([]);
    expect(series(snapshot, "stablecoinSupply").at(-1)?.date).toBe("2026-10-12");
  });

  it("keeps the year ending on its day", () => {
    const days: Record<string, Day> = {};
    for (let offset = 0; offset < 400; offset++) {
      const date = new Date(Date.parse("2026-10-12T00:00:00Z") - offset * 86_400_000);
      days[date.toISOString().slice(0, 10)] = FULL_DAY;
    }
    const points = series(buildNetworkReadings(tableOf(days)), "stablecoinSupply");
    expect(points).toHaveLength(365);
    expect(points[0]?.date).toBe("2025-10-13");
  });

  it("has nothing to draw without a single complete day", () => {
    expect(buildNetworkReadings(tableOf({}))).toBeNull();
  });
});
