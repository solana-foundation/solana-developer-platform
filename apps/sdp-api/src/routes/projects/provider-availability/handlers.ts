import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { badRequestParams } from "@/lib/errors";
import { success } from "@/lib/response";
import { getProjectProviderAvailability } from "@/services/provider-availability.service";
import type { Env } from "@/types/env";
import { projectProviderAvailabilityParamsSchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

/**
 * Lists every provider the deployment knows with its availability for the
 * project in the path. A project outside the caller's organization is a 404.
 *
 * @param c - Request context; the projects router has authenticated the caller
 *   and bound API keys to their own project.
 * @returns The project's provider availability in the success envelope.
 */
export const getProjectProviderAvailabilityHandler = async (c: AppContext) => {
  const params = projectProviderAvailabilityParamsSchema.safeParse(c.req.param());
  if (!params.success) {
    throw badRequestParams();
  }

  const availability = await getProjectProviderAvailability(c.env, getDb(c.env), {
    organizationId: getAuth(c).organizationId,
    projectId: params.data.projectId,
  });
  return success(c, availability);
};
