import {
  isRampTransferType,
  type PaymentTransferType,
  type RampProviderId,
  type SdpModule,
  type SdpRampProviderStages,
} from "@sdp/types";
import type { Context, Next } from "hono";
import { forbidden, internalError } from "@/lib/errors";
import { isModuleAvailable, isRampProviderAvailable } from "@/lib/feature-flags";
import { rampProviderSchema } from "@/routes/payments/ramps/schemas";
import type { Env } from "@/types/env";

type ReleaseChannelContext = Context<{ Bindings: Env }>;

/** The ramp provider stages `createApp` runs the release channel against. */
function rampProviderStages(c: ReleaseChannelContext): SdpRampProviderStages {
  return c.get("rampProviderStages");
}

/** Whether the deployment's release channel includes ramp `provider`. */
export function isRampProviderInChannel(
  c: ReleaseChannelContext,
  provider: RampProviderId
): boolean {
  return isRampProviderAvailable(c.env, provider, rampProviderStages(c));
}

/** Refuses a request that names a ramp provider the release channel leaves out. */
export function assertRampProviderInChannel(
  c: ReleaseChannelContext,
  provider: RampProviderId
): void {
  if (!isRampProviderInChannel(c, provider)) {
    throw forbidden(`The ${provider} ramp provider is not available in this release channel.`);
  }
}

/** Whether the deployment's release channel includes `module`. */
export function isModuleInChannel(c: ReleaseChannelContext, module: SdpModule): boolean {
  return isModuleAvailable(c.env, module, rampProviderStages(c));
}

/** Refuses a request that names a module the release channel leaves out. */
export function assertModuleInChannel(c: ReleaseChannelContext, module: SdpModule): void {
  if (!isModuleInChannel(c, module)) {
    throw forbidden(`The ${module} module is not available in this release channel.`);
  }
}

/**
 * Refuses a request about a stored ramp transfer whose provider the release channel
 * leaves out. A ramp transfer always has a provider, so a missing one is a data bug
 * and fails instead of skipping the gate. Other transfer types pass through.
 */
export function assertTransferRampProviderInChannel(
  c: ReleaseChannelContext,
  transfer: { type: PaymentTransferType; provider: RampProviderId | null }
): void {
  if (!isRampTransferType(transfer.type)) {
    return;
  }
  if (transfer.provider === null) {
    throw internalError("Ramp transfer has no provider.");
  }
  assertRampProviderInChannel(c, transfer.provider);
}

/**
 * Refuses every request to a module the deployment's release channel leaves out.
 * Mount it ahead of auth so an excluded module answers the same to everyone.
 */
export function requireModule(module: SdpModule) {
  return async (c: ReleaseChannelContext, next: Next) => {
    assertModuleInChannel(c, module);
    await next();
  };
}

/** Refuses every request to one ramp provider's routes when its release channel leaves it out. */
export function requireRampProvider(provider: RampProviderId) {
  return async (c: ReleaseChannelContext, next: Next) => {
    assertRampProviderInChannel(c, provider);
    await next();
  };
}

/**
 * `requireRampProvider` for routes that name the provider in a path parameter.
 * A name that is not a ramp provider passes through, so the route answers it as before.
 */
export function requireRampProviderParam(param: string) {
  return async (c: ReleaseChannelContext, next: Next) => {
    const provider = rampProviderSchema.safeParse(c.req.param(param));
    if (provider.success) {
      assertRampProviderInChannel(c, provider.data);
    }
    await next();
  };
}
