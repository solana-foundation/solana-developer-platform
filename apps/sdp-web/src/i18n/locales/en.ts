// No localized dashboard-helius-rings.json yet: product branches ship English
// source only; localized copy lands via the translation bot on the release PR.
import dashboardApprovals from "../../../messages/en/dashboard-approvals.json";
import dashboardCustody from "../../../messages/en/dashboard-custody.json";
import dashboardEarn from "../../../messages/en/dashboard-earn.json";
import dashboardHeliusRings from "../../../messages/en/dashboard-helius-rings.json";
import dashboardIssuance from "../../../messages/en/dashboard-issuance.json";
import dashboardPayments from "../../../messages/en/dashboard-payments.json";
import dashboardPolicies from "../../../messages/en/dashboard-policies.json";
import dashboardPrivateChannels from "../../../messages/en/dashboard-private-channels.json";
import shared from "../../../messages/en/shared.json";
import en from "../../../messages/en.json";

export const englishSourceMessages = {
  ...en,
  ...dashboardApprovals,
  ...dashboardCustody,
  ...dashboardEarn,
  ...dashboardHeliusRings,
  ...dashboardIssuance,
  ...dashboardPayments,
  ...dashboardPolicies,
  ...dashboardPrivateChannels,
  Shared: shared,
};
