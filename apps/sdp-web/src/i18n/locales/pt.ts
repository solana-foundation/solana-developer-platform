import type { Messages } from "@/i18n/messages";
import type { LocalizedMessages } from "@/i18n/translate";
import dashboardCustody from "@/messages/pt/dashboard-custody.json";
import dashboardIssuance from "@/messages/pt/dashboard-issuance.json";
import dashboardPayments from "@/messages/pt/dashboard-payments.json";
import dashboardPrivateChannels from "@/messages/pt/dashboard-private-channels.json";
import ptShared from "@/messages/pt/shared.json";
import pt from "@/messages/pt.json";

export const catalog = {
  ...pt,
  ...dashboardCustody,
  ...dashboardIssuance,
  ...dashboardPayments,
  ...dashboardPrivateChannels,
  Shared: ptShared,
} satisfies LocalizedMessages<Messages>;
