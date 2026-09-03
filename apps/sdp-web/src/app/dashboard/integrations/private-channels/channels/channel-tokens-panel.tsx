import type { PrivateChannelTokenEligibility } from "@sdp/types";
import { TokenMark } from "@/components/token-mark";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";

function shorten(value: string): string {
  return value.length > 13 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value;
}

export async function ChannelTokensPanel({
  channelName,
  tokens,
  loadError,
}: {
  channelName: string;
  tokens: PrivateChannelTokenEligibility[];
  loadError: boolean;
}) {
  const t = await getTranslations();
  const allowedTokens = tokens.filter((token) => token.enabled);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("DashboardPrivateChannels.channelDetail.tokensTitle")}</CardTitle>
        <CardDescription>
          {t("DashboardPrivateChannels.channelDetail.tokensDescription", { channel: channelName })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loadError ? (
          <p className="text-sm text-error">
            {t("DashboardPrivateChannels.channelDetail.tokensLoadError")}
          </p>
        ) : allowedTokens.length === 0 ? (
          <p className="text-sm text-secondary">
            {t("DashboardPrivateChannels.channelDetail.tokensEmpty")}
          </p>
        ) : (
          <ul className="divide-y divide-border-default rounded-lg border border-border-default">
            {allowedTokens.map((token) => (
              <li key={token.mint} className="px-4 py-4 sm:px-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
                  <div className="flex min-w-40 items-center gap-3">
                    <TokenMark mint={token.mint} symbol={token.symbol} size="md" />
                    <div>
                      <p className="text-sm font-medium text-primary">{token.symbol}</p>
                      <p className="text-xs text-tertiary">
                        {t("DashboardPrivateChannels.channelDetail.tokenNetwork", {
                          network: "Solana",
                        })}
                      </p>
                    </div>
                  </div>
                  <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-3 text-sm">
                    <div>
                      <dt className="text-xs text-tertiary">
                        {t("DashboardPrivateChannels.channelDetail.mintLabel")}
                      </dt>
                      <dd className="mt-0.5 text-secondary" title={token.mint}>
                        {shorten(token.mint)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-tertiary">
                        {t("DashboardPrivateChannels.channelDetail.decimalsLabel")}
                      </dt>
                      <dd className="mt-0.5 text-secondary">{token.decimals}</dd>
                    </div>
                  </dl>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
