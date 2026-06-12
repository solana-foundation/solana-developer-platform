import type {
  PlaceDetailsResponse,
  PlaceLocation,
  PlaceSuggestion,
  PlacesAutocompleteRequest,
  PlacesAutocompleteResponse,
  ResolvedPlace,
} from "@sdp/types";
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

export function staticMapUrl(location: PlaceLocation): string {
  const search = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
  });
  return `/api/dashboard/places/static-map?${search.toString()}`;
}
