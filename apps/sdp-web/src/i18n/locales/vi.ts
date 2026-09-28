import dashboardApprovals from "../../../messages/vi/dashboard-approvals.json";
import dashboardCustody from "../../../messages/vi/dashboard-custody.json";
import dashboardEarn from "../../../messages/vi/dashboard-earn.json";
import dashboardIssuance from "../../../messages/vi/dashboard-issuance.json";
import dashboardPayments from "../../../messages/vi/dashboard-payments.json";
import dashboardPolicies from "../../../messages/vi/dashboard-policies.json";
import dashboardPrivateChannels from "../../../messages/vi/dashboard-private-channels.json";
import viShared from "../../../messages/vi/shared.json";
import vi from "../../../messages/vi.json";
import type { Messages } from "../messages";
import type { LocalizedMessages } from "../translate";

export const catalog = {
  ...vi,
  ...dashboardApprovals,
  ...dashboardCustody,
  ...dashboardEarn,
  ...dashboardIssuance,
  ...dashboardPayments,
  ...dashboardPolicies,
  ...dashboardPrivateChannels,
  Shared: viShared,
} satisfies LocalizedMessages<Messages>;
