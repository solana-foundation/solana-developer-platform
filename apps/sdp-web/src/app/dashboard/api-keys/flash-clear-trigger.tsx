"use client";

import { useEffect, useRef } from "react";

export function FlashClearTrigger() {
  const cleared = useRef(false);

  useEffect(() => {
    if (cleared.current) return;
    cleared.current = true;
    void fetch("/api/dashboard/api-keys/flash", {
      method: "DELETE",
      credentials: "same-origin",
    });
  }, []);

  return null;
}
