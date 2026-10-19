import { API_KEY_GRANTABLE_ACTIONS } from "@sdp/types/actions";
import type { MoneyAdmissionFacts, MoneyPrincipalFacts } from "@/lib/money-admission";

/** A live all-wallets API key holding every grantable action: admits any start. */
export const LIVE_KEY_PRINCIPAL_FACTS: MoneyPrincipalFacts = {
  kind: "api_key",
  key: {
    status: "active",
    expires_at: null,
    rotation_deadline: null,
    grants: [...API_KEY_GRANTABLE_ACTIONS],
    walletScope: "all",
    walletListed: null,
  },
};

/** Admission facts for an active organization's project, with a live principal. */
export function admittedMoneyFacts(
  overrides: Partial<MoneyAdmissionFacts> = {}
): MoneyAdmissionFacts {
  return {
    organizationStatus: "active",
    projectEnvironment: "sandbox",
    rawSettings: null,
    principal: LIVE_KEY_PRINCIPAL_FACTS,
    readAt: Date.now(),
    ...overrides,
  };
}
