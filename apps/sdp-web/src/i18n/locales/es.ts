import dashboardApprovals from "../../../messages/es/dashboard-approvals.json";
import dashboardCustody from "../../../messages/es/dashboard-custody.json";
import dashboardIssuance from "../../../messages/es/dashboard-issuance.json";
import dashboardPayments from "../../../messages/es/dashboard-payments.json";
import dashboardPolicies from "../../../messages/es/dashboard-policies.json";
import dashboardPrivateChannels from "../../../messages/es/dashboard-private-channels.json";
import esShared from "../../../messages/es/shared.json";
import es from "../../../messages/es.json";
import type { Messages } from "../messages";
import type { LocalizedMessages } from "../translate";

export const catalog = {
  ...es,
  ...dashboardApprovals,
  ...dashboardCustody,
  ...dashboardIssuance,
  ...dashboardPayments,
  ...dashboardPolicies,
  ...dashboardPrivateChannels,
  Shared: esShared,
} satisfies LocalizedMessages<Messages>;
