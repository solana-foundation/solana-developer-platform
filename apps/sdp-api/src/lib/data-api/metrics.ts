/**
 * data.solana.com's `/v1/metrics` payload, indexed for reading. Read with `?provider=preferred`,
 * it holds the data team's pick for each metric: one value per metric and UTC day for the past
 * year, as decimal strings. Consumers read a figure by metric name and day from the table instead
 * of walking the rows.
 */
import { z } from "zod";

const metricRowSchema = z.object({
  date: z.iso.date(),
  metric_name: z.string().min(1),
  value: z
    .union([z.string().trim().min(1), z.number()])
    .transform(Number)
    .pipe(z.number().finite()),
});
type DataApiMetricRow = z.output<typeof metricRowSchema>;

/** The rows, each checked on its own: one that fails is counted and left out, so a malformed row
 * of an unrelated metric cannot blank every reading. */
const metricRowsSchema = z.array(z.unknown()).transform((rows) => {
  const read: DataApiMetricRow[] = [];
  for (const row of rows) {
    const parsed = metricRowSchema.safeParse(row);
    if (parsed.success) read.push(parsed.data);
  }
  return { read, rejected: rows.length - read.length };
});

export const dataApiMetricsResponseSchema = z.object({
  data: z.object({
    /** When the API built the response: the clock that tells a closed day from one in progress. */
    generatedAt: z.iso.datetime({ offset: true }),
    /** The API cut the rows short: a partial year must never chart as a whole one. */
    truncated: z.boolean(),
    rows: metricRowsSchema,
  }),
});
export type DataApiMetrics = z.output<typeof dataApiMetricsResponseSchema>["data"];

export interface DataApiMetricTable {
  generatedAt: string;
  /** Rows the schema refused, and second values for a metric's day. They are logged and left
   * out, so one bad row cannot blank every reading. */
  rejectedRows: number;
  /** Per metric name, per closed UTC day, its value. */
  values: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

/**
 * Indexes the rows by metric and UTC day. A row dated on `generatedAt`'s UTC day or later is a
 * day still in progress whose value keeps moving, so it is left out: every figure is a closed
 * day's. The data team picks one value per metric and day; a second one is counted as rejected.
 */
export function indexMetricRows({ generatedAt, rows }: DataApiMetrics): DataApiMetricTable {
  const inProgress = new Date(generatedAt).toISOString().slice(0, 10);
  const values = new Map<string, Map<string, number>>();
  let rejectedRows = rows.rejected;
  for (const { metric_name: metric, date, value } of rows.read) {
    if (date >= inProgress) continue;
    let byDay = values.get(metric);
    if (!byDay) {
      byDay = new Map();
      values.set(metric, byDay);
    }
    if (byDay.has(date)) rejectedRows++;
    else byDay.set(date, value);
  }
  return { generatedAt, rejectedRows, values };
}
