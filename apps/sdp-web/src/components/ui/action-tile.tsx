import { ActionTile as UiActionTile } from "@sdp/ui/action-tile";
import Link from "next/link";
import type { ComponentProps } from "react";

/** The package tile, linking through next/link as it always has in the dashboard. */
export function ActionTile(props: Omit<ComponentProps<typeof UiActionTile>, "linkComponent">) {
  return <UiActionTile linkComponent={Link} {...props} />;
}
