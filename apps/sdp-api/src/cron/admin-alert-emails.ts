import { adminAlertEmailsEnabled, deliverAdminAlerts } from "@/services/admin-alerts/deliver";
import { enqueueConfigAlerts, enqueueMoneyAlerts } from "@/services/admin-alerts/enqueue";
import { defineCron } from "./define-cron";

/**
 * Admin alert emails (HOO-2299). Every 15 seconds, so an email follows its event within a
 * minute or so: writes the alerts for audit entries and closed money windows since the last run,
 * then sends what is unsent. Global, because the alerts read
 * every Environment's rows and send no transaction. Off where email is not configured; the
 * cursors then wait, and what they reach later is dropped once it is a day old.
 */
export const adminAlertEmailsCron = defineCron({
  name: "admin-alert-emails",
  schedule: "*/15 * * * * *",
  scope: "global",
  effect: "observes",
  enabled: adminAlertEmailsEnabled,
  run: async (env) => {
    await enqueueConfigAlerts(env);
    await enqueueMoneyAlerts(env);
    await deliverAdminAlerts(env);
  },
});
