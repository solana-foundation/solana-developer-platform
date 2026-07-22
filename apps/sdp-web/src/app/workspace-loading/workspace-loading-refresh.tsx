"use client";

import { useEffect } from "react";
import { FullscreenLoadingIndicator } from "@/components/fullscreen-loading-indicator";
import { WORKSPACE_LOADING_RETRY_MS } from "@/lib/workspace-loading";

export function WorkspaceLoadingRefresh({ returnTo }: { returnTo: string }) {
  useEffect(() => {
    const timeout = window.setTimeout(
      () => window.location.replace(returnTo),
      WORKSPACE_LOADING_RETRY_MS
    );
    return () => window.clearTimeout(timeout);
  }, [returnTo]);

  return <FullscreenLoadingIndicator />;
}
