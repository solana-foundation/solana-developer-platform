import type { PrivateChannelTokenEligibility } from "@sdp/types";
import { TokenMark } from "@/components/token-mark";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";

interface Props {
  connected: boolean;
  tokens: PrivateChannelTokenEligibility[];
}

export async function AllowedTokensPanel({ connected, tokens }: Props) {
  const t = await getTranslations();
  const visibleTokens = connected ? tokens : [];

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t("DashboardPrivateChannels.overview.allowedTokensTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        {visibleTokens.length === 0 ? (
          <p className="text-sm text-secondary">
            {t("DashboardPrivateChannels.overview.allowedTokensEmpty")}
          </p>
        ) : (
          <ul className="space-y-3">
            {visibleTokens.map((token) => (
              <li key={token.mint} className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <TokenMark mint={token.mint} symbol={token.symbol} size="md" />
                  <span className="truncate text-sm text-primary">{token.symbol}</span>
                </span>
                {token.enabled ? (
                  <Badge variant="success">
                    {t("DashboardPrivateChannels.overview.allowedTag")}
                  </Badge>
                ) : (
                  <span className="max-w-48 text-right text-xs text-secondary">
                    {token.exclusionReasons[0]?.message}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
