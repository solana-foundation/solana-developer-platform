import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOAD_BEARING_DVP_TRADE_STATUSES_SQL } from "@/services/stores/custody-config.store";
import { adminDatabaseUrl } from "@/test/helpers/env";

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

describe("0119 open settlement-authority index", () => {
  it("serves the custody deactivation guard's open-trade count", async () => {
    await client.query("BEGIN");
    try {
      // With sequential scans priced out, the plan only names the index when
      // its partial predicate still covers the guard's status list.
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT COUNT(*)
           FROM dvp_trades t
          WHERE t.settlement_authority = $1
            AND t.status IN ${LOAD_BEARING_DVP_TRADE_STATUSES_SQL}`,
        ["9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY"]
      );

      expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
        "idx_dvp_trades_open_settlement_authority"
      );
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
