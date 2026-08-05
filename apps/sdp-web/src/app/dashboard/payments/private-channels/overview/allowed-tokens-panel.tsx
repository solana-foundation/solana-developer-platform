import type { PrivateChannelInstance } from "@sdp/types";
import Link from "next/link";
import { TokenMark } from "@/components/token-mark";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";
import { allowedTokensForInstance } from "./overview-data";

/** Placeholder — the allowed-tokens management page is not built yet. */
const ALL_TOKENS_HREF = "/dashboard/payments/private-channels/tokens";

interface Props {
  instance: PrivateChannelInstance;
}

export async function AllowedTokensPanel({ instance }: Props) {
  const t = await getTranslations();
  const tokens = allowedTokensForInstance(instance);

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t("DashboardPrivateChannels.overview.allowedTokensTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
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
        <Link href={ALL_TOKENS_HREF} className="text-sm text-info hover:underline">
          {t("DashboardPrivateChannels.overview.viewAllTokens")}
        </Link>
      </CardContent>
    </Card>
  );
}
