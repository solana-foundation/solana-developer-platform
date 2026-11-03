import { z } from "zod";
import type { Command, Options } from "./commands";
import type { JsonObject } from "./contract";

export const placesCommands: readonly Command[] = [
  {
    words: ["places", "autocomplete"],
    operationId: "autocompletePlaces",
    flags: {
      data: {
        type: "string",
        description: "Complete JSON object, @file.json, or - for stdin; use instead of body flags",
      },
      input: {
        type: "string",
        description: "Address search text (3–256 characters); trimming is performed by the API",
      },
      "session-token": {
        type: "string",
        description:
          "Explicit Places lookup session token (1–128 characters); reuse for the selected place details",
      },
    },
  },
  {
    words: ["places", "details", "get"],
    operationId: "getPlaceDetails",
    flags: {
      "session-token": {
        type: "string",
        description:
          "Same Places lookup session token as autocomplete; separate from --token / SDP_TOKEN",
      },
    },
  },
  {
    words: ["places", "static-map", "download"],
    operationId: "getPlacesStaticMap",
    flags: {
      latitude: { type: "string", description: "Latitude (-90 to 90), including zero" },
      longitude: { type: "string", description: "Longitude (-180 to 180), including zero" },
      output: {
        type: "string",
        description:
          "Required new output file path; the parent directory must exist; existing files are never overwritten",
      },
    },
  },
];
export const placesOptionFields = {
  input: z.string().optional(),
  "session-token": z.string().optional(),
  latitude: z.coerce.number().optional(),
  longitude: z.coerce.number().optional(),
  output: z.string().optional(),
};
export const placesQueryFields = [
  ["session-token", "sessionToken"],
  ["latitude", "latitude"],
  ["longitude", "longitude"],
] as const;
export function placesBodyFromFlags(options: Options): JsonObject {
  const body: JsonObject = {};
  if (options.input !== undefined) body.input = options.input;
  if (options["session-token"] !== undefined) body.sessionToken = options["session-token"];
  return body;
}

/** Node treats a standalone negative string value as another option. */
export function normalizePlacesArgs(args: string[]): string[] {
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index],
      next = args[index + 1];
    if (arg === "--") {
      normalized.push(...args.slice(index));
      break;
    }
    if (
      (arg === "--latitude" || arg === "--longitude") &&
      next !== undefined &&
      /^-(?:\d|\.\d)/.test(next)
    ) {
      normalized.push(`${arg}=${next}`);
      index += 1;
    } else normalized.push(arg);
  }
  return normalized;
}
