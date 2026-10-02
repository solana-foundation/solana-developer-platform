import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderUnifiedTransactionsView } from "../../../scripts/unified-transactions-view";

describe("unified transactions repeatable view", () => {
  it("matches the generated source", async () => {
    const committed = await readFile(
      path.resolve(process.cwd(), "src/db/migrations/postgres/repeatable/unified_transactions.sql"),
      "utf8"
    );
    expect(renderUnifiedTransactionsView()).toBe(committed);
  });

  it("uses latest-schema custody joins and exact base-unit conversion", () => {
    const view = renderUnifiedTransactionsView();
    expect(view).toContain(
      "LEFT JOIN dvp_leg_funding_claims c ON c.trade_id = t.id AND c.side = side.value"
    );
    expect(view).not.toContain("t.sdp_side");
    expect(view).not.toContain("t.sdp_wallet_id");
    expect(view).toContain("10::numeric ^ CASE c.side");
    expect(view).toContain("LEFT JOIN helius_rings_asset_allowlist al ON al.mint = o.asset_mint");
    expect(view).toContain("o.amount_raw::numeric / (10::numeric ^ al.decimals)");
  });

  it("projects the counterparty address and issuance amount from each source", () => {
    const view = renderUnifiedTransactionsView();
    expect(view).toContain(
      "CASE WHEN pt.direction = 'inbound' THEN pt.source_address ELSE pt.destination_address END AS counterparty_address"
    );
    expect(view).toContain("params.value ->> 'amount' AS amount");
    expect(view).toContain(
      "CASE WHEN pg_input_is_valid(it.operation_params, 'jsonb') THEN it.operation_params::jsonb END AS value"
    );
    expect(view).toContain(
      [
        "COALESCE(",
        "    params.value ->> 'source',",
        "    params.value ->> 'destination',",
        "    params.value ->> 'accountAddress',",
        "    params.value ->> 'tokenAccount',",
        "    params.value ->> 'currentAuthority',",
        "    params.value ->> 'newAuthority'",
        "  ) AS counterparty_address",
      ].join("\n")
    );
    expect(view).toContain(
      "CASE c.side WHEN 'a' THEN t.user_b WHEN 'b' THEN t.user_a END AS counterparty_address"
    );
    expect(view).toContain(
      "recipient AS counterparty_address, signature, created_at FROM private_channel_transfers"
    );
    expect(view).toContain("unified.counterparty_address,");
    // Every branch feeds the same column into the UNION, so each module's
    // SELECT must carry it in the shared position.
    expect(view.match(/^ {2}counterparty_address,$/gm)).toHaveLength(6);
  });
});
