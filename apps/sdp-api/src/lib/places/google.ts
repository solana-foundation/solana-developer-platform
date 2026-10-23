import type { PlaceSuggestion, ResolvedPlace } from "@sdp/types/places";
import { z } from "zod";
import { providerUnavailable } from "@/lib/errors";
import { fetchProviderJson, type ProviderJsonRequest } from "@/lib/provider-json";
import { requireEnv } from "@/lib/runtime-env";

const PLACES_API_BASE_URL = "https://places.googleapis.com/v1";
const STATIC_MAPS_API_BASE_URL = "https://maps.googleapis.com/maps/api/staticmap";
const PLACE_DETAILS_FIELD_MASK = "id,formattedAddress,location,addressComponents";
const API_KEY_ENV = "GOOGLE_ADDRESS_COMPLETION_API_KEY";

/** An address lookup waits on the person typing; a stalled call fails rather than holding it. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Suggestions and a place's details are a few kilobytes. */
const MAX_RESPONSE_BYTES = 1024 * 1024;
/** A 576×112 map at 2× is a few tens of kilobytes; anything larger is refused. */
const MAX_MAP_RESPONSE_BYTES = 2 * 1024 * 1024;

function googleJson<TSchema extends z.ZodType>(
  schema: TSchema,
  url: string,
  init: Pick<ProviderJsonRequest, "method" | "headers" | "body">
): Promise<z.output<TSchema>> {
  return fetchProviderJson("google", url, schema, {
    ...init,
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxBytes: MAX_RESPONSE_BYTES,
  });
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

  // The same deadline and byte cap the JSON calls apply: the upstream host is
  // fixed, but a stalled or oversized answer should still fail the request
  // rather than hold a Cloud Run slot or fill memory.
  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw providerUnavailable(`Google Static Maps request failed with status ${response.status}`, {
      provider: "google",
      providerStatus: response.status,
    });
  }
  const bytes = await readCappedResponseBytes(response, MAX_MAP_RESPONSE_BYTES).catch(() => {
    throw providerUnavailable("Google Static Maps response could not be read", {
      provider: "google",
      providerStatus: response.status,
    });
  });
  return new Response(bytes, { status: 200, headers: { "Content-Type": "image/png" } });
}

/**
 * Reads a binary provider body under a byte cap, so an oversized or endless
 * answer never fills memory — the same discipline `readProviderBody` applies
 * to text answers.
 */
async function readCappedResponseBytes(
  response: Response,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer>> {
  if (response.body === null) {
    // A map response without a body is a provider failure, not an empty
    // image: serving a zero-byte PNG would turn a dropped payload into a
    // silent 200 (code standards: no fallbacks).
    throw new Error("provider response body is missing");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`provider response passed ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
