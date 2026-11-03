/** Existing address-lookup routes. Internal until explicitly published. */
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { SecurityRequirementObject } from "openapi3-ts/oas30";
import { z } from "zod";
import { errorResponseSchema, successResponseSchema, withOpenApi } from "@/openapi/schemas/base";
import { placeSuggestionSchema, resolvedPlaceSchema } from "@/openapi/schemas/places";
import {
  placeDetailsQuerySchema,
  placeIdParamsSchema,
  placesAutocompleteSchema,
  staticMapQuerySchema,
} from "@/routes/places/schemas";
import { errorResponses, jsonContent } from "./helpers";

export function registerPlacesPaths(registry: OpenAPIRegistry) {
  const security: SecurityRequirementObject[] = [{ apiKeyAuth: [] }, { clerkBearerAuth: [] }];
  const errors = errorResponses(errorResponseSchema, [400, 401, 403, 429, 500, 503]);
  registry.registerPath({
    method: "post",
    path: "/v1/places/autocomplete",
    tags: ["Places & Address Lookup"],
    summary: "Autocomplete an address",
    operationId: "autocompletePlaces",
    description:
      "Returns Google Places address suggestions for 3-256 characters of input. Supply an explicit sessionToken (1-128 characters) and reuse it for the selected place's details request. The token groups provider lookup requests; it is separate from the SDP credential. Requires counterparties.manage, charges the Places quota, and does not require a project header. No idempotency key is supported.",
    security,
    request: { body: { required: true, content: jsonContent(placesAutocompleteSchema) } },
    responses: {
      200: {
        description: "Address suggestions; an empty list is valid",
        content: jsonContent(
          successResponseSchema(z.object({ suggestions: z.array(placeSuggestionSchema) }))
        ),
      },
      ...errors,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/places/{placeId}",
    tags: ["Places & Address Lookup"],
    summary: "Resolve a place to address fields and coordinates",
    operationId: "getPlaceDetails",
    description:
      "Resolves one place ID using the autocomplete sessionToken. Returns the formatted address, location, and address fields, including empty strings when components are unavailable. Requires counterparties.manage and charges the Places quota. No project header or idempotency key is supported. The literal static-map path is reserved for the map endpoint.",
    security,
    request: { params: placeIdParamsSchema, query: placeDetailsQuerySchema },
    responses: {
      200: {
        description: "Resolved place",
        content: jsonContent(successResponseSchema(z.object({ place: resolvedPlaceSchema }))),
      },
      ...errors,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/places/static-map",
    tags: ["Places & Address Lookup"],
    summary: "Download a static map for coordinates",
    operationId: "getPlacesStaticMap",
    description:
      "Returns raw PNG bytes for latitude (-90 to 90) and longitude (-180 to 180). The server selects the map size, zoom, scale, and marker. Requires counterparties.manage and charges the Places quota. Does not require a lookup sessionToken or project header, and accepts no idempotency key. Errors are JSON, not images.",
    security,
    request: {
      query: staticMapQuerySchema.extend({
        latitude: withOpenApi(staticMapQuerySchema.shape.latitude, {
          param: { name: "latitude", in: "query", required: true },
        }),
        longitude: withOpenApi(staticMapQuerySchema.shape.longitude, {
          param: { name: "longitude", in: "query", required: true },
        }),
      }),
    },
    responses: {
      200: {
        description: "PNG static map",
        content: { "image/png": { schema: z.string().openapi({ format: "binary" }) } },
      },
      ...errors,
    },
  });
}
