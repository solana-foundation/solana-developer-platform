import { SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKENS } from "@sdp/types";
import { describe, expect, it } from "vitest";
import type { DvpCreateOption } from "./dvp-create.data";
import { assetOptionsFor, cashOptionsFor } from "./dvp-leg-options";

const ISSUED: DvpCreateOption = {
  mint: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
  label: "TBOND",
  name: "Test Bond",
  decimals: 6,
  tokenProgram: SPL_TOKEN_PROGRAMS["token-2022"],
};

describe("cashOptionsFor", () => {
  it("offers only the cluster's USD stablecoins", () => {
    const options = cashOptionsFor("devnet");

    expect(options.map((option) => option.label)).toContain("USDC");
    // Deployed on devnet but not a USD stable, so the cash leg must not offer it.
    expect(options.map((option) => option.label)).not.toContain("JitoSOL");
  });
});

describe("assetOptionsFor", () => {
  // The whole point of PRO-2016: an org that has issued nothing still has an
  // asset leg it can fill, because the catalogue backs it.
  it("offers the cluster catalogue when the org has issued nothing", () => {
    const options = assetOptionsFor("devnet", []);

    expect(options.length).toBeGreaterThan(0);
    expect(options.map((option) => option.label)).toEqual(expect.arrayContaining(["SOL", "USDC"]));
  });

  // The org's own token is the likelier pick, so it must not be buried under
  // a catalogue that is the same on every cluster.
  it("puts the org's issued tokens first", () => {
    const options = assetOptionsFor("devnet", [ISSUED]);

    expect(options[0]).toEqual(ISSUED);
  });

  // A mint appearing in both lists is one asset, and the org's own row carries
  // its naming; two rows for one mint would read as two different tokens.
  it("keeps one entry per mint, preferring the issued one", () => {
    const usdcDevnet = WELL_KNOWN_TOKENS.USDC.mints.devnet;
    if (!usdcDevnet) {
      throw new Error("USDC has no devnet mint to build this case from");
    }
    const issuedUsdc: DvpCreateOption = { ...ISSUED, mint: usdcDevnet.address, label: "House USD" };

    const options = assetOptionsFor("devnet", [issuedUsdc]);
    const matches = options.filter((option) => option.mint === usdcDevnet.address);

    expect(matches).toEqual([issuedUsdc]);
  });

  // Decimals and owning program come from the catalogue entry, never assumed:
  // USDC is legacy SPL Token, and declaring it Token-2022 makes create refuse
  // the leg, because the escrow address derives from the program.
  it("carries each catalogue mint's own scale and token program", () => {
    const usdc = assetOptionsFor("devnet", []).find((option) => option.label === "USDC");

    expect(usdc?.decimals).toBe(6);
    expect(usdc?.tokenProgram).toBe(SPL_TOKEN_PROGRAMS["spl-token"]);
  });
});
