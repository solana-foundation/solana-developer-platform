import Link from "next/link";
import { TokenMark } from "@/components/token-mark";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";
import type { WalletChannelBalance } from "../private-channels-page.data";
import { aggregateBalancesByMint, formatTokenAmount } from "./overview-data";

interface Props {
  /** Per-(wallet) channel balances, keyed by wallet pubkey. */
  channelBalances: Record<string, WalletChannelBalance>;
  /** The Wallets page — reached from the footer link (there is no Wallets tab). */
  walletsHref: string;
}

export async function PrivateBalancePanel({ channelBalances, walletsHref }: Props) {
  const t = await getTranslations();
  const balances = aggregateBalancesByMint(channelBalances);

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle>{t("DashboardPrivateChannels.overview.privateBalanceTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="flex-1">
        {balances.length === 0 ? (
          <p className="text-sm text-secondary">
            {t("DashboardPrivateChannels.overview.privateBalanceNoWallet")}
          </p>
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
      <CardFooter>
        <Link href={walletsHref} className="text-sm text-info hover:underline">
          {t("DashboardPrivateChannels.overview.viewWallets")}
        </Link>
      </CardFooter>
    </Card>
  );
}
