import type { PrivateChannelInstance } from "@sdp/types";
import { TokenMark } from "@/components/token-mark";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";
import { allowedTokensForInstance } from "./overview-data";

interface Props {
  /** The active instance, or null when nothing is connected. */
  instance: PrivateChannelInstance | null;
}

export async function AllowedTokensPanel({ instance }: Props) {
  const t = await getTranslations();
  const tokens = instance ? allowedTokensForInstance(instance) : [];

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
