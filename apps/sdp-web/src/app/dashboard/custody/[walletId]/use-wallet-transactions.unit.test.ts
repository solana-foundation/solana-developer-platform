import { describe, expect, it } from "vitest";
import { walletTransactionsApiQuery } from "./use-wallet-transactions";

describe("walletTransactionsApiQuery", () => {
  it("names the wallet and the page size, and leaves out what is not asked", () => {
    expect(walletTransactionsApiQuery({ custodyWalletId: "cwlt_one", limit: 5 })).toBe(
      "custodyWalletId=cwlt_one&limit=5"
    );
  });

  it("carries the cursor, the filters and the search as the API spells them", () => {
    expect(
      walletTransactionsApiQuery({
        custodyWalletId: "cwlt_one",
        limit: 25,
        cursor: "MjAyNi0wOS0xMXxwYXltZW50cw",
        status: "pending",
        module: "payments",
        kind: "deposit",
        search: "Dq73 a",
      })
    ).toBe(
      "custodyWalletId=cwlt_one&limit=25&cursor=MjAyNi0wOS0xMXxwYXltZW50cw&status=pending&module=payments&kind=deposit&search=Dq73+a"
    );
  });
});
