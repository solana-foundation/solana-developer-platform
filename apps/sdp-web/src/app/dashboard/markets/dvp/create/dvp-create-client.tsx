"use client";

import { SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKENS } from "@sdp/types";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import {
  MARKETS_SANDBOX_TOKEN_SYMBOLS,
  marketsSandboxAmountToAtoms,
  useMarketsSandbox,
} from "../../markets-sandbox-store";
import type { DvpCreateContext } from "./dvp-create.data";
import { DvpCreateWorkspace } from "./dvp-create-workspace";

/**
 * Supplies the active project's cluster to the form.
 *
 * Split out so the form itself stays a pure function of its props: the cluster
 * decides which stablecoin mints exist, and reading it from context inside the
 * form would make the form untestable without the whole dashboard workspace.
 */
const SANDBOX_WALLET_ADDRESS = "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY";
const SANDBOX_COUNTERPARTY_ADDRESS = "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC";

function SandboxDvpCreateClient() {
  const t = useTranslations();
  const { selectedProjectId } = useDashboardWorkspace();
  const { state } = useMarketsSandbox(selectedProjectId);
  const tokens = MARKETS_SANDBOX_TOKEN_SYMBOLS.map((symbol) => {
    const token = WELL_KNOWN_TOKENS[symbol];
    const mint = token.mints["mainnet-beta"];
    return {
      mint: mint.address,
      label: symbol,
      name: token.name,
      decimals: mint.decimals,
      tokenProgram: SPL_TOKEN_PROGRAMS[token.tokenProgram],
    };
  });
  const context: DvpCreateContext = {
    wallets: [
      {
        id: "markets-sandbox-wallet",
        address: SANDBOX_WALLET_ADDRESS,
        label: t("DashboardMarkets.sandbox.dvpWalletName"),
        balances: MARKETS_SANDBOX_TOKEN_SYMBOLS.map((symbol) => {
          const token = WELL_KNOWN_TOKENS[symbol];
          const mint = token.mints["mainnet-beta"];
          return {
            mint: mint.address,
            amount: marketsSandboxAmountToAtoms(state.balances[symbol], symbol),
            decimals: mint.decimals,
            symbol,
          };
        }),
      },
    ],
    tokens,
    counterpartyAccounts: [
      {
        counterpartyAccountId: "markets-sandbox-counterparty",
        name: t("DashboardMarkets.sandbox.dvpCounterpartyName"),
        label: t("DashboardMarkets.sandbox.dvpCounterpartyLabel"),
        address: SANDBOX_COUNTERPARTY_ADDRESS,
      },
    ],
    error: null,
  };
  return <DvpCreateWorkspace cluster="mainnet-beta" context={context} sandbox />;
}

export function DvpCreateClient({ context }: { context?: DvpCreateContext }) {
  const { sdpEnvironment } = useDashboardWorkspace();
  const cluster = useSolanaCluster();
  if (sdpEnvironment === "sandbox") return <SandboxDvpCreateClient />;
  return context ? <DvpCreateWorkspace cluster={cluster} context={context} /> : null;
}
