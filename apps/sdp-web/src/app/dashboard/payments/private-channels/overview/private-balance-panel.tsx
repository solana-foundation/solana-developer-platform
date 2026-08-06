import Link from "next/link";
import { TokenMark } from "@/components/token-mark";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";
import type { WalletChannelBalance } from "../private-channels-page.data";
import { aggregateBalancesByMint, formatTokenAmount } from "./overview-data";

interface Props {
  /** Per-(wallet) channel balances, keyed by wallet pubkey. */
  channelBalances: Record<string, WalletChannelBalance>;
  /** Anchor to the Wallets table, shown when no balances exist. */
  walletsHref: string;
}

export async function PrivateBalancePanel({ channelBalances, walletsHref }: Props) {
  const t = await getTranslations();
  const balances = aggregateBalancesByMint(channelBalances);

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t("DashboardPrivateChannels.overview.privateBalanceTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        {balances.length === 0 ? (
          <div className="space-y-2 text-sm">
            <p className="text-secondary">
              {t("DashboardPrivateChannels.overview.privateBalanceNoWallet")}
            </p>
            <Link href={walletsHref} className="text-info hover:underline">
              {t("DashboardPrivateChannels.overview.viewWallets")}
            </Link>
          </div>
        ) : (
          <ul className="space-y-3">
            {balances.map((balance) => (
              <li key={balance.mint} className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <TokenMark mint={balance.mint} symbol={balance.symbol} size="md" />
                  <span className="truncate text-sm text-secondary">
                    {balance.symbol ?? `${balance.mint.slice(0, 4)}…${balance.mint.slice(-4)}`}
                  </span>
                </span>
                <span className="text-sm font-medium text-primary tabular-nums">
                  {formatTokenAmount(balance.base, balance.decimals)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
