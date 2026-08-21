"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchRingsZones, type RingsZone } from "./helius-rings.data";

/**
 * Zones for one wallet. Every consumer loads for the wallet *it* has selected,
 * so a selector in one card can never surface its wallet's zones in another.
 */
export function useRingsZones(walletId: string | null, loadFailedCopy: string) {
  const [zones, setZones] = useState<RingsZone[]>([]);

  const reload = useCallback(async () => {
    if (!walletId) {
      setZones([]);
      return;
    }
    try {
      const result = await fetchRingsZones(walletId, loadFailedCopy);
      setZones(result.zones);
    } catch {
      setZones([]);
    }
  }, [walletId, loadFailedCopy]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { zones, reload };
}
