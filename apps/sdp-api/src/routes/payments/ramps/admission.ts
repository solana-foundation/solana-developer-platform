import type { MovementOf } from "@sdp/types/movements";
import type { PaymentTransferType, RampDirection } from "@sdp/types/payments";
import type { PersistedRampProviderId, RampProviderId } from "@sdp/types/provider-access";
import { getAuth, requireProjectId } from "@/lib/auth";
import { assertMoneyStartAdmitted } from "@/lib/money-admission";
import {
  assertRampProviderInChannel,
  assertTransferRampProviderInChannel,
} from "@/middleware/require-module";
import type { AppContext } from "@/routes/payments/context";
import {
  assertProviderAvailable,
  loadProjectProviderVerdict,
  type ProjectProviderDecision,
  refuseProjectProvider,
} from "@/services/provider-availability.service";

export type RampAdmission =
  | { need: "read"; provider: RampProviderId }
  | {
      need: "quote";
      provider: RampProviderId;
      direction: RampDirection;
      /**
       * The custody wallet the request names for the quote's crypto leg. The
       * money admission checks the principal may use it (HOO-2099): a quote
       * signs nothing, so no custody signer decides it later.
       */
      custodyWalletId: string;
    }
  | {
      need: "cancel";
      transfer: {
        type: PaymentTransferType;
        provider: PersistedRampProviderId | null;
        custody_wallet_id: string | null;
      };
    };

const RAMP_QUOTE_MOVEMENT = {
  onramp: "ramps.onramp_quote",
  offramp: "ramps.offramp_quote",
} as const satisfies Record<RampDirection, MovementOf<"ramps">>;

/**
 * The one access check ramp routes make. `quote` and `read` apply the project
 * provider rule (release channel, surfacing, entitlement, credentials) before
 * any provider call; `read` first refuses an out-of-channel provider before
 * any database read, as reads always have. `quote` then admits the money
 * start (HOO-1955): a provider quote or session never reaches the custody
 * signer, so it is admitted here instead, with the same decision the custody
 * signer makes: the principal holds the quote's action and may use the named
 * wallet. `cancel` keeps a stored transfer's provider in the release channel,
 * for every provider; cancelling is an exit.
 */
export async function admitRamp(c: AppContext, admission: RampAdmission): Promise<void> {
  if (admission.need === "cancel") {
    assertTransferRampProviderInChannel(c, admission.transfer);
    return;
  }
  if (admission.need === "read") {
    assertRampProviderInChannel(c, admission.provider);
  }
  await assertProviderAvailable(c, { family: "ramps", provider: admission.provider });
  if (admission.need === "quote") {
    await assertMoneyStartAdmitted(
      c.env,
      { organizationId: getAuth(c).organizationId, projectId: requireProjectId(c) },
      {
        surface: "http",
        movement: RAMP_QUOTE_MOVEMENT[admission.direction],
        subjectId: admission.custodyWalletId,
      },
      { custodyWalletId: admission.custodyWalletId }
    );
  }
}

/**
 * Which ramp providers' stored accounts a listing may show and enrich, from one
 * project lookup. Release channel, surfacing and entitlement hide a provider;
 * missing deployment credentials don't hide accounts already stored. A listing
 * filtered to one provider refuses it (logged) when it would be hidden.
 *
 * @returns Whether a provider's accounts may be listed and enriched.
 */
export async function loadRampListingAdmission(
  c: AppContext,
  requestedProvider: RampProviderId | undefined
): Promise<(provider: RampProviderId) => boolean> {
  if (requestedProvider !== undefined) {
    assertRampProviderInChannel(c, requestedProvider);
  }
  const verdict = await loadProjectProviderVerdict(c);
  const decide = (provider: RampProviderId) => verdict.decide({ family: "ramps", provider });
  const listable = (decision: ProjectProviderDecision) =>
    decision.admitted || decision.reason === "provider_not_configured";
  if (requestedProvider !== undefined) {
    const decision = decide(requestedProvider);
    if (!decision.admitted && decision.reason !== "provider_not_configured") {
      throw refuseProjectProvider(decision);
    }
  }
  return (provider) => listable(decide(provider));
}
