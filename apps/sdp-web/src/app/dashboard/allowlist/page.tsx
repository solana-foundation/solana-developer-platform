import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";

export default async function DashboardAllowlistPage() {
  const t = await getTranslations();

  return (
    <div className="w-full max-w-5xl flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("Shared.allowlist.comingSoon")}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-[rgba(28,28,29,0.72)]">
          {t("Shared.allowlist.description")}
        </CardContent>
      </Card>
    </div>
  );
}
