import type { PlaceSuggestion, ResolvedPlace } from "@sdp/types";
import { z } from "zod";
import { providerUnavailable } from "@/lib/errors";
import { extractProviderErrorMessage } from "@/lib/ramps/fetch";
import { requireEnv } from "@/lib/ramps/shared";

const PLACES_API_BASE_URL = "https://places.googleapis.com/v1";
const STATIC_MAPS_API_BASE_URL = "https://maps.googleapis.com/maps/api/staticmap";
const PLACE_DETAILS_FIELD_MASK = "id,formattedAddress,location,addressComponents";
const API_KEY_ENV = "GOOGLE_ADDRESS_COMPLETION_API_KEY";

async function googleJson<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  url: string,
  init: RequestInit
): Promise<z.output<TSchema>> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw providerUnavailable(
      extractProviderErrorMessage(
        await response.json(),
        `Google Maps request failed with status ${response.status}`
      ),
      { provider: "google", providerStatus: response.status }
    );
  }
  return schema.parse(await response.json());
}

const autocompleteResponseSchema = z.object({
  // Google omits `suggestions` entirely when there are no matches (proto3 JSON
  // drops empty repeated fields), so absence means an empty result set.
  suggestions: z
    .array(
      z.object({
        placePrediction: z.object({
          placeId: z.string(),
          structuredFormat: z.object({
            mainText: z.object({ text: z.string() }),
            secondaryText: z.object({ text: z.string() }).optional(),
          }),
        }),
      })
    )
    .default([]),
});

export async function autocompletePlaces(
  env: Record<string, string | undefined>,
  request: { input: string; sessionToken: string }
): Promise<PlaceSuggestion[]> {
  const parsed = await googleJson(
    autocompleteResponseSchema,
    `${PLACES_API_BASE_URL}/places:autocomplete`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": requireEnv(env, API_KEY_ENV),
      },
      body: JSON.stringify({ input: request.input, sessionToken: request.sessionToken }),
    }
  );

  return parsed.suggestions.map(({ placePrediction }) => ({
    placeId: placePrediction.placeId,
    mainText: placePrediction.structuredFormat.mainText.text,
    secondaryText: placePrediction.structuredFormat.secondaryText?.text,
  }));
}

const addressComponentSchema = z.object({
  longText: z.string(),
  shortText: z.string(),
  types: z.array(z.string()),
});

type GoogleAddressComponent = z.infer<typeof addressComponentSchema>;

const placeDetailsResponseSchema = z.object({
  id: z.string(),
  formattedAddress: z.string(),
  location: z.object({ latitude: z.number(), longitude: z.number() }),
  addressComponents: z.array(addressComponentSchema),
});

function componentText(
  components: GoogleAddressComponent[],
  type: string,
  variant: "long" | "short"
): string {
  const match = components.find((component) => component.types.includes(type));
  if (!match) return "";
  return variant === "long" ? match.longText : match.shortText;
}

// Different countries report "city" under different component types.
const CITY_COMPONENT_TYPES = [
  "locality",
  "postal_town",
  "sublocality_level_1",
  "administrative_area_level_3",
] as const;

export async function fetchPlaceDetails(
  env: Record<string, string | undefined>,
  placeId: string,
  sessionToken: string
): Promise<ResolvedPlace> {
  const url = new URL(`${PLACES_API_BASE_URL}/places/${encodeURIComponent(placeId)}`);
  url.searchParams.set("sessionToken", sessionToken);

  const place = await googleJson(placeDetailsResponseSchema, url.toString(), {
    method: "GET",
    headers: {
      "X-Goog-Api-Key": requireEnv(env, API_KEY_ENV),
      "X-Goog-FieldMask": PLACE_DETAILS_FIELD_MASK,
    },
  });

  const components = place.addressComponents;
  const streetNumber = componentText(components, "street_number", "long");
  const route = componentText(components, "route", "long");
  let city = "";
  for (const type of CITY_COMPONENT_TYPES) {
    city = componentText(components, type, "long");
    if (city.length > 0) break;
  }

  return {
    placeId: place.id,
    formattedAddress: place.formattedAddress,
    location: place.location,
    addressFields: {
      line1: [streetNumber, route].filter((part) => part.length > 0).join(" "),
      line2: componentText(components, "subpremise", "long"),
      city,
      postalCode: componentText(components, "postal_code", "long"),
      countryCode: componentText(components, "country", "short"),
      subdivisionCode: componentText(components, "administrative_area_level_1", "short"),
    },
  };
}

export async function fetchStaticMap(
  env: Record<string, string | undefined>,
  input: { latitude: number; longitude: number; width: number; height: number }
): Promise<Response> {
  const url = new URL(STATIC_MAPS_API_BASE_URL);
  url.searchParams.set("center", `${input.latitude},${input.longitude}`);
  url.searchParams.set("zoom", "16");
  url.searchParams.set("size", `${input.width}x${input.height}`);
  url.searchParams.set("scale", "2");
  url.searchParams.set("markers", `${input.latitude},${input.longitude}`);
  url.searchParams.set("key", requireEnv(env, API_KEY_ENV));

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw providerUnavailable(`Google Static Maps request failed with status ${response.status}`, {
      provider: "google",
      providerStatus: response.status,
    });
  }
  return response;
}
