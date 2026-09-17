import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RAMP_TRANSFER_STATUS_BVNK_ONRAMP_IN_FLIGHT } from "@sdp/types";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0114_bvnk_onramp_rule_lock.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");

describe("0114 bvnk onramp rule lock", () => {
  it("locks exactly the in-flight statuses the type export declares", () => {
    const match = /status\s+IN\s*\(([^)]*)\)/.exec(migrationSql);
    expect(match).not.toBeNull();
    const statuses = (match?.[1] ?? "")
      .split(",")
      .map((part) => part.trim().replace(/^'/, "").replace(/'$/, ""));
    expect(statuses).toEqual([...RAMP_TRANSFER_STATUS_BVNK_ONRAMP_IN_FLIGHT]);
  });

  it("indexes bvnk onramp transfers by the funding wallet account id", () => {
    expect(migrationSql).toContain(
      "payment_transfers_bvnk_onramp_in_flight_unique"
    );
    expect(migrationSql).toContain("provider_data->'bvnk'->>'fundingWalletAccountId'");
    expect(migrationSql).toContain("provider = 'bvnk'");
    expect(migrationSql).toContain("type = 'onramp'");
  });
});
