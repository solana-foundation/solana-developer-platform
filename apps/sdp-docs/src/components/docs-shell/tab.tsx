import { Tab as FumadocsTab, type TabProps } from "fumadocs-ui/components/tabs";

/**
 * A guide tab (`<Tab value="API">`) whose content stays in the page, hidden, while another tab
 * shows. Its headings then exist for the table of contents and search to link to, and following
 * such a link opens the tab: Fumadocs' `<Tabs>` selects the panel that holds the URL's hash on
 * load and on each `hashchange`, which `search-dialog.tsx` fires for a result on the same page.
 */
export function Tab(props: TabProps) {
  return <FumadocsTab forceMount {...props} />;
}
