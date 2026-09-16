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
});
