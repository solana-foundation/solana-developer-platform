"use client";

import { Toaster } from "sonner";
import { useTheme } from "@/contexts/theme-context";

/** sonner Toaster wired to the active theme (it doesn't read our CSS vars). */
export function AppToaster() {
  const { theme } = useTheme();
  return (
    <Toaster
      position="bottom-right"
      mobileOffset={{ bottom: "calc(80px + env(safe-area-inset-bottom))", left: 16, right: 16 }}
      richColors
      closeButton
      theme={theme}
    />
  );
}
