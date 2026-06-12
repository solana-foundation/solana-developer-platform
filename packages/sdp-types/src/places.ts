export interface PlaceSuggestion {
  placeId: string;
  mainText: string;
  secondaryText?: string;
}

export interface PlaceLocation {
  latitude: number;
  longitude: number;
}

export interface PlaceAddressFields {
  line1: string;
  line2: string;
  city: string;
  postalCode: string;
  countryCode: string;
  subdivisionCode: string;
}

export interface ResolvedPlace {
  placeId: string;
  formattedAddress: string;
  location: PlaceLocation;
  addressFields: PlaceAddressFields;
}

export interface PlacesAutocompleteRequest {
  input: string;
  sessionToken: string;
}

export interface PlacesAutocompleteResponse {
  suggestions: PlaceSuggestion[];
}

export interface PlaceDetailsResponse {
  place: ResolvedPlace;
}
