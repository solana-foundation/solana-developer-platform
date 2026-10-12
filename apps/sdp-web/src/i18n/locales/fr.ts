import dashboardCustody from "../../../messages/fr/dashboard-custody.json";
import dashboardIssuance from "../../../messages/fr/dashboard-issuance.json";
import dashboardPayments from "../../../messages/fr/dashboard-payments.json";
import frShared from "../../../messages/fr/shared.json";
import fr from "../../../messages/fr.json";
import type { Messages } from "../messages";
import type { LocalizedMessages } from "../translate";

export const catalog = {
  ...fr,
  ...dashboardCustody,
  ...dashboardIssuance,
  ...dashboardPayments,
  Shared: frShared,
} satisfies LocalizedMessages<Messages>;
