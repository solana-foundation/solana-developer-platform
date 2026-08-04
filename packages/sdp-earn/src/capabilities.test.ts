import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { supportsPortfolioWallets } from "./capabilities";
import { EARN_PROVIDER_CLIENTS } from "./index";
import { GroundEarnClient } from "./providers/ground/client";

describe("supportsPortfolioWallets", () => {
  it("narrows the Ground client to the portfolio-wallet capability", () => {
    assert.equal(supportsPortfolioWallets(new GroundEarnClient()), true);
  });

  it("rejects stub clients that do not implement the capability", () => {
    assert.equal(supportsPortfolioWallets(EARN_PROVIDER_CLIENTS.veda), false);
    assert.equal(supportsPortfolioWallets(EARN_PROVIDER_CLIENTS.upshift), false);
    assert.equal(supportsPortfolioWallets(EARN_PROVIDER_CLIENTS.perena), false);
  });

  it("rejects a partial implementation rather than failing mid-flow", () => {
    // Prototype chain keeps the full EarnVaultProvider surface; only one
    // portfolio method is added on top, so the guard must still say no.
    const partial: typeof EARN_PROVIDER_CLIENTS.veda = Object.assign(
      Object.create(EARN_PROVIDER_CLIENTS.veda) as typeof EARN_PROVIDER_CLIENTS.veda,
      {
        createPortfolioWallet: async () => ({
          providerWalletRef: "w",
          status: "creating" as const,
        }),
      }
    );
    assert.equal(supportsPortfolioWallets(partial), false);
  });
});
