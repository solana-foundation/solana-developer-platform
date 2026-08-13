import type { EarnStrategy } from "@sdp/types";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EarnProgramsState } from "./earn-program-data";

// Values-aware identity translations, so assertions can pin interpolations
// (e.g. a delayed liquidity label rendering its settlement-day count).
vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string, values?: Record<string, string | number>) =>
    values ? `${key}(${Object.values(values).join(",")})` : key,
  useLocale: () => "en",
}));

vi.mock("next/link", () => ({
  default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a>,
}));

// The workspace reads live data exclusively through these hooks, so the tests
// drive them directly instead of stubbing fetch + SWR plumbing.
const data = vi.hoisted(() => ({
  program: {
    state: undefined as EarnProgramsState | undefined,
    error: undefined as Error | undefined,
    isLoading: false,
    refresh: () => {},
  },
  strategies: {
    strategies: undefined as EarnStrategy[] | undefined,
    error: undefined as Error | undefined,
    isLoading: false,
  },
}));

vi.mock("./earn-program-data", () => ({
  useEarnPrograms: () => data.program,
  // Re-implemented rather than imported: the factory replaces the WHOLE module,
  // so anything the workspace imports from it must exist here.
  hasPrograms: (state: EarnProgramsState | undefined) =>
    state?.kind === "ready" && state.programs.length > 0,
  findProgram: (state: EarnProgramsState | undefined, id: string | undefined) =>
    state?.kind === "ready" ? state.programs.find((p) => p.id === id) : undefined,
  useEarnStrategies: () => data.strategies,
  // Completion toasts are behaviour of their own; earn-wallet-activity covers
  // them against provider state transitions, so the workspace only has to
  // mount the hook.
  useEarnWalletActivityToasts: () => {},
  // Withdrawal outcomes are announced from the withdrawal's own status;
  // earn-wallet-activity covers that hook against each terminal status.
  useEarnWithdrawalOutcomeToast: () => {},
  // The workspace also reads the provider pin, so the hero counts exactly what
  // the deposit flow will offer rather than every synced row.
  EARN_PORTFOLIO_PROVIDER: "ground",
}));

import { EarnWorkspace } from "./earn-workspace";

const TIMESTAMP = "2026-07-18T09:00:00.000Z";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function strategy(partial: {
  id: string;
  providerReference: string;
  name: string;
  currentApy?: string;
  liquidityTerm?: EarnStrategy["liquidityTerm"];
  redemptionDelayDays?: number;
  underlyingSource?: string;
}): EarnStrategy {
  return {
    id: partial.id,
    provider: "ground",
    providerReference: partial.providerReference,
    name: partial.name,
    sourceKind: "defi",
    depositMints: [USDC],
    apyType: "variable",
    currentApy: partial.currentApy ?? "0.05",
    liquidityTerm: partial.liquidityTerm ?? "instant",
    ...(partial.redemptionDelayDays === undefined
      ? {}
      : { redemptionDelayDays: partial.redemptionDelayDays }),
    ...(partial.underlyingSource === undefined
      ? {}
      : { underlyingSource: partial.underlyingSource }),
    riskMetadata: { tvlUsd: 12_000_000 },
    status: "active",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

const CATALOGUE: EarnStrategy[] = [
  strategy({
    id: "earn_strategy_1",
    providerReference: "morpho-gauntlet-usdc",
    name: "Morpho Gauntlet USDC",
    currentApy: "0.062",
    underlyingSource: "morpho",
  }),
  strategy({
    id: "earn_strategy_2",
    providerReference: "morpho-steakhouse-usdc",
    name: "Morpho Steakhouse USDC",
    currentApy: "0.045",
  }),
  strategy({
    id: "earn_strategy_3",
    providerReference: "ground-jaaa-usdc-vault",
    name: "Ground JAAA USDC",
    currentApy: "0.084",
    liquidityTerm: "delayed",
    redemptionDelayDays: 2,
  }),
];

beforeEach(() => {
  data.program.state = undefined;
  data.program.error = undefined;
  data.program.isLoading = false;
  data.strategies.strategies = CATALOGUE;
  data.strategies.error = undefined;
  data.strategies.isLoading = false;
});

describe("EarnWorkspace while the program is still loading", () => {
  it("shows the skeleton and never flashes the onboarding hero", () => {
    // state stays undefined (in flight). Rendering the hero here flashed
    // onboarding at program holders for a beat, then yanked it away.
    data.program.isLoading = true;
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).not.toContain("DashboardEarn.overview.startTitle");
    expect(html).not.toContain("DashboardEarn.overview.startAction");
    expect(html).toContain("aria-busy");
  });
});

describe("EarnWorkspace with no program yet", () => {
  beforeEach(() => {
    data.program.state = { kind: "ready", programs: [] };
  });

  it("renders the empty program state and a single deposit entry point", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.programTitle");
    expect(html).toContain("DashboardEarn.overview.programEmpty");
    expect(html).toContain('href="/dashboard/markets/earn/deposit"');
  });

  it("leads the hero with live catalogue facts rather than curator cards", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.startTitle");
    expect(html).toContain("DashboardEarn.overview.startStatStrategies");
    expect(html).toContain("DashboardEarn.overview.startStatTopApy");
    expect(html).toContain("DashboardEarn.overview.startStatAccess");
    // Three active strategies, best rate 8.4%, and at least one instant source.
    expect(html).toContain(">3<");
    expect(html).toContain("8.4%");
    expect(html).toContain("DashboardEarn.liquidity.instant");
  });

  it("never routes through a curator, the removed first step", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).not.toContain("curator");
    expect(html).not.toContain("Gauntlet");
  });
});

describe("EarnWorkspace with an active program", () => {
  beforeEach(() => {
    data.program.state = {
      kind: "ready",
      programs: [
        {
          id: "earn_provider_wallet_1",
          provider: "ground",
          label: "Treasury earn",
          createdAt: TIMESTAMP,
          yield: { currentApy: "0.058", earnedUsd: "1250.75", positions: [] },
          wallet: {
            providerWalletRef: "wallet-ref-1",
            status: "ready",
            solanaDepositAddress: "7M6bFdwsXQZX9MjoD4PDxQJb9FZbwdQh6VS8sK7F3WcQ",
            balance: {
              totalUsd: "125000.50",
              withdrawableUsd: "120000.00",
              reservedUsd: "5000.50",
              earnedUsd: "1250.75",
            },
            // The V1 shape: one vault per token lane. Freshly funded, so most
            // value still sits as cash awaiting the provider's deploy — and the
            // provider still reports `pct` on the wire; the workspace ignores it.
            positions: [
              {
                kind: "yield_source",
                label: "Morpho Gauntlet USDC",
                valueUsd: "20000.50",
                pct: 16,
                yieldSourceId: "morpho-gauntlet-usdc",
                token: "usdc",
              },
              { kind: "cash", label: "Cash (USDC)", valueUsd: "105000.00", pct: 84, token: "usdc" },
            ],
            allocations: {
              usdc: [{ yieldSourceId: "morpho-gauntlet-usdc", weightBps: 10_000 }],
            },
          },
        },
      ],
    };
  });

  it("renders the live balance stat strip", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.totalBalance");
    expect(html).toContain("DashboardEarn.overview.totalEarned");
    expect(html).toContain("DashboardEarn.overview.withdrawableBalance");
    expect(html).toContain("$125,000.50");
    expect(html).toContain("$1,250.75");
    expect(html).toContain("5.8%");
  });

  it("lists holdings flat and deployed-first, with no curator grouping", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.holdingsTitle");
    const gauntlet = html.indexOf("Morpho Gauntlet USDC");
    const cash = html.indexOf("Cash (USDC)");
    expect(gauntlet).toBeGreaterThan(-1);
    // Cash is not deployed, so it sorts last even though it holds 5x the value.
    expect(cash).toBeGreaterThan(gauntlet);
  });

  it("renders the provider's position label verbatim so no chain name is rebuilt", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("Cash (USDC)");
  });

  // The status chip relays what the PROVIDER says is happening. It reads the
  // neutral `activity` the provider client derived — never a raw provider
  // status string, which would put a second copy of that vocabulary here.
  describe("wallet status chip", () => {
    const withWallet = (patch: Record<string, unknown>) => {
      const state = data.program.state;
      if (state?.kind !== "ready" || !state.programs[0]) {
        throw new Error("expected an active program");
      }
      Object.assign(state.programs[0].wallet, patch);
      return renderToStaticMarkup(<EarnWorkspace />);
    };

    it("shows no chip while the wallet is ready", () => {
      const html = withWallet({ status: "ready", activity: undefined });
      expect(html).not.toContain("DashboardEarn.overview.walletStatus");
    });

    it("names the operation when the provider reports one", () => {
      expect(withWallet({ status: "busy", activity: "withdrawing" })).toContain(
        "DashboardEarn.overview.walletStatusWithdrawing"
      );
      expect(withWallet({ status: "busy", activity: "rebalancing" })).toContain(
        "DashboardEarn.overview.walletStatusRebalancing"
      );
    });

    it("falls back to the generic label when busy carries no named activity", () => {
      // The provider client reports an unrecognized provider state as busy with
      // no activity; the chip must not invent one.
      const html = withWallet({ status: "busy", activity: undefined });
      expect(html).toContain("DashboardEarn.overview.walletStatusBusy");
      expect(html).not.toContain("DashboardEarn.overview.walletStatusWithdrawing");
    });

    it("keeps both money verbs reachable while the provider is busy", () => {
      // ADR 0002, money out beats money off: a withdrawal in flight must never
      // lock the exit. Ground already moves reserved funds out of
      // withdrawableUsd, so that figure — not a status — is the only gate.
      // Matches the rendered attribute, NOT Tailwind's `disabled:` utilities.
      const html = withWallet({ status: "busy", activity: "withdrawing" });
      expect(html).toContain("DashboardEarn.overview.withdraw");
      expect(html).toContain("DashboardEarn.overview.changeStrategy");
      expect(html).not.toContain('disabled=""');
    });

    it("gates withdraw on the balance alone, so the assertion above has teeth", () => {
      // Ground reserves the amount the instant it accepts a withdrawal, so a
      // program with nothing left to withdraw disables the button — proving
      // the previous test observes a real absence, not a broken matcher.
      const html = withWallet({
        status: "busy",
        activity: "withdrawing",
        balance: {
          totalUsd: "125000.50",
          withdrawableUsd: "0.00",
          reservedUsd: "125000.50",
          earnedUsd: "1250.75",
        },
      });
      expect(html).toContain('disabled=""');
    });
  });

  it("explains what each cash slice is waiting for, from the target allocations", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    // The USDC lane targets a yield source, so its cash deploys on rebalance.
    expect(html).toContain("DashboardEarn.overview.cashDeploys");
  });

  it("hides zero-value residual cash buckets but keeps zero-value strategy rows", () => {
    // Ground keeps reporting a drained lane's cash bucket at $0 (e.g. the
    // Sepolia USDT lane once emptied) — residue, not a holding. A $0 strategy
    // slice stays: it carries the forward allocation story.
    const state = data.program.state;
    const program = state?.kind === "ready" ? state.programs[0] : undefined;
    program?.wallet.positions.push(
      { kind: "cash", label: "Cash (USDT)", valueUsd: "0.000000", token: "usdt" },
      { kind: "bridge", label: "In transit (USDC)", valueUsd: "0.000000", token: "usdc" },
      {
        kind: "yield_source",
        label: "Ground JAAA USDC",
        valueUsd: "0.000000",
        pct: 0,
        yieldSourceId: "ground-jaaa-usdc-vault",
        token: "usdc",
      }
    );
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).not.toContain("Cash (USDT)");
    expect(html).not.toContain("In transit (USDC)");
    expect(html).toContain("Ground JAAA USDC");
    // Nonzero cash still renders — value is never hidden, only $0 residue.
    expect(html).toContain("Cash (USDC)");
  });

  it("never renders a share percent beside holdings — V1 is single-vault", () => {
    // The fixture's positions carry `pct` (the provider keeps reporting it);
    // the workspace must not surface it as portfolio framing.
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).not.toContain("programShare");
  });

  it("keeps the deposit address one copy away on the dashboard", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.depositAddressLabel");
    expect(html).toContain("7M6bFd…7F3WcQ");
  });

  it("offers the two managing verbs and keeps deposit as the address row", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.withdraw");
    expect(html).toContain("DashboardEarn.overview.changeStrategy");
    // Depositing is the address row, not a wizard — nothing here says deposit
    // except the row itself.
    expect(html).toContain("DashboardEarn.overview.depositAddressLabel");
    expect(html).not.toContain("DashboardEarn.overview.startTitle");
  });
});

describe("EarnWorkspace when the provider is not configured", () => {
  beforeEach(() => {
    data.program.state = { kind: "unconfigured" };
  });

  it("renders a quiet notice and keeps the catalogue-backed hero", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.providerNotConfigured");
    expect(html).toContain("DashboardEarn.overview.startTitle");
  });
});

describe("EarnWorkspace when the program read fails", () => {
  it("renders an inline error with a retry affordance instead of crashing", () => {
    data.program.error = new Error("boom");
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.programLoadError");
    expect(html).toContain("Shared.SharedComponents.retry");
  });
});

/**
 * Multi-program is the point of PRO-1670, and it is where a "renders the first
 * one" regression would hide: with one program on screen everything looks
 * right, and the second program's money is simply invisible.
 */
describe("EarnWorkspace with several programs", () => {
  function programAt(
    id: string,
    ref: string,
    totalUsd: string,
    apy: string | undefined,
    createdAt = TIMESTAMP
  ) {
    return {
      id,
      provider: "ground",
      label: null,
      createdAt,
      ...(apy ? { yield: { currentApy: apy, earnedUsd: "0", positions: [] } } : {}),
      wallet: {
        providerWalletRef: ref,
        status: "ready",
        solanaDepositAddress: "7M6bFdwsXQZX9MjoD4PDxQJb9FZbwdQh6VS8sK7F3WcQ",
        balance: {
          totalUsd,
          withdrawableUsd: totalUsd,
          reservedUsd: "0",
          earnedUsd: "10.00",
        },
        positions: [
          {
            kind: "yield_source",
            label: `Slice ${id}`,
            valueUsd: totalUsd,
            pct: 100,
            yieldSourceId: id === "p1" ? "morpho-gauntlet-usdc" : "ground-jaaa-usdc-vault",
            token: "usdc",
          },
        ],
        allocations: {
          usdc: [
            {
              yieldSourceId: id === "p1" ? "morpho-gauntlet-usdc" : "ground-jaaa-usdc-vault",
              weightBps: 10_000,
            },
          ],
        },
      },
    };
  }

  beforeEach(() => {
    data.program.state = {
      kind: "ready",
      programs: [
        programAt("p1", "wallet-ref-1", "100.00", "0.05", "2026-07-18T09:00:00.000Z"),
        programAt("p2", "wallet-ref-2", "300.00", "0.09", "2026-07-19T09:00:00.000Z"),
      ],
    } as never;
  });

  it("renders every program, not just the first", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("$100.00");
    expect(html).toContain("$300.00");
  });

  it("lists the most recently created program first", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    const newer = html.indexOf("Ground JAAA USDC");
    const older = html.indexOf("Morpho Gauntlet USDC");
    expect(newer).toBeGreaterThan(-1);
    expect(older).toBeGreaterThan(-1);
    expect(newer).toBeLessThan(older);
  });

  it("names each program after the vault it targets", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("Morpho Gauntlet USDC");
    expect(html).toContain("Ground JAAA USDC");
  });

  /** The portfolio strip's own APY value — never another card's tile. */
  const blendedApyTile = (html: string) => html.match(/blendedApy<\/dt><dd[^>]*>([^<]*)</)?.[1];

  it("adds a portfolio strip totalling the programs, with a balance-weighted rate", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("$400.00");
    // 100 @ 5% + 300 @ 9% = 8%, not the 7% a per-program average would show.
    expect(blendedApyTile(html)).toBe("8.0%");
  });

  it("offers a per-program change-strategy link, addressed by program id", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("/dashboard/markets/earn/deposit?program=p1");
    expect(html).toContain("/dashboard/markets/earn/deposit?program=p2");
  });

  it("offers adding another strategy, unaddressed so it creates a new program", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.addStrategy");
    expect(html).toContain('href="/dashboard/markets/earn/deposit"');
  });

  it("never shows the onboarding hero while programs exist", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).not.toContain("DashboardEarn.overview.startTitle");
  });

  // The strip only earns its place once there is something to add up; with one
  // program it would restate that program's own tiles directly above them.
  it("omits the portfolio strip for a single program", () => {
    data.program.state = {
      kind: "ready",
      programs: [programAt("p1", "wallet-ref-1", "100.00", "0.05")],
    } as never;
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).not.toContain("DashboardEarn.overview.blendedApy");
    expect(html).toContain("$100.00");
  });

  /**
   * Weighting over only the programs that publish a rate would quote the small
   * funded strategy's APY as the whole portfolio's.
   */
  it("reports no blended rate when a funded program has none", () => {
    data.program.state = {
      kind: "ready",
      programs: [
        programAt("p1", "wallet-ref-1", "100.00", "0.05"),
        programAt("p2", "wallet-ref-2", "300.00", undefined),
      ],
    } as never;
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(blendedApyTile(html)).toBe("—");
  });
});
