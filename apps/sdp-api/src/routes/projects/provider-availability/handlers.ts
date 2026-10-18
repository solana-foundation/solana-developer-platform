import type { ProjectProviderAvailability } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db/client";
import { getAuth } from "@/lib/auth";
import { success } from "@/lib/response";
import { isModuleInChannel, isRampProviderInChannel } from "@/middleware/require-module";
import { EARN_PUBLIC_SURFACE_PUBLISHED } from "@/openapi/spec";
import { getProjectProviderAvailability } from "@/services/provider-availability.service";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

/**
 * Narrows a project's provider availability to the entries the deployment's
 * public API document publishes, so a client validating against it accepts the
 * response: Earn entries only when `EARN_PUBLIC_SURFACE_PUBLISHED` is true and
 * the release channel runs Earn, ramp entries only for providers the release
 * channel runs (the document prunes the others; openapi/release-channel-values.ts).
 *
 * @param c - Request context, for the deployment's release channel.
 * @param availability - The project's availability across every family.
 * @returns The availability restricted to the published entries.
 */
function publishedProviderAvailability(
  c: AppContext,
  availability: ProjectProviderAvailability
): ProjectProviderAvailability {
  const earnPublished = EARN_PUBLIC_SURFACE_PUBLISHED && isModuleInChannel(c, "earn");
  return {
    ...availability,
    providers: availability.providers.filter((entry) => {
      if (entry.family === "earn") return earnPublished;
      if (entry.family === "ramps") return isRampProviderInChannel(c, entry.provider);
      return true;
    }),
  };
}

/**
 * Lists every provider the deployment knows with its availability for the
 * project in the path. A project outside the caller's organization is a 404.
 *
 * @param c - Request context; the projects router has authenticated the caller,
 *   bound API keys to their own project and admitted sessions by membership.
 * @returns The project's provider availability in the success envelope.
 */
export const getProjectProviderAvailabilityHandler = async (c: AppContext) => {
  const { projectId } = c.req.param();
  const availability = await getProjectProviderAvailability(c.env, getDb(c.env), {
    organizationId: getAuth(c).organizationId,
    projectId,
  });
  return success(c, publishedProviderAvailability(c, availability));
};
