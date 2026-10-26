"use client";

import { useState } from "react";
import useSWR, { type Key, type SWRConfiguration, type SWRResponse } from "swr";

/**
 * `useSWR` polling at a cadence derived from the data it last read, handed to SWR as a number.
 *
 * SWR restarts a poll only when `refreshInterval` changes, and evaluates a function interval only
 * when a tick fires. A stable function therefore reads the cold-mount `undefined` once and, if
 * that says 0, never starts; an inline one restarts the timer on every render, so a page that
 * re-renders faster than the cadence never polls. A number derived from the last read changes
 * exactly when the cadence does: a flip (idle to active, or to 0 once nothing is left to watch)
 * restarts the timer at once, and nothing else touches it.
 *
 * @param key - The SWR key; `null` issues no request.
 * @param fetcher - Reads the data; it takes no key arguments.
 * @param cadence - The poll interval for the latest data (`undefined` before the first read lands), 0 to stop.
 * @param config - Every other SWR option.
 * @returns The SWR response.
 */
export function useCadencedSWR<Data>(
  key: Key,
  fetcher: () => Promise<Data>,
  cadence: (data: Data | undefined) => number,
  config: Omit<SWRConfiguration<Data, Error>, "refreshInterval"> = {}
): SWRResponse<Data, Error> {
  const [refreshInterval, setRefreshInterval] = useState(() => cadence(undefined));
  const response = useSWR<Data, Error>(key, fetcher, { ...config, refreshInterval });
  // The interval is SWR's input and the data its output, so the cadence a read implies is stored
  // during render (React's previous-value pattern): React re-renders at once with the new number,
  // before SWR's poll effect runs.
  const next = cadence(response.data);
  if (next !== refreshInterval) setRefreshInterval(next);
  return response;
}
