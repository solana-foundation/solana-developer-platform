// No localized dashboard-helius-rings.json yet: product branches ship English
// source only; localized copy lands via the translation bot on the release PR.
import dashboardCustody from "../../../messages/en/dashboard-custody.json";
import dashboardEarn from "../../../messages/en/dashboard-earn.json";
import dashboardHeliusRings from "../../../messages/en/dashboard-helius-rings.json";
import dashboardIssuance from "../../../messages/en/dashboard-issuance.json";
import dashboardPayments from "../../../messages/en/dashboard-payments.json";
import dashboardPrivateChannels from "../../../messages/en/dashboard-private-channels.json";
import shared from "../../../messages/en/shared.json";
import en from "../../../messages/en.json";

export const englishSourceMessages = {
  ...en,
  ...dashboardCustody,
  ...dashboardEarn,
  ...dashboardHeliusRings,
  ...dashboardIssuance,
  ...dashboardPayments,
  ...dashboardPrivateChannels,
  Shared: shared,
};
