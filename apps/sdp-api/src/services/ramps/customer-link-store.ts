import type { RampCustomerLink, RampCustomerLinkStore } from "@sdp/payments/ramps/types";
import type {
  CounterpartyProviderAccountRow,
  CounterpartyProviderAccountsRepository,
  GetCounterpartyProviderAccountInput,
} from "@/db/repositories/counterparty-provider-account.repository";
import { internalError } from "@/lib/errors";

function customerLinkOf(row: CounterpartyProviderAccountRow): RampCustomerLink {
  return {
    providerCustomerReference: row.provider_customer_reference,
    providerStatus: row.provider_status,
  };
}

/**
 * The customer-link store a provider's requirements member runs on (ADR 0008).
 * It is one counterparty's `customer_link` row with one provider, read and written in the caller's tenant scope.
 *
 * @param accounts - The provider-account repository.
 * @param scope - Tenant, counterparty and provider of the link.
 * @returns The store.
 */
export function createRampCustomerLinkStore(
  accounts: CounterpartyProviderAccountsRepository,
  scope: GetCounterpartyProviderAccountInput
): RampCustomerLinkStore {
  return {
    async read() {
      const row = await accounts.getProviderAccount(scope);
      return row === null ? null : customerLinkOf(row);
    },
    async link(providerCustomerReference) {
      return customerLinkOf(
        await accounts.upsertProviderAccount({ ...scope, providerCustomerReference })
      );
    },
    async recordStatus(observation) {
      if ((await accounts.recordCustomerLinkStatus({ ...scope, observation })) === "missing") {
        throw internalError("The customer link a provider status was recorded on is gone.");
      }
    },
  };
}
