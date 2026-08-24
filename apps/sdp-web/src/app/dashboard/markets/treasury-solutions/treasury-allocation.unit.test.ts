import { SOL_MINT, type WellKnownTokenSymbol, wellKnownMint } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  formatAllocationShare,
  heldVaultShareMints,
  summarizeTreasuryAllocation,
  type TreasuryAllocationPosition,
  type TreasuryAllocationWallet,
  walletDeployment,
} from "./treasury-allocation";

function requiredMint(symbol: WellKnownTokenSymbol): string {
  const mint = wellKnownMint(symbol, "mainnet-beta");
  if (!mint) throw new Error(`Missing mainnet mint for ${symbol}`);
  return mint;
}

const USDC_MINT = requiredMint("USDC");
const USDG_MINT = requiredMint("USDG");
const UNKNOWN_MINT = "Unknown11111111111111111111111111111111111";
const SHARE_MINT = "Share1111111111111111111111111111111111111";
const UNRECORDED_SHARE_MINT = "ShareUnrecorded11111111111111111111111111111";

function wallet(
  balances: { mint: string; uiAmount: string }[] | undefined,
  id = "wallet-a"
): TreasuryAllocationWallet {
  return { id, balances };
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

describe("summarizeTreasuryAllocation", () => {
  it("totals multi-wallet cash and multi-position value into shares summing to exactly 100%", () => {
    const summary = summarizeTreasuryAllocation({
      shareMints: { known: new Set(), complete: true },
      wallets: [
        wallet([
          { mint: USDC_MINT, uiAmount: "1200.50" },
          // A SOL gas balance is not treasury cash.
          { mint: SOL_MINT, uiAmount: "3.5" },
        ]),
        wallet(
          [
            { mint: USDG_MINT, uiAmount: "800" },
            // Neither is a token the catalogue cannot price at $1.
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
    expect(formatAllocationShare(summary.deployedShare, "en")).toBe("66.7%");
    expect(formatAllocationShare(summary.remainingShare, "en")).toBe("33.3%");
  });

  it("makes both figures unavailable when any wallet balance cannot be read, never zero", () => {
    // Deployed goes too, not just cash: an unread wallet may hold a receipt
    // token with no recorded position, so the recorded sum cannot be certified
    // as the total. Unreadable is not empty.
    const summary = summarizeTreasuryAllocation({
      shareMints: { known: new Set([SHARE_MINT]), complete: true },
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "500" }]), wallet(undefined, "wallet-b")],
      positions: [openPosition({ tokenValue: "125.25" })],
    });

    expect(summary.availableCash).toBeUndefined();
    expect(summary.deployedValue).toBeUndefined();
    expect(summary.deployedShare).toBeUndefined();
    expect(summary.remainingShare).toBeUndefined();
    expect(formatAllocationShare(summary.deployedShare, "en")).toBe("—");
  });

  it("cannot certify a total with no wallet inventory at all", () => {
    // The one-level-up form of the same gap: an absent list must not pass the
    // coverage check vacuously.
    const summary = summarizeTreasuryAllocation({
      shareMints: { known: new Set([SHARE_MINT]), complete: true },
      wallets: undefined,
      positions: [openPosition({ tokenValue: "125.25" })],
    });

    expect(summary.availableCash).toBeUndefined();
    expect(summary.deployedValue).toBeUndefined();
    expect(summary.deployedShare).toBeUndefined();
  });

  it("reads an unreadable wallet's deployment as unavailable, never as idle", () => {
    expect(
      walletDeployment({
        positions: [openPosition({ tokenValue: "100" })],
        shareMints: { known: new Set([SHARE_MINT]), complete: true },
        wallet: wallet(undefined),
      })
    ).toEqual({ kind: "unavailable" });
    // Even with no recorded position: unreadable balances cannot rule out one.
    expect(
      walletDeployment({
        positions: [],
        shareMints: { known: new Set([SHARE_MINT]), complete: true },
        wallet: wallet(undefined),
      })
    ).toEqual({ kind: "unavailable" });
  });

  it("makes cash unavailable when a stable balance is malformed", () => {
    const summary = summarizeTreasuryAllocation({
      shareMints: { known: new Set(), complete: true },
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "12,5" }])],
      positions: [],
    });

    expect(summary.availableCash).toBeUndefined();
  });

  it("makes deployed unavailable when any open position cannot be hydrated, never zero", () => {
    const summary = summarizeTreasuryAllocation({
      shareMints: { known: new Set(), complete: true },
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "500" }])],
      positions: [openPosition({ tokenValue: undefined }), openPosition({ tokenValue: "40" })],
    });

    expect(summary.availableCash).toBe("500");
    expect(summary.deployedValue).toBeUndefined();
    expect(summary.deployedShare).toBeUndefined();
    expect(summary.remainingShare).toBeUndefined();
  });

  it("makes deployed unavailable when an open position value is malformed", () => {
    const summary = summarizeTreasuryAllocation({
      shareMints: { known: new Set(), complete: true },
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "500" }])],
      positions: [openPosition({ tokenValue: "12,5" })],
    });

    expect(summary.deployedValue).toBeUndefined();
    expect(summary.deployedShare).toBeUndefined();
  });

  it("makes deployed unavailable rather than pricing a non-USD-stable position at $1", () => {
    const summary = summarizeTreasuryAllocation({
      shareMints: { known: new Set(), complete: true },
      wallets: [wallet([])],
      positions: [openPosition({ tokenMint: SOL_MINT, tokenValue: "10" })],
    });

    expect(summary.deployedValue).toBeUndefined();
  });

  it("withholds shares when an open position's custody wallet is not in the wallet read", () => {
    // The wallet read serves active wallets only, so this position's idle-cash
    // side is unobserved: both dollar figures still render, but a percentage
    // split would be fabricated.
    const summary = summarizeTreasuryAllocation({
      shareMints: { known: new Set(), complete: true },
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "50" }])],
      positions: [openPosition({ custodyWalletId: "wallet-deactivated", tokenValue: "100" })],
    });

    expect(summary.availableCash).toBe("50");
    expect(summary.deployedValue).toBe("100");
    expect(summary.deployedShare).toBeUndefined();
    expect(summary.remainingShare).toBeUndefined();
  });

  it("makes deployed unavailable when a wallet holds shares no open position records", () => {
    // Deposited outside SDP: the receipt token is in the wallet but there is
    // no position row, so the recorded sum is not the deployed TOTAL.
    const summary = summarizeTreasuryAllocation({
      wallets: [
        wallet([
          { mint: USDC_MINT, uiAmount: "500" },
          { mint: UNRECORDED_SHARE_MINT, uiAmount: "60" },
        ]),
      ],
      positions: [openPosition({ tokenValue: "100" })],
      shareMints: { known: new Set([SHARE_MINT, UNRECORDED_SHARE_MINT]), complete: true },
    });

    expect(summary.availableCash).toBe("500");
    expect(summary.deployedValue).toBeUndefined();
    expect(summary.deployedShare).toBeUndefined();
    expect(summary.remainingShare).toBeUndefined();
  });

  it("does not let one wallet's position cover another wallet's holding of the same mint", () => {
    // Same vault, two wallets, one recorded position. A portfolio-wide mint set
    // would accept wallet-b's shares as covered and publish a confident split
    // over an incomplete total.
    const summary = summarizeTreasuryAllocation({
      wallets: [
        wallet([
          { mint: USDC_MINT, uiAmount: "500" },
          { mint: SHARE_MINT, uiAmount: "60" },
        ]),
        wallet([{ mint: SHARE_MINT, uiAmount: "25" }], "wallet-b"),
      ],
      positions: [openPosition({ custodyWalletId: "wallet-a", tokenValue: "100" })],
      shareMints: { known: new Set([SHARE_MINT]), complete: true },
    });

    expect(summary.availableCash).toBe("500");
    expect(summary.deployedValue).toBeUndefined();
    expect(summary.deployedShare).toBeUndefined();
    expect(summary.remainingShare).toBeUndefined();
  });

  it("still totals deployed when every held share mint has an open position", () => {
    const summary = summarizeTreasuryAllocation({
      wallets: [
        wallet([
          { mint: USDC_MINT, uiAmount: "300" },
          { mint: SHARE_MINT, uiAmount: "60" },
        ]),
      ],
      positions: [openPosition({ tokenValue: "100" })],
      shareMints: { known: new Set([SHARE_MINT]), complete: true },
    });

    expect(summary.availableCash).toBe("300");
    expect(summary.deployedValue).toBe("100");
    expect(summary.deployedShare).toBe("0.25");
  });

  it("propagates failed reads as unavailable on both sides", () => {
    const summary = summarizeTreasuryAllocation({
      shareMints: { known: new Set(), complete: true },
      wallets: undefined,
      positions: undefined,
    });

    expect(summary.availableCash).toBeUndefined();
    expect(summary.deployedValue).toBeUndefined();
    expect(summary.deployedShare).toBeUndefined();
  });

  it("reports real zeros for a readable empty treasury without inventing an allocation", () => {
    const summary = summarizeTreasuryAllocation({
      shareMints: { known: new Set(), complete: true },
      wallets: [wallet([])],
      positions: [],
    });

    expect(summary.availableCash).toBe("0");
    expect(summary.deployedValue).toBe("0");
    expect(summary.deployedShare).toBeUndefined();
    expect(summary.remainingShare).toBeUndefined();
  });

  it("reads a fully idle float as 0% deployed and 100% remaining", () => {
    const summary = summarizeTreasuryAllocation({
      shareMints: { known: new Set(), complete: true },
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "500" }])],
      positions: [],
    });

    expect(summary.deployedShare).toBe("0");
    expect(summary.remainingShare).toBe("1");
    expect(formatAllocationShare(summary.deployedShare, "en")).toBe("0.0%");
    expect(formatAllocationShare(summary.remainingShare, "en")).toBe("100.0%");
  });

  it("reads a fully deployed float as 100% deployed", () => {
    const summary = summarizeTreasuryAllocation({
      shareMints: { known: new Set(), complete: true },
      wallets: [wallet([])],
      positions: [openPosition({ tokenValue: "800" })],
    });

    expect(summary.deployedShare).toBe("1");
    expect(summary.remainingShare).toBe("0");
  });

  it("rounds half-up to tenths of a percent and keeps the complement exact", () => {
    // 1 of 2000 is exactly 0.05%, which rounds up to 0.1%; the remaining
    // share is the complement so the pair still totals exactly 100%.
    const summary = summarizeTreasuryAllocation({
      shareMints: { known: new Set(), complete: true },
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "1999" }])],
      positions: [openPosition({ tokenValue: "1" })],
    });

    expect(summary.deployedShare).toBe("0.001");
    expect(summary.remainingShare).toBe("0.999");
    expect(formatAllocationShare(summary.deployedShare, "en")).toBe("0.1%");
    expect(formatAllocationShare(summary.remainingShare, "en")).toBe("99.9%");
  });
});

describe("walletDeployment", () => {
  it("reads unavailable when the positions read failed but the wallet holds shares", () => {
    expect(
      walletDeployment({
        positions: undefined,
        shareMints: { known: new Set([SHARE_MINT]), complete: true },
        wallet: wallet([{ mint: SHARE_MINT, uiAmount: "60" }]),
      })
    ).toEqual({ kind: "unavailable" });
  });

  it("reads none when the positions read failed and the wallet holds no shares", () => {
    expect(
      walletDeployment({
        positions: undefined,
        shareMints: { known: new Set([SHARE_MINT]), complete: true },
        wallet: wallet([{ mint: USDC_MINT, uiAmount: "10" }]),
      })
    ).toEqual({ kind: "none" });
  });

  it("reads unavailable for a held share mint no open position records", () => {
    // The bot's case: the strategy left the catalogue, or the position was
    // opened outside SDP. Hiding the tile AND the line would erase it.
    expect(
      walletDeployment({
        positions: [openPosition({ tokenValue: "40" })],
        shareMints: { known: new Set([SHARE_MINT, UNRECORDED_SHARE_MINT]), complete: true },
        wallet: wallet([{ mint: UNRECORDED_SHARE_MINT, uiAmount: "5" }]),
      })
    ).toEqual({ kind: "unavailable" });
  });

  it("totals the recorded positions when every held share mint is accounted for", () => {
    expect(
      walletDeployment({
        positions: [openPosition({ tokenValue: "40" }), openPosition({ tokenValue: "2.5" })],
        shareMints: { known: new Set([SHARE_MINT]), complete: true },
        wallet: wallet([{ mint: SHARE_MINT, uiAmount: "60" }]),
      })
    ).toEqual({ kind: "value", value: "42.5" });
  });

  it("counts only this wallet's positions, never another wallet's", () => {
    // wallet-b's position is larger and shares the mint, so an unscoped sum
    // would report the whole portfolio on wallet-a's line.
    expect(
      walletDeployment({
        positions: [
          openPosition({ custodyWalletId: "wallet-a", tokenValue: "100" }),
          openPosition({ custodyWalletId: "wallet-b", tokenValue: "500" }),
        ],
        shareMints: { known: new Set([SHARE_MINT]), complete: true },
        wallet: wallet([{ mint: SHARE_MINT, uiAmount: "60" }]),
      })
    ).toEqual({ kind: "value", value: "100" });
  });

  it("reads none for a wallet with neither shares nor open positions", () => {
    expect(
      walletDeployment({
        positions: [openPosition({ shares: "0", tokenValue: "9" })],
        shareMints: { known: new Set([SHARE_MINT]), complete: true },
        wallet: wallet([]),
      })
    ).toEqual({ kind: "none" });
  });

  it("reads unavailable when a recorded position cannot be valued", () => {
    expect(
      walletDeployment({
        positions: [openPosition({ tokenValue: undefined })],
        shareMints: { known: new Set([SHARE_MINT]), complete: true },
        wallet: wallet([{ mint: SHARE_MINT, uiAmount: "60" }]),
      })
    ).toEqual({ kind: "unavailable" });
  });
});

describe("zero-balance share accounts", () => {
  // An emptied share account can outlive its position, and this payload
  // appends the SOL row at zero, so a zero row is a shape to handle rather
  // than an upstream invariant to lean on.
  const vaultShareMints = new Set([SHARE_MINT]);

  it("is not a holding, so a fully exited treasury still totals", () => {
    const summary = summarizeTreasuryAllocation({
      shareMints: { known: vaultShareMints, complete: true },
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
    expect(summary.remainingShare).toBe("1");
  });

  it("leaves the wallet line silent rather than unavailable", () => {
    expect(
      walletDeployment({
        positions: [],
        shareMints: { known: vaultShareMints, complete: true },
        wallet: wallet([{ mint: SHARE_MINT, uiAmount: "0" }]),
      })
    ).toEqual({ kind: "none" });
  });

  it("treats a trailing-zero form as zero and a dust amount as held", () => {
    expect(
      heldVaultShareMints(wallet([{ mint: SHARE_MINT, uiAmount: "0.000" }]), vaultShareMints)
    ).toEqual([]);
    expect(
      heldVaultShareMints(wallet([{ mint: SHARE_MINT, uiAmount: "0.000001" }]), vaultShareMints)
    ).toEqual([SHARE_MINT]);
  });

  it("treats an unparseable amount as held, since it is not evidence of empty", () => {
    expect(
      heldVaultShareMints(wallet([{ mint: SHARE_MINT, uiAmount: "1,5" }]), vaultShareMints)
    ).toEqual([SHARE_MINT]);
  });
});

describe("summary and wallet lines never disagree", () => {
  // Two of the three bugs found in review were the summary claiming a figure
  // a wallet line had already given up on. This pins the implication across
  // the state matrix: any wallet reading unavailable forces the summary's
  // deployed figure unavailable.
  const vaultShareMints = new Set([SHARE_MINT, UNRECORDED_SHARE_MINT]);
  const cash = { mint: USDC_MINT, uiAmount: "500" };
  const heldShare = { mint: SHARE_MINT, uiAmount: "60" };
  const heldUnrecorded = { mint: UNRECORDED_SHARE_MINT, uiAmount: "60" };

  const scenarios: Array<{
    name: string;
    wallets: TreasuryAllocationWallet[];
    positions: TreasuryAllocationPosition[] | undefined;
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
      name: "zero share account",
      wallets: [wallet([cash, { mint: SHARE_MINT, uiAmount: "0" }])],
      positions: [],
    },
  ];

  for (const scenario of scenarios) {
    it(`holds for: ${scenario.name}`, () => {
      const summary = summarizeTreasuryAllocation({
        positions: scenario.positions,
        shareMints: { known: vaultShareMints, complete: true },
        wallets: scenario.wallets,
      });
      const anyWalletUnavailable = scenario.wallets.some(
        (candidate) =>
          walletDeployment({
            positions: scenario.positions,
            shareMints: { known: vaultShareMints, complete: true },
            wallet: candidate,
          }).kind === "unavailable"
      );

      if (anyWalletUnavailable) {
        expect(summary.deployedValue).toBeUndefined();
        expect(summary.deployedShare).toBeUndefined();
        expect(summary.remainingShare).toBeUndefined();
      }
      // A share is never published without both figures behind it.
      if (summary.deployedShare !== undefined) {
        expect(summary.availableCash).not.toBeUndefined();
        expect(summary.deployedValue).not.toBeUndefined();
      }
    });
  }
});

describe("an incomplete share-mint vocabulary", () => {
  // The strategy catalogue is the only witness that a token with no position
  // row is a receipt, so while it is unavailable no deployed figure can be
  // certified. This must POISON the figure, never bypass the check.
  const known = new Set([SHARE_MINT]);

  it("makes the deployed figure unavailable even when every position reads", () => {
    const summary = summarizeTreasuryAllocation({
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "500" }])],
      positions: [openPosition({ tokenValue: "100" })],
      shareMints: { known, complete: false },
    });

    expect(summary.availableCash).toBe("500");
    expect(summary.deployedValue).toBeUndefined();
    expect(summary.deployedShare).toBeUndefined();
    expect(summary.remainingShare).toBeUndefined();
  });

  it("never reports a fully deployed wallet as an idle float", () => {
    // The exact fabrication this guards: positions read succeeds and is
    // EMPTY, the catalogue is unavailable, and the wallet holds receipts.
    const summary = summarizeTreasuryAllocation({
      wallets: [
        wallet([
          { mint: USDC_MINT, uiAmount: "500" },
          { mint: UNRECORDED_SHARE_MINT, uiAmount: "60" },
        ]),
      ],
      positions: [],
      shareMints: { known, complete: false },
    });

    expect(summary.deployedValue).toBeUndefined();
    expect(summary.deployedShare).toBeUndefined();
    expect(summary.remainingShare).toBeUndefined();
  });

  it("makes a wallet line with open positions unavailable, not a confident value", () => {
    expect(
      walletDeployment({
        positions: [openPosition({ tokenValue: "100" })],
        shareMints: { known, complete: false },
        wallet: wallet([{ mint: SHARE_MINT, uiAmount: "60" }]),
      })
    ).toEqual({ kind: "unavailable" });
  });

  it("stays silent for a wallet with nothing deployed", () => {
    expect(
      walletDeployment({
        positions: [],
        shareMints: { known, complete: false },
        wallet: wallet([{ mint: USDC_MINT, uiAmount: "500" }]),
      })
    ).toEqual({ kind: "none" });
  });
});
