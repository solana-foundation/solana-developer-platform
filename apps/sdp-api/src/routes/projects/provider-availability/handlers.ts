import type { ProjectProviderAvailability } from "@sdp/types/provider-access";
import type { Context } from "hono";
import { getDb } from "@/db/client";
import { getAuth } from "@/lib/auth";
import { success } from "@/lib/response";
import { isProjectProviderEntryInChannel } from "@/middleware/require-module";
import { getProjectProviderAvailability } from "@/services/provider-availability.service";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

/**
 * Narrows a project's provider availability to the entries the deployment's
 * public API document publishes, so a client validating against it accepts the
 * response. Families follow their module's release channel; ramp entries follow
 * their provider's channel, and custody entries appear only for providers the
 * channel offers in some custody mode (openapi/release-channel-values.ts).
 *
 * @param c - Request context, for the deployment's release channel.
 * @param availability - The project's availability across every family.
 * @returns The availability restricted to the published entries.
 */
function publishedProviderAvailability(
  c: AppContext,
  availability: ProjectProviderAvailability
): ProjectProviderAvailability {
  return {
    ...availability,
    // Custody uses "offered", not the document's `isCustodyProviderPublished`: that
    // never names `local`, which a self-hosted dashboard sets up through this route.
    // The document's custody response enums are open, so a `local` entry still validates.
    providers: availability.providers.filter((entry) => isProjectProviderEntryInChannel(c, entry)),
  };
}

/**
 * Lists every provider the deployment's public document publishes with its
 * availability for the project in the path. A project outside the caller's
 * organization is a 404.
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
