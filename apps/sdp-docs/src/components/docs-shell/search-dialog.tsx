"use client";

import { useFetchSearch } from "fumadocs-core/search/client";
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SearchItemType,
} from "fumadocs-ui/components/dialog/search";
import type { SharedProps } from "fumadocs-ui/contexts/search";
import { docsSearchApiPath } from "@/lib/site";

/**
 * Goes to a result on the page already open as a link to its heading would. The dialog navigates
 * with `router.push`, which fires no `hashchange` for a same-page hash, so a guide `<Tabs>` would
 * leave the tab holding the heading closed (`tab.tsx`). Setting the hash fires it; Next then
 * replaces the history entry instead of pushing a second one.
 */
function followSamePageHash(item: SearchItemType): void {
  if (item.type === "action") return;
  const url = new URL(item.url, window.location.href);
  const samePage =
    url.origin === window.location.origin && url.pathname === window.location.pathname;
  if (!samePage || url.hash === "") return;
  if (window.location.hash === url.hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else window.location.hash = url.hash;
}

/** Fumadocs' default search dialog, on the docs search route, that also opens a guide tab. */
export function DocsSearchDialog(props: SharedProps) {
  const search = useFetchSearch({ api: docsSearchApiPath });
  return (
    <SearchDialog {...search} {...props} onSelect={followSamePageHash}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList />
      </SearchDialogContent>
    </SearchDialog>
  );
}
