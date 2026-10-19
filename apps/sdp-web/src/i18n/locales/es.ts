import type { Messages } from "@/i18n/messages";
import type { LocalizedMessages } from "@/i18n/translate";
import dashboardCustody from "@/messages/es/dashboard-custody.json";
import dashboardIssuance from "@/messages/es/dashboard-issuance.json";
import dashboardPayments from "@/messages/es/dashboard-payments.json";
import dashboardPrivateChannels from "@/messages/es/dashboard-private-channels.json";
import esShared from "@/messages/es/shared.json";
import es from "@/messages/es.json";

export const catalog = {
  ...es,
  ...dashboardCustody,
  ...dashboardIssuance,
  ...dashboardPayments,
  ...dashboardPrivateChannels,
  Shared: esShared,
} satisfies LocalizedMessages<Messages>;
