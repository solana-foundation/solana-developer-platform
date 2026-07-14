import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";

export default async function DashboardMembersPage() {
  const t = await getTranslations();

  return (
    <div className="w-full max-w-5xl flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("Shared.members.comingSoon")}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-secondary">
          {t("Shared.members.description")}
        </CardContent>
      </Card>
    </div>
  );
}
