import dashboardApprovals from "../../../messages/fr/dashboard-approvals.json";
import dashboardCustody from "../../../messages/fr/dashboard-custody.json";
import dashboardIssuance from "../../../messages/fr/dashboard-issuance.json";
import dashboardPayments from "../../../messages/fr/dashboard-payments.json";
import dashboardPolicies from "../../../messages/fr/dashboard-policies.json";
import frShared from "../../../messages/fr/shared.json";
import fr from "../../../messages/fr.json";
import type { Messages } from "../messages";
import type { LocalizedMessages } from "../translate";

export const catalog = {
  ...fr,
  ...dashboardApprovals,
  ...dashboardCustody,
  ...dashboardIssuance,
  ...dashboardPayments,
  ...dashboardPolicies,
  Shared: frShared,
} satisfies LocalizedMessages<Messages>;
