import type { Context } from "hono";
import { z } from "zod";
import { badRequest, badRequestParams, badRequestQuery } from "@/lib/errors";
import { autocompletePlaces, fetchPlaceDetails, fetchStaticMap } from "@/lib/places/google";
import { success } from "@/lib/response";
import type { Env } from "@/types/env";
import {
  placeDetailsQuerySchema,
  placeIdParamsSchema,
  placesAutocompleteSchema,
  staticMapQuerySchema,
} from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

function placesEnv(c: AppContext): Record<string, string | undefined> {
  return c.env as unknown as Record<string, string | undefined>;
}

export async function autocomplete(c: AppContext) {
  const parsed = placesAutocompleteSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const suggestions = await autocompletePlaces(placesEnv(c), parsed.data);
  return success(c, { suggestions });
}

export async function getPlace(c: AppContext) {
  const params = placeIdParamsSchema.safeParse(c.req.param());
  if (!params.success) {
    throw badRequestParams({ errors: z.flattenError(params.error).fieldErrors });
  }

  const parsed = placeDetailsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw badRequestQuery({ errors: z.flattenError(parsed.error).fieldErrors });
  }

  const place = await fetchPlaceDetails(
    placesEnv(c),
    params.data.placeId,
    parsed.data.sessionToken
  );
  return success(c, { place });
}

const STATIC_MAP_SIZE = { width: 576, height: 112 };

export async function getStaticMap(c: AppContext) {
  const parsed = staticMapQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw badRequestQuery({ errors: z.flattenError(parsed.error).fieldErrors });
  }

  const upstream = await fetchStaticMap(placesEnv(c), { ...parsed.data, ...STATIC_MAP_SIZE });
  return new Response(upstream.body, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" },
  });
}
