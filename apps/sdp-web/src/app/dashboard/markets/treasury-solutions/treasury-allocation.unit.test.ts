import { SOL_MINT, type WellKnownTokenSymbol, wellKnownMint } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  formatAllocationShare,
  heldVaultShareMints,
  summarizeTreasuryAllocation,
  type TreasuryAllocationBalance,
  type TreasuryAllocationPosition,
  type TreasuryAllocationWallet,
  type VaultShareMintVocabulary,
} from "./treasury-allocation";

function requiredMint(symbol: WellKnownTokenSymbol): string {
  const mint = wellKnownMint(symbol, "mainnet-beta");
  if (!mint) throw new Error(`Missing mainnet mint for ${symbol}`);
  return mint;
}

const USDC_MINT = requiredMint("USDC");
const USDG_MINT = requiredMint("USDG");
const UNKNOWN_MINT = "Unknown11111111111111111111111111111111111";
const ISSUED_MINT = "Issued11111111111111111111111111111111111111";
const SHARE_MINT = "Share1111111111111111111111111111111111111";
const UNRECORDED_SHARE_MINT = "ShareUnrecorded11111111111111111111111111111";

function wallet(
  balances: TreasuryAllocationBalance[] | undefined,
  id = "wallet-a",
  publicKey = `pk-${id}`
): TreasuryAllocationWallet {
  return { id, publicKey, balances };
}

function openPosition(overrides: Partial<TreasuryAllocationPosition>): TreasuryAllocationPosition {
  return {
    closedAt: null,
    custodyWalletId: "wallet-a",
    shareMint: SHARE_MINT,
    shares: "10",
    tokenMint: USDC_MINT,
    tokenValue: "1",
    ...overrides,
  };
}

/** Catalogue known and whole, which is the default precondition. */
function vocabulary(...known: string[]): VaultShareMintVocabulary {
  return { known: new Set(known), complete: true };
}

function summarize({
  positions,
  shareMints = vocabulary(SHARE_MINT),
  wallets,
}: {
  positions: TreasuryAllocationPosition[] | undefined;
  shareMints?: VaultShareMintVocabulary;
  wallets: TreasuryAllocationWallet[] | undefined;
}) {
  return summarizeTreasuryAllocation({ positions, shareMints, wallets });
}

describe("summarizeTreasuryAllocation figures", () => {
  it("totals multi-wallet cash and multi-position value into shares summing to exactly 100%", () => {
    const summary = summarize({
      wallets: [
        wallet([
          { mint: USDC_MINT, uiAmount: "1200.50" },
          // A SOL gas balance is not treasury cash.
          { mint: SOL_MINT, uiAmount: "3.5" },
        ]),
        wallet(
          [
            { mint: USDG_MINT, uiAmount: "800" },
            // Nor is a token nothing can price at a dollar.
            { mint: UNKNOWN_MINT, uiAmount: "42" },
          ],
          "wallet-b"
        ),
      ],
      positions: [
        openPosition({ tokenValue: "999.5" }),
        openPosition({ custodyWalletId: "wallet-b", tokenMint: USDG_MINT, tokenValue: "3000" }),
        // Zero shares and closed positions are not part of the rendered set.
        openPosition({ shares: "0", tokenValue: "77" }),
        openPosition({ closedAt: "2026-08-20T00:00:00.000Z", tokenValue: "88" }),
      ],
    });

    expect(summary.availableCash).toBe("2000.5");
    expect(summary.deployedValue).toBe("3999.5");
    expect(summary.deployedShare).toBe("0.667");
    expect(summary.remainingShare).toBe("0.333");
    expect(summary.sharesAbsence).toBeUndefined();
    expect(formatAllocationShare(summary.deployedShare, "en")).toBe("66.7%");
    expect(formatAllocationShare(summary.remainingShare, "en")).toBe("33.3%");
  });

  it("counts an SDP-issued stablecoin the static catalogue cannot know", () => {
    // The API prices everything it treats as USD-stable at exactly 1, issued
    // tokens included. Dropping those silently understated the float, and a
    // wallet holding only them read a real $0 with a confident 100% deployed.
    const summary = summarize({
      wallets: [
        wallet([
          { mint: ISSUED_MINT, uiAmount: "1000000", usdPrice: 1 },
          { mint: USDC_MINT, uiAmount: "100" },
          // Priced, but not at a dollar: not cash.
          { mint: UNKNOWN_MINT, uiAmount: "5", usdPrice: 173.42 },
        ]),
      ],
      positions: [],
    });

    expect(summary.availableCash).toBe("1000100");
    expect(summary.deployedShare).toBe("0");
    expect(summary.remainingShare).toBe("1");
  });

  it("does not count one on-chain wallet twice when it has several custody rows", () => {
    // Org-level and project-level configs both describe one address, and the
    // balance read keys off the address, so both rows carry the same balances.
    const balances: TreasuryAllocationBalance[] = [
      { mint: USDC_MINT, uiAmount: "500" },
      { mint: SHARE_MINT, uiAmount: "60" },
    ];
    const summary = summarize({
      wallets: [
        wallet(balances, "wallet-org", "pk-shared"),
        wallet(balances, "wallet-project", "pk-shared"),
      ],
      // Recorded against ONE row id, as positions always are.
      positions: [openPosition({ custodyWalletId: "wallet-org", tokenValue: "100" })],
    });

    expect(summary.availableCash).toBe("500");
    // And the sibling row's shares are not read as an unrecorded holding.
    expect(summary.deployedValue).toBe("100");
    expect(summary.deployedShare).toBe("0.167");
    expect(summary.unrecordedShareMints?.size).toBe(0);
  });

  it("makes both figures unavailable when any wallet balance cannot be read", () => {
    // An unread wallet may hold a receipt token with no recorded position, so
    // the recorded sum cannot be certified as the total. Unreadable is not empty.
    const summary = summarize({
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "500" }]), wallet(undefined, "wallet-b")],
      positions: [openPosition({ tokenValue: "125.25" })],
    });

    expect(summary.availableCash).toBeUndefined();
    expect(summary.deployedValue).toBeUndefined();
    expect(summary.deployedShare).toBeUndefined();
    expect(summary.sharesAbsence).toBe("unavailable");
    expect(summary.unrecordedShareMints).toBeUndefined();
    expect(formatAllocationShare(summary.deployedShare, "en")).toBe("—");
  });

  it("certifies nothing with no wallet inventory at all", () => {
    const summary = summarize({
      wallets: undefined,
      positions: [openPosition({ tokenValue: "125.25" })],
    });

    expect(summary.availableCash).toBeUndefined();
    expect(summary.deployedValue).toBeUndefined();
    expect(summary.unrecordedShareMints).toBeUndefined();
  });

  it("makes cash unavailable when a stable balance is malformed", () => {
    const summary = summarize({
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "12,5" }])],
      positions: [],
    });

    expect(summary.availableCash).toBeUndefined();
  });

  it("makes deployed unavailable when an open position cannot be hydrated", () => {
    const summary = summarize({
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "500" }])],
      positions: [openPosition({ tokenValue: undefined }), openPosition({ tokenValue: "40" })],
    });

    expect(summary.availableCash).toBe("500");
    expect(summary.deployedValue).toBeUndefined();
    expect(summary.deployedShare).toBeUndefined();
  });

  it("makes deployed unavailable when an open position value is malformed", () => {
    const summary = summarize({
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "500" }])],
      positions: [openPosition({ tokenValue: "12,5" })],
    });

    expect(summary.deployedValue).toBeUndefined();
  });

  it("makes deployed unavailable rather than pricing a non-USD-stable position at $1", () => {
    const summary = summarize({
      wallets: [wallet([])],
      positions: [openPosition({ tokenMint: SOL_MINT, tokenValue: "10" })],
    });

    expect(summary.deployedValue).toBeUndefined();
  });

  it("withholds only the shares when an open position's wallet is outside the read", () => {
    // The wallet read serves active wallets only, so that position's idle-cash
    // side is unobserved. Both dollar figures still render; the split would be
    // fabricated.
    const summary = summarize({
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "50" }])],
      positions: [openPosition({ custodyWalletId: "wallet-deactivated", tokenValue: "100" })],
    });

    expect(summary.availableCash).toBe("50");
    expect(summary.deployedValue).toBe("100");
    expect(summary.deployedShare).toBeUndefined();
    expect(summary.sharesAbsence).toBe("unavailable");
  });

  it("makes deployed unavailable when a wallet holds shares no open position records", () => {
    const summary = summarize({
      wallets: [
        wallet([
          { mint: USDC_MINT, uiAmount: "500" },
          { mint: UNRECORDED_SHARE_MINT, uiAmount: "60" },
        ]),
      ],
      positions: [openPosition({ tokenValue: "100" })],
      shareMints: vocabulary(SHARE_MINT, UNRECORDED_SHARE_MINT),
    });

    expect(summary.availableCash).toBe("500");
    expect(summary.deployedValue).toBeUndefined();
    expect(summary.unrecordedShareMints).toEqual(new Set([UNRECORDED_SHARE_MINT]));
  });

  it("does not treat a CLOSED position as recording a held share mint", () => {
    // The wallet still holds the receipt for a position SDP has marked closed,
    // so the exit did not actually complete and the total is not knowable.
    const summary = summarize({
      wallets: [
        wallet([
          { mint: USDC_MINT, uiAmount: "500" },
          { mint: SHARE_MINT, uiAmount: "60" },
        ]),
      ],
      positions: [openPosition({ closedAt: "2026-08-20T00:00:00.000Z", tokenValue: "100" })],
    });

    expect(summary.deployedValue).toBeUndefined();
    expect(summary.deployedAbsence).toBe("unreconciled");
    expect(summary.unrecordedShareMints).toEqual(new Set([SHARE_MINT]));
    expect(summary.deploymentByWalletId.get("wallet-a")).toEqual({ kind: "unavailable" });
  });

  it("names an unusable position value as unreadable, not as a reconciliation gap", () => {
    const summary = summarize({
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "500" }])],
      positions: [openPosition({ tokenValue: undefined })],
    });

    expect(summary.deployedAbsence).toBe("unreadable");
  });

  it("does not let one wallet's position cover another wallet's holding of the same mint", () => {
    const summary = summarize({
      wallets: [
        wallet([
          { mint: USDC_MINT, uiAmount: "500" },
          { mint: SHARE_MINT, uiAmount: "60" },
        ]),
        wallet([{ mint: SHARE_MINT, uiAmount: "25" }], "wallet-b"),
      ],
      positions: [openPosition({ custodyWalletId: "wallet-a", tokenValue: "100" })],
    });

    expect(summary.deployedValue).toBeUndefined();
    expect(summary.unrecordedShareMints).toEqual(new Set([SHARE_MINT]));
  });

  it("totals deployed when every held share mint has an open position behind it", () => {
    const summary = summarize({
      wallets: [
        wallet([
          { mint: USDC_MINT, uiAmount: "300" },
          { mint: SHARE_MINT, uiAmount: "60" },
        ]),
      ],
      positions: [openPosition({ tokenValue: "100" })],
    });

    expect(summary.deployedValue).toBe("100");
    expect(summary.deployedShare).toBe("0.25");
  });

  it("propagates failed reads as unavailable on both sides", () => {
    const summary = summarize({ wallets: undefined, positions: undefined });

    expect(summary.availableCash).toBeUndefined();
    expect(summary.deployedValue).toBeUndefined();
    expect(summary.sharesAbsence).toBe("unavailable");
  });

  it("reports real zeros for a readable empty treasury without inventing an allocation", () => {
    const summary = summarize({ wallets: [wallet([])], positions: [] });

    expect(summary.availableCash).toBe("0");
    expect(summary.deployedValue).toBe("0");
    expect(summary.deployedShare).toBeUndefined();
    // The caption reads from this, so it never re-derives intent from strings.
    expect(summary.sharesAbsence).toBe("empty_float");
  });

  it("reads a fully idle float as 0% deployed and a fully deployed one as 100%", () => {
    const idle = summarize({
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "500" }])],
      positions: [],
    });
    expect(idle.deployedShare).toBe("0");
    expect(idle.remainingShare).toBe("1");
    expect(formatAllocationShare(idle.deployedShare, "en")).toBe("0.0%");
    expect(formatAllocationShare(idle.remainingShare, "en")).toBe("100.0%");

    const deployed = summarize({
      wallets: [wallet([{ mint: SHARE_MINT, uiAmount: "60" }])],
      positions: [openPosition({ tokenValue: "800" })],
    });
    expect(deployed.deployedShare).toBe("1");
    expect(deployed.remainingShare).toBe("0");
  });

  it("rounds half-up to tenths of a percent and keeps the complement exact", () => {
    // 1 of 2000 is exactly 0.05%, which rounds up to 0.1%; the remaining share
    // is the complement so the pair still totals exactly 100%.
    const summary = summarize({
      wallets: [
        wallet([
          { mint: USDC_MINT, uiAmount: "1999" },
          { mint: SHARE_MINT, uiAmount: "1" },
        ]),
      ],
      positions: [openPosition({ tokenValue: "1" })],
    });

    expect(summary.deployedShare).toBe("0.001");
    expect(summary.remainingShare).toBe("0.999");
    expect(formatAllocationShare(summary.deployedShare, "en")).toBe("0.1%");
    expect(formatAllocationShare(summary.remainingShare, "en")).toBe("99.9%");
  });
});

describe("zero-balance share accounts", () => {
  // An emptied share account can outlive its position, and this payload
  // appends the SOL row at zero, so a zero row is a shape to handle rather
  // than an upstream invariant to lean on.
  it("is not a holding, so a fully exited treasury still totals", () => {
    const summary = summarize({
      wallets: [
        wallet([
          { mint: USDC_MINT, uiAmount: "500" },
          { mint: SHARE_MINT, uiAmount: "0" },
        ]),
      ],
      positions: [],
    });

    expect(summary.availableCash).toBe("500");
    expect(summary.deployedValue).toBe("0");
    expect(summary.deployedShare).toBe("0");
    expect(summary.deploymentByWalletId.get("wallet-a")).toEqual({ kind: "none" });
  });

  it("treats a trailing-zero form as zero and a dust amount as held", () => {
    expect(
      heldVaultShareMints(wallet([{ mint: SHARE_MINT, uiAmount: "0.000" }]), new Set([SHARE_MINT]))
    ).toEqual([]);
    expect(
      heldVaultShareMints(
        wallet([{ mint: SHARE_MINT, uiAmount: "0.000001" }]),
        new Set([SHARE_MINT])
      )
    ).toEqual([SHARE_MINT]);
  });

  it("treats an unparseable amount as held, since it is not evidence of empty", () => {
    expect(
      heldVaultShareMints(wallet([{ mint: SHARE_MINT, uiAmount: "1,5" }]), new Set([SHARE_MINT]))
    ).toEqual([SHARE_MINT]);
  });

  it("distinguishes unreadable balances from an empty wallet", () => {
    expect(heldVaultShareMints(wallet(undefined), new Set([SHARE_MINT]))).toBeUndefined();
    expect(heldVaultShareMints(wallet([]), new Set([SHARE_MINT]))).toEqual([]);
  });
});

describe("an incomplete share-mint vocabulary", () => {
  // The catalogue is the only witness that a token with no position row is a
  // receipt, so while it is not whole no deployed figure can be certified.
  const incomplete: VaultShareMintVocabulary = { known: new Set([SHARE_MINT]), complete: false };

  it("makes the deployed figure unavailable even when every position reads", () => {
    const summary = summarize({
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "500" }])],
      positions: [openPosition({ tokenValue: "100" })],
      shareMints: incomplete,
    });

    expect(summary.availableCash).toBe("500");
    expect(summary.deployedValue).toBeUndefined();
    expect(summary.deployedShare).toBeUndefined();
    expect(summary.unrecordedShareMints).toBeUndefined();
  });

  it("never reports a fully deployed wallet as an idle float", () => {
    // Positions read succeeds and is EMPTY while the catalogue is unavailable
    // and the wallet holds receipts: the fabrication this guard exists for.
    const summary = summarize({
      wallets: [
        wallet([
          { mint: USDC_MINT, uiAmount: "500" },
          { mint: SHARE_MINT, uiAmount: "60" },
        ]),
      ],
      positions: [],
      shareMints: incomplete,
    });

    expect(summary.deployedValue).toBeUndefined();
    expect(summary.deployedShare).toBeUndefined();
    expect(summary.remainingShare).toBeUndefined();
  });

  it("makes a wallet line with open positions unavailable, not a confident value", () => {
    const summary = summarize({
      wallets: [wallet([{ mint: SHARE_MINT, uiAmount: "60" }])],
      positions: [openPosition({ tokenValue: "100" })],
      shareMints: incomplete,
    });

    expect(summary.deploymentByWalletId.get("wallet-a")).toEqual({ kind: "unavailable" });
  });

  it("stays silent for a wallet with nothing deployed", () => {
    const summary = summarize({
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "500" }])],
      positions: [],
      shareMints: incomplete,
    });

    expect(summary.deploymentByWalletId.get("wallet-a")).toEqual({ kind: "none" });
  });
});

describe("per-wallet deployment lines", () => {
  it("reads unavailable when the balances could not be read, never as idle", () => {
    const withPosition = summarize({
      wallets: [wallet(undefined)],
      positions: [openPosition({ tokenValue: "100" })],
    });
    expect(withPosition.deploymentByWalletId.get("wallet-a")).toEqual({ kind: "unavailable" });

    // Even with no recorded position: unreadable balances cannot rule one out.
    const withoutPosition = summarize({ wallets: [wallet(undefined)], positions: [] });
    expect(withoutPosition.deploymentByWalletId.get("wallet-a")).toEqual({ kind: "unavailable" });
  });

  it("reads unavailable when the positions read failed but shares are held", () => {
    const summary = summarize({
      wallets: [wallet([{ mint: SHARE_MINT, uiAmount: "60" }])],
      positions: undefined,
    });
    expect(summary.deploymentByWalletId.get("wallet-a")).toEqual({ kind: "unavailable" });
  });

  it("stays silent when the positions read failed and no shares are held", () => {
    const summary = summarize({
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "10" }])],
      positions: undefined,
    });
    expect(summary.deploymentByWalletId.get("wallet-a")).toEqual({ kind: "none" });
  });

  it("counts only this wallet's positions, never another wallet's", () => {
    // wallet-b's position is larger and shares the mint, so an unscoped sum
    // would report the whole portfolio on wallet-a's line.
    const summary = summarize({
      wallets: [
        wallet([{ mint: SHARE_MINT, uiAmount: "60" }]),
        wallet([{ mint: SHARE_MINT, uiAmount: "60" }], "wallet-b"),
      ],
      positions: [
        openPosition({ custodyWalletId: "wallet-a", tokenValue: "100" }),
        openPosition({ custodyWalletId: "wallet-b", tokenValue: "500" }),
      ],
    });

    expect(summary.deploymentByWalletId.get("wallet-a")).toEqual({ kind: "value", value: "100" });
    expect(summary.deploymentByWalletId.get("wallet-b")).toEqual({ kind: "value", value: "500" });
  });

  it("reads unavailable when a recorded position cannot be valued", () => {
    const summary = summarize({
      wallets: [wallet([{ mint: SHARE_MINT, uiAmount: "60" }])],
      positions: [openPosition({ tokenValue: undefined })],
    });
    expect(summary.deploymentByWalletId.get("wallet-a")).toEqual({ kind: "unavailable" });
  });

  it("reads none for a wallet with neither shares nor open positions", () => {
    const summary = summarize({
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "10" }])],
      positions: [openPosition({ shares: "0", tokenValue: "9" })],
    });
    expect(summary.deploymentByWalletId.get("wallet-a")).toEqual({ kind: "none" });
  });
});

describe("no two surfaces disagree", () => {
  // Most bugs found in review here were the summary claiming a figure a wallet
  // line had already given up on. Every surface now reads one result, and this
  // pins the implication across the state matrix.
  const shareMints = vocabulary(SHARE_MINT, UNRECORDED_SHARE_MINT);
  const cash = { mint: USDC_MINT, uiAmount: "500" };
  const heldShare = { mint: SHARE_MINT, uiAmount: "60" };
  const heldUnrecorded = { mint: UNRECORDED_SHARE_MINT, uiAmount: "60" };

  const scenarios: Array<{
    name: string;
    wallets: TreasuryAllocationWallet[] | undefined;
    positions: TreasuryAllocationPosition[] | undefined;
    shareMints?: VaultShareMintVocabulary;
  }> = [
    { name: "cash only", wallets: [wallet([cash])], positions: [] },
    {
      name: "recorded holding",
      wallets: [wallet([cash, heldShare])],
      positions: [openPosition({ tokenValue: "100" })],
    },
    {
      name: "unrecorded holding",
      wallets: [wallet([cash, heldUnrecorded])],
      positions: [openPosition({ tokenValue: "100" })],
    },
    {
      name: "cross-wallet holding of a recorded mint",
      wallets: [wallet([cash, heldShare]), wallet([heldShare], "wallet-b")],
      positions: [openPosition({ tokenValue: "100" })],
    },
    {
      name: "unhydratable position",
      wallets: [wallet([cash, heldShare])],
      positions: [openPosition({ tokenValue: undefined })],
    },
    {
      name: "non-stable position token",
      wallets: [wallet([cash, heldShare])],
      positions: [openPosition({ tokenMint: SOL_MINT, tokenValue: "10" })],
    },
    { name: "positions unavailable", wallets: [wallet([cash, heldShare])], positions: undefined },
    {
      name: "one wallet's balances unreadable",
      wallets: [wallet([cash, heldShare]), wallet(undefined, "wallet-b")],
      positions: [openPosition({ tokenValue: "100" })],
    },
    {
      name: "incomplete vocabulary",
      wallets: [wallet([cash, heldShare])],
      positions: [openPosition({ tokenValue: "100" })],
      shareMints: { known: new Set([SHARE_MINT]), complete: false },
    },
    {
      name: "zero share account",
      wallets: [wallet([cash, { mint: SHARE_MINT, uiAmount: "0" }])],
      positions: [],
    },
    { name: "duplicate custody rows", wallets: undefined, positions: [] },
  ];

  for (const scenario of scenarios) {
    it(`holds for: ${scenario.name}`, () => {
      const summary = summarizeTreasuryAllocation({
        positions: scenario.positions,
        shareMints: scenario.shareMints ?? shareMints,
        wallets: scenario.wallets,
      });

      const anyWalletUnavailable = [...summary.deploymentByWalletId.values()].some(
        (line) => line.kind === "unavailable"
      );
      if (anyWalletUnavailable) {
        expect(summary.deployedValue).toBeUndefined();
        expect(summary.deployedShare).toBeUndefined();
        expect(summary.remainingShare).toBeUndefined();
      }

      // Note the implication runs ONE way only. The converse does not hold and
      // must not be asserted: when a DIFFERENT wallet is the uncertain one, a
      // readable wallet's own figure is still true, and blanking it would hide
      // real information rather than protect anyone.

      // Shares are published only with both figures behind them, and their
      // absence always carries a reason.
      if (summary.deployedShare !== undefined) {
        expect(summary.availableCash).not.toBeUndefined();
        expect(summary.deployedValue).not.toBeUndefined();
        expect(summary.sharesAbsence).toBeUndefined();
      } else {
        expect(summary.sharesAbsence).not.toBeUndefined();
      }

      // The pair is always both-or-neither, and always totals 100%.
      expect(summary.deployedShare === undefined).toBe(summary.remainingShare === undefined);
      if (summary.deployedShare !== undefined && summary.remainingShare !== undefined) {
        const deployedTenths = Number(summary.deployedShare) * 1000;
        const remainingTenths = Number(summary.remainingShare) * 1000;
        expect(Math.round(deployedTenths + remainingTenths)).toBe(1000);
      }

      // A strategy row can only claim "no active position" when the witness
      // exists, and the deployed total is certified exactly when it is empty.
      if (summary.unrecordedShareMints === undefined) {
        expect(summary.deployedValue).toBeUndefined();
      }
    });
  }
});
