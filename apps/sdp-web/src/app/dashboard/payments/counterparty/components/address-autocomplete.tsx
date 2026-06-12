"use client";

import type { PlaceAddressFields, PlaceSuggestion, ResolvedPlace } from "@sdp/types";
import { LoaderCircleIcon, MapPinIcon, MapPinnedIcon, SearchIcon } from "lucide-react";
import { useRef, useState } from "react";
import useSWR from "swr";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  autocompletePlaces,
  fetchPlaceDetails,
  newPlacesSessionToken,
  staticMapUrl,
} from "@/lib/places";
import { useDebounce } from "@/lib/use-debounce";
import { cn } from "@/lib/utils";

const MIN_QUERY_LENGTH = 3;

interface AddressAutocompleteProps {
  onSelect: (fields: PlaceAddressFields) => void;
}

export function AddressAutocomplete({ onSelect }: AddressAutocompleteProps) {
  const [query, setQuery] = useState("");
  const [pickedQuery, setPickedQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ResolvedPlace | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [indexQuery, setIndexQuery] = useState("");
  const sessionTokenRef = useRef(newPlacesSessionToken());

  const debouncedQuery = useDebounce(query.trim(), 250);
  const searchActive =
    focused && debouncedQuery.length >= MIN_QUERY_LENGTH && debouncedQuery !== pickedQuery;

  if (indexQuery !== debouncedQuery) {
    setIndexQuery(debouncedQuery);
    setActiveIndex(-1);
  }

  const {
    data: suggestions,
    error: searchError,
    isLoading,
  } = useSWR(
    searchActive ? (["places-autocomplete", debouncedQuery] as const) : null,
    ([, input]) => autocompletePlaces(input, sessionTokenRef.current),
    {
      revalidateOnFocus: false,
      revalidateIfStale: false,
      revalidateOnReconnect: false,
      keepPreviousData: true,
    }
  );

  async function pick(suggestion: PlaceSuggestion) {
    setFocused(false);
    setQuery(suggestion.mainText);
    setPickedQuery(suggestion.mainText);
    setResolveError(null);
    setResolving(true);
    try {
      const place = await fetchPlaceDetails(suggestion.placeId, sessionTokenRef.current);
      sessionTokenRef.current = newPlacesSessionToken();
      setSelected(place);
      onSelect(place.addressFields);
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : "Failed to load place details");
    } finally {
      setResolving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="space-y-2">
        <Label htmlFor="address-search">Search address</Label>
        <div className="relative">
          <Input
            size="xl"
            id="address-search"
            iconLeft={resolving ? <LoaderCircleIcon className="animate-spin" /> : <SearchIcon />}
            placeholder="Search address or business…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setFocused(false);
                return;
              }
              if (!searchActive || !suggestions || suggestions.length === 0) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIndex((i) => (i + 1) % suggestions.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
              } else if (e.key === "Enter") {
                const active = suggestions[activeIndex];
                if (active) {
                  e.preventDefault();
                  void pick(active);
                }
              }
            }}
          />
          {searchActive && (
            <div className="absolute z-20 mt-2 w-full overflow-hidden rounded-[var(--select-popup-radius)] bg-[var(--select-popup-bg)] shadow-[var(--select-popup-shadow)]">
              <div className="max-h-56 overflow-y-auto p-1.5">
                {searchError ? (
                  <p className="px-3 py-6 text-center text-sm text-status-error-text">
                    {searchError instanceof Error ? searchError.message : "Search failed"}
                  </p>
                ) : suggestions === undefined ? (
                  <p className="px-3 py-6 text-center text-sm text-text-low">Searching…</p>
                ) : suggestions.length === 0 ? (
                  <p className="px-3 py-6 text-center text-sm text-text-low">No matches found.</p>
                ) : (
                  suggestions.map((suggestion, index) => (
                    <button
                      key={suggestion.placeId}
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-3 rounded-[var(--select-item-radius)] px-3 py-2.5 text-left transition-colors",
                        index === activeIndex
                          ? "bg-[var(--select-item-highlight-bg)]"
                          : "hover:bg-[var(--select-item-highlight-bg)]"
                      )}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void pick(suggestion)}
                    >
                      <MapPinIcon className="size-5 shrink-0 text-text-low" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-text-extra-high">
                          {suggestion.mainText}
                        </span>
                        {suggestion.secondaryText ? (
                          <span className="block truncate text-sm text-text-low">
                            {suggestion.secondaryText}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  ))
                )}
                {isLoading && suggestions !== undefined && (
                  <p className="px-3 py-1.5 text-center text-xs text-text-low">Updating…</p>
                )}
              </div>
            </div>
          )}
          {resolveError && <p className="mt-1 text-xs text-status-error-text">{resolveError}</p>}
        </div>
      </div>

      <div className="h-28 overflow-hidden rounded-xl border border-border-light">
        {selected ? (
          <img
            src={staticMapUrl(selected.location)}
            alt={selected.formattedAddress}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 bg-border-extra-light text-text-low">
            <MapPinnedIcon className="size-6" />
            <p className="text-sm">Search to preview the address</p>
          </div>
        )}
      </div>
    </div>
  );
}
