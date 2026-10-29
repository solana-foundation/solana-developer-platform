import type { MovementId, MovementOf } from "@sdp/types/movements";
import type { SdpModule } from "@sdp/types/release-channels";
import { describe, expectTypeOf, it } from "vitest";
import { createIssuanceSponsor } from "@/services/issuance/sponsored-submitter";
import { sendSubscriptionInstructions } from "@/services/payments/recurring-payments/shared";
import { createPrivateChannelSigner } from "@/services/private-channels/wallet-access";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import { createSponsorshipFeePayment, type SponsorshipScope } from "@/services/sponsorship.service";
import type { Env } from "@/types/env";

declare const env: Env;
declare const scope: SponsorshipScope;
declare const movement: MovementId;
declare const wallet: Parameters<typeof createPrivateChannelSigner>[3];
declare const subscription: Omit<Parameters<typeof sendSubscriptionInstructions>[0], "movement">;
const subject = { custodyWalletId: "wallet" };

/**
 * HOO-2098: each signing waist takes only the calling module's movements, so a
 * flow cannot pass another module's exit and skip admission. Compile-time
 * only; never called.
 */
function waistMovementTypeChecks(): void {
  void createOrgSignerForCustodyWallet<"payments">(env, "o", "p", "w", "payments.transfer");
  // @ts-expect-error Another module's exit does not compile.
  void createOrgSignerForCustodyWallet<"payments">(env, "o", "p", "w", "earn.withdraw");
  // @ts-expect-error A call that names no module admits no movement.
  void createOrgSignerForCustodyWallet(env, "o", "p", "w", "payments.transfer");
  // @ts-expect-error A wide `MovementId` does not narrow to the module.
  void createOrgSignerForCustodyWallet<"payments">(env, "o", "p", "w", movement);

  createSponsorshipFeePayment<"dvp">(env, scope, "dvp.cancel", subject);
  // @ts-expect-error Another module's exit does not compile.
  createSponsorshipFeePayment<"dvp">(env, scope, "recurring.cancel", subject);
  // @ts-expect-error A call that names no module admits no movement.
  createSponsorshipFeePayment(env, scope, "dvp.cancel", subject);

  createIssuanceSponsor(env, scope, "issuance.control", subject);
  // @ts-expect-error The issuance sponsor takes only issuance movements.
  createIssuanceSponsor(env, scope, "dvp.reclaim", subject);

  void createPrivateChannelSigner(env, "o", "p", wallet, "private_channels.withdraw");
  // @ts-expect-error Private Channels signs only its own movements.
  void createPrivateChannelSigner(env, "o", "p", wallet, "helius_rings.operation_exit");

  void sendSubscriptionInstructions({ ...subscription, movement: "recurring.cancel" });
  // @ts-expect-error Recurring payments sign only their own movements.
  void sendSubscriptionInstructions({ ...subscription, movement: "earn.withdraw" });
}

describe("signing waist movements", () => {
  it("rejects another module's movement at every entry point", () => {
    expectTypeOf(waistMovementTypeChecks).toBeFunction();
  });

  it("narrows each waist to the named module's movements", () => {
    expectTypeOf(createOrgSignerForCustodyWallet<"earn">)
      .parameter(4)
      .toEqualTypeOf<MovementOf<"earn">>();
    expectTypeOf(createSponsorshipFeePayment<"ramps">)
      .parameter(2)
      .toEqualTypeOf<MovementOf<"ramps">>();
    expectTypeOf(createOrgSignerForCustodyWallet<SdpModule>)
      .parameter(4)
      .toEqualTypeOf<MovementId>();
  });
});
