import { EARN_BUTTON_ACCENT_COLOR_PATTERN, EARN_BUTTON_STYLES } from "@sdp/types";
import { Code2Icon, ShieldCheckIcon } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { buildEarnServerIntegration } from "@/app/dashboard/markets/earn/earn-button-integration";
import { EarnDepositButtonPreview } from "@/app/dashboard/markets/earn/earn-button-preview";
import { resolvePlaygroundApiBaseUrl } from "@/app/dashboard/playground-api-data";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CodeBlock } from "@/components/ui/code-block";
import { getTranslations } from "@/i18n/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

const responseSchema = z.object({
  data: z.object({
    configuration: z.object({
      strategyId: z.string().min(1),
      strategyName: z.string().nullable(),
      provider: z.string().nullable(),
      style: z.enum(EARN_BUTTON_STYLES),
      accentColor: z.string().regex(EARN_BUTTON_ACCENT_COLOR_PATTERN),
    }),
  }),
});

export default async function EarnIntegrationHandoffPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const t = await getTranslations();
  const { token } = await params;
  const apiBaseUrl = resolvePlaygroundApiBaseUrl();
  if (!apiBaseUrl) throw new Error("SDP API base URL is not configured");

  const response = await fetch(
    `${apiBaseUrl}/v1/earn/button-configurations/public/${encodeURIComponent(token)}`,
    { cache: "no-store" }
  );
  if (!response.ok) return notFound();

  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success) notFound();
  const { configuration } = parsed.data.data;

  const integrationCode = buildEarnServerIntegration({ id: configuration.strategyId });

  return (
    <main className="min-h-screen bg-surface-sunken px-4 py-10 sm:px-6">
      <div className="mx-auto w-full max-w-5xl space-y-5">
        <div className="rounded-2xl border border-border-default bg-surface-raised px-6 py-6 shadow-sm sm:px-8">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-tertiary">
              {t("DashboardMarkets.earnProgram.handoffEyebrow")}
            </p>
            <Badge variant="outline">{t("DashboardMarkets.earnProgram.handoffPublic")}</Badge>
          </div>
          <h1 className="mt-3 text-2xl font-medium tracking-tight text-primary sm:text-3xl">
            {t("DashboardMarkets.earnProgram.handoffTitle")}
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-secondary">
            {t("DashboardMarkets.earnProgram.handoffDescription")}
          </p>
        </div>

        <div className="flex items-start gap-3 rounded-xl border border-border-default bg-surface-raised px-4 py-4 text-sm leading-6 text-secondary">
          <ShieldCheckIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
          <p>{t("DashboardMarkets.earnProgram.handoffNoAuth")}</p>
        </div>

        <div className="grid gap-5 lg:grid-cols-[0.72fr_1.28fr]">
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>{t("DashboardMarkets.earnProgram.buttonPreview")}</CardTitle>
              <CardDescription>
                {configuration.strategyName ?? configuration.strategyId}
              </CardDescription>
            </CardHeader>
            <CardContent className="min-w-0 space-y-5">
              <div className="rounded-xl border border-border-default bg-fill-subtle px-5 py-8">
                <EarnDepositButtonPreview
                  accentColor={configuration.accentColor}
                  className="w-full"
                  style={configuration.style}
                />
                <p className="mt-2 text-center text-[11px] text-tertiary">
                  {t("DashboardMarkets.earnProgram.poweredBy")}
                </p>
              </div>
              <dl className="space-y-3 text-sm">
                <div className="flex items-start justify-between gap-4 border-b border-border-subtle pb-3">
                  <dt className="text-secondary">
                    {t("DashboardMarkets.earnProgram.handoffStrategy")}
                  </dt>
                  <dd className="min-w-0 text-right text-primary">
                    {configuration.strategyName ?? configuration.strategyId}
                  </dd>
                </div>
                {configuration.provider ? (
                  <div className="flex items-start justify-between gap-4">
                    <dt className="text-secondary">
                      {t("DashboardMarkets.earnProgram.handoffProvider")}
                    </dt>
                    <dd className="text-right text-primary">{configuration.provider}</dd>
                  </div>
                ) : null}
              </dl>
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Code2Icon aria-hidden="true" className="size-5 text-secondary" />
                {t("DashboardMarkets.earnProgram.integrationTitle")}
              </CardTitle>
              <CardDescription className="leading-6">
                {t("DashboardMarkets.earnProgram.integrationDescription")}
              </CardDescription>
            </CardHeader>
            <CardContent className="min-w-0 space-y-4">
              <CodeBlock
                code={integrationCode}
                language="typescript"
                title={t("DashboardMarkets.earnProgram.serverExample")}
                viewportClassName="max-h-[34rem]"
              />
              <div className="rounded-xl border border-border-default bg-fill-subtle px-4 py-3">
                <p className="text-sm font-medium text-primary">
                  {t("DashboardMarkets.earnProgram.handoffApiKey")}
                </p>
                <p className="mt-1 text-xs leading-5 text-secondary">
                  {t("DashboardMarkets.earnProgram.handoffApiKeyDescription")}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
