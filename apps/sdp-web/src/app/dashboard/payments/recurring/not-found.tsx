import { getTranslations } from "@/i18n/server";

export default async function RecurringPaymentsNotFound() {
  const t = await getTranslations();

  return (
    <div className="px-3 pb-5 md:px-6 md:pb-6">
      <div className="border border-border-default bg-surface-raised p-4">
        <h2 className="text-lg font-medium text-primary">
          {t("DashboardPayments.recurringPaymentsUnavailable")}
        </h2>
      </div>
    </div>
  );
}
