import type { Context } from "hono";
import { autocompletePlaces, fetchPlaceDetails, fetchStaticMap } from "@/lib/places/google";
import { success } from "@/lib/response";
import type { ValidatedBodyContext, ValidatedContext } from "@/middleware/validate";
import type { Env } from "@/types/env";
import type {
  placeDetailsQuerySchema,
  placeIdParamsSchema,
  placesAutocompleteSchema,
  staticMapQuerySchema,
} from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

function placesEnv(c: AppContext): Record<string, string | undefined> {
  return c.env as unknown as Record<string, string | undefined>;
}

export async function autocomplete(c: ValidatedBodyContext<typeof placesAutocompleteSchema>) {
  const body = c.req.valid("json");

  const suggestions = await autocompletePlaces(placesEnv(c), body);
  return success(c, { suggestions });
}

export async function getPlace(
  c: ValidatedContext<{ param: typeof placeIdParamsSchema; query: typeof placeDetailsQuerySchema }>
) {
  const { placeId } = c.req.valid("param");
  const { sessionToken } = c.req.valid("query");

  const place = await fetchPlaceDetails(placesEnv(c), placeId, sessionToken);
  return success(c, { place });
}

const STATIC_MAP_SIZE = { width: 576, height: 112 };

export async function getStaticMap(c: ValidatedContext<{ query: typeof staticMapQuerySchema }>) {
  const query = c.req.valid("query");

  const upstream = await fetchStaticMap(placesEnv(c), { ...query, ...STATIC_MAP_SIZE });
  return new Response(upstream.body, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" },
  });
}
