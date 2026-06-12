import { z } from "zod";

export const placesAutocompleteSchema = z.object({
  input: z.string().trim().min(3).max(256),
  sessionToken: z.string().trim().min(1).max(128),
});

export const placeDetailsQuerySchema = z.object({
  sessionToken: z.string().trim().min(1).max(128),
});

export const placeIdParamsSchema = z.object({
  placeId: z.string().trim().min(1).max(512),
});

export const staticMapQuerySchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
});
