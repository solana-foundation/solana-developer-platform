import dashboardApprovals from "../../../messages/pt/dashboard-approvals.json";
import dashboardCustody from "../../../messages/pt/dashboard-custody.json";
import dashboardIssuance from "../../../messages/pt/dashboard-issuance.json";
import dashboardPayments from "../../../messages/pt/dashboard-payments.json";
import dashboardPolicies from "../../../messages/pt/dashboard-policies.json";
import dashboardPrivateChannels from "../../../messages/pt/dashboard-private-channels.json";
import ptShared from "../../../messages/pt/shared.json";
import pt from "../../../messages/pt.json";
import type { Messages } from "../messages";
import type { LocalizedMessages } from "../translate";

export const catalog = {
  ...pt,
  ...dashboardApprovals,
  ...dashboardCustody,
  ...dashboardIssuance,
  ...dashboardPayments,
  ...dashboardPolicies,
  ...dashboardPrivateChannels,
  Shared: ptShared,
} satisfies LocalizedMessages<Messages>;
