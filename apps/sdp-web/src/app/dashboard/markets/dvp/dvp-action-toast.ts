import type { SolanaCluster } from "@sdp/types";
import type { useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";

/**
 * The action every DvP success toast carries: a click through to the
 * transaction it reports, on the trade's cluster. Whatever SDP just sent can
 * be checked on chain from the toast that says so, without hunting for it on
 * the page. `null` (a create whose signature has not landed yet) renders no
 * action rather than a link to nothing.
 */
export function dvpToastAction(
  t: ReturnType<typeof useTranslations>,
  signature: string | null,
  cluster: SolanaCluster
): { label: string; onClick: () => void } | undefined {
  if (signature === null) return undefined;
  return {
    label: t("DashboardMarkets.dvp.viewTransaction"),
    onClick: () => window.open(explorerTxUrl(signature, cluster), "_blank", "noopener,noreferrer"),
  };
}
