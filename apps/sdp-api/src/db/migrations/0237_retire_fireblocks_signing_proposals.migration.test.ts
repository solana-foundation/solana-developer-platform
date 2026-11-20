import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalProposalMigrationFixture, sql } from "@/test/helpers/proposal-migrations";

const { client, schema, setup, teardown, legacyProposal, migrate } =
  canonicalProposalMigrationFixture();
const retireSql = sql("0237_retire_fireblocks_signing_proposals.sql");
beforeAll(() => client.connect());
afterAll(() => client.end());
beforeEach(setup);
afterEach(teardown);

describe("retire duplicate Fireblocks proposal storage", () => {
  it.each([null, "different_provider_id"])(
    "retains legacy acceptance when canonical ID is %s",
    async (providerId) => {
      await legacyProposal();
      await migrate();
      await client.query(
        "UPDATE custody_proposals SET provider_transaction_id = $1, provider_phase = $2 WHERE id = 'fbp_original'",
        [providerId, providerId === null ? "submitting" : "pending"]
      );
      await expect(client.query(retireSql)).rejects.toThrow("have not been preserved");
    }
  );

  it("retains legacy cancellation evidence when canonical refusal is missing", async () => {
    await legacyProposal("fbp_original", "PENDING_AUTHORIZATION", "2026-11-20T00:00:00.000Z");
    await migrate();
    await client.query(
      "UPDATE custody_proposals SET refused_at = NULL, refusal_reason = NULL, refusal_message = NULL, authorization_state = 'authorized' WHERE id = 'fbp_original'"
    );
    await expect(client.query(retireSql)).rejects.toThrow("have not been preserved");
  });

  it("refuses retirement when a legacy proposal is missing from canonical storage", async () => {
    await legacyProposal();
    await migrate();
    await client.query("DELETE FROM custody_proposals WHERE id = 'fbp_original'");
    await expect(client.query(retireSql)).rejects.toThrow("have not been preserved");
    expect((await client.query("SELECT id FROM fireblocks_signing_proposals")).rows).toEqual([
      { id: "fbp_original" },
    ]);
  });

  it("retires the legacy table only after copying both active and completed proposals", async () => {
    await legacyProposal();
    await legacyProposal("fbp_signed", "SIGNED");
    await migrate();
    await client.query(retireSql);
    expect(
      (
        await client.query("SELECT to_regclass($1) AS legacy", [
          `${schema}.fireblocks_signing_proposals`,
        ])
      ).rows
    ).toEqual([{ legacy: null }]);
    expect((await client.query("SELECT id FROM custody_proposals ORDER BY id")).rows).toEqual([
      { id: "fbp_original" },
      { id: "fbp_signed" },
    ]);
  });
});
