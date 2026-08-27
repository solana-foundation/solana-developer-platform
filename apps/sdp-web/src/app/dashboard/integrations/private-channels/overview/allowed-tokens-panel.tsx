"use client";

import { privateChannelTokens } from "@sdp/types";
import { TokenMark } from "@/components/token-mark";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslations } from "@/i18n/provider";
import { useSolanaCluster } from "@/lib/use-solana-cluster";

interface Props {
  connected: boolean;
}

export function AllowedTokensPanel({ connected }: Props) {
  const t = useTranslations();
  const cluster = useSolanaCluster();
  const tokens = connected ? privateChannelTokens(cluster) : [];

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t("DashboardPrivateChannels.overview.allowedTokensTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        {tokens.length === 0 ? (
          <p className="text-sm text-secondary">
            {t("DashboardPrivateChannels.overview.allowedTokensEmpty")}
          </p>
        ) : (
          <ul className="space-y-3">
            {tokens.map((token) => (
              <li key={token.mint} className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <TokenMark mint={token.mint} symbol={token.symbol} size="md" />
                  <span className="truncate text-sm text-primary">{token.symbol}</span>
                </span>
                <Badge variant="success">{t("DashboardPrivateChannels.overview.allowedTag")}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
