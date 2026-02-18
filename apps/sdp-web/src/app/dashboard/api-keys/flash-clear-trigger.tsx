"use client";

import { useEffect, useRef } from "react";
import { clearApiKeyFlashAction } from "./actions";

export function FlashClearTrigger() {
  const cleared = useRef(false);

  useEffect(() => {
    if (cleared.current) return;
    cleared.current = true;
    void clearApiKeyFlashAction();
  }, []);

  return null;
}
