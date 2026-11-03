import type {
  PlaceDetailsResponse,
  PlaceSuggestion,
  PlacesAutocompleteRequest,
  PlacesAutocompleteResponse,
  ResolvedPlace,
} from "@sdp/types/places";
import { dashboardFetch } from "@/lib/dashboard-fetch";

export function newPlacesSessionToken(): string {
  return crypto.randomUUID();
}

export async function autocompletePlaces(
  input: string,
  sessionToken: string
): Promise<PlaceSuggestion[]> {
  const body: PlacesAutocompleteRequest = { input, sessionToken };
  const result = await dashboardFetch<{ data: PlacesAutocompleteResponse }>(
    "/api/dashboard/places/autocomplete",
    { method: "POST", body }
  );
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.data.data.suggestions;
}

export async function fetchPlaceDetails(
  placeId: string,
  sessionToken: string
): Promise<ResolvedPlace> {
  const search = new URLSearchParams({ sessionToken });
  const result = await dashboardFetch<{ data: PlaceDetailsResponse }>(
    `/api/dashboard/places/${encodeURIComponent(placeId)}?${search.toString()}`
  );
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.data.data.place;
}
