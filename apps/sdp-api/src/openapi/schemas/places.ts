import type {
  PlaceAddressFields,
  PlaceLocation,
  PlaceSuggestion,
  ResolvedPlace,
} from "@sdp/types/places";
import { z } from "zod";

export const placeSuggestionSchema = z.object({
  placeId: z.string(),
  mainText: z.string(),
  secondaryText: z.string().optional(),
}) satisfies z.ZodType<PlaceSuggestion>;
const placeLocationSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
}) satisfies z.ZodType<PlaceLocation>;
const placeAddressFieldsSchema = z.object({
  line1: z.string(),
  line2: z.string(),
  city: z.string(),
  postalCode: z.string(),
  countryCode: z.string(),
  subdivisionCode: z.string(),
}) satisfies z.ZodType<PlaceAddressFields>;
export const resolvedPlaceSchema = z.object({
  placeId: z.string(),
  formattedAddress: z.string(),
  location: placeLocationSchema,
  addressFields: placeAddressFieldsSchema,
}) satisfies z.ZodType<ResolvedPlace>;
