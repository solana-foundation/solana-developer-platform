"use client";

// The asset-management header's two appearance axes, persisted per browser.
import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "sdp.issuance.headerAppearance";

export const HEADER_APPEARANCE_VALUES = {
  // Which side the logo sits on. Everything positioned against it — the ticker,
  // the reserved clearance, the floating actions — follows from this one value,
  // so it mirrors the whole card.
  layout: ["default", "mirrored"],
  // How much the header spells out. See HEADER_MODES in asset-profile-header.tsx
  // for what each one changes.
  mode: ["default", "expanded"],
} as const;

export interface HeaderAppearance {
  layout: (typeof HEADER_APPEARANCE_VALUES.layout)[number];
  mode: (typeof HEADER_APPEARANCE_VALUES.mode)[number];
}

// What every user gets: the controls below are developer-only, so in production
// these are the only values in play.
export const HEADER_APPEARANCE_DEFAULTS: HeaderAppearance = {
  layout: "default",
  mode: "default",
};

/**
 * Each axis falls back to its default independently, so a stored value written
 * before an axis existed — or with a value since renamed — still yields a usable
 * appearance rather than being discarded whole.
 */
export function normalizeHeaderAppearance(raw: unknown): HeaderAppearance {
  if (typeof raw !== "object" || raw === null) {
    return HEADER_APPEARANCE_DEFAULTS;
  }
  const parsed = raw as Record<string, unknown>;
  const appearance = { ...HEADER_APPEARANCE_DEFAULTS };
  for (const key of Object.keys(appearance) as (keyof HeaderAppearance)[]) {
    const allowed = HEADER_APPEARANCE_VALUES[key] as readonly string[];
    const value = parsed[key];
    if (typeof value === "string" && allowed.includes(value)) {
      // Each key is its own union, so the write needs the cast the loop erases.
      appearance[key] = value as never;
    }
  }
  return appearance;
}

function readStored(): HeaderAppearance {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeHeaderAppearance(JSON.parse(raw)) : HEADER_APPEARANCE_DEFAULTS;
  } catch {
    return HEADER_APPEARANCE_DEFAULTS;
  }
}

/**
 * SSR and the first client paint always render the defaults; the stored choice
 * applies once the client has taken over, so the markup the server sends is
 * deterministic. `hydrated` is false until then, for callers that would rather
 * show a placeholder than a selection that may be about to change.
 */
export function useHeaderAppearance(): {
  appearance: HeaderAppearance;
  hydrated: boolean;
  setAppearanceOption: <K extends keyof HeaderAppearance>(
    key: K,
    value: HeaderAppearance[K]
  ) => void;
} {
  const [appearance, setAppearance] = useState(HEADER_APPEARANCE_DEFAULTS);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setAppearance(readStored());
    setHydrated(true);
  }, []);
  const setAppearanceOption = useCallback(
    <K extends keyof HeaderAppearance>(key: K, value: HeaderAppearance[K]) => {
      setAppearance((previous) => {
        const next = { ...previous, [key]: value };
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          // Storage unavailable — the selection holds for this session only.
        }
        return next;
      });
    },
    []
  );
  return { appearance, hydrated, setAppearanceOption };
}
