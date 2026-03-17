"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

interface TokenModalPortalProps {
  children: ReactNode;
}

export function TokenModalPortal({ children }: TokenModalPortalProps) {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  if (!isMounted) {
    return null;
  }

  return createPortal(children, document.body);
}
