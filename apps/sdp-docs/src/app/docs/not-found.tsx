import Link from "next/link";
import { DocsDescription, DocsPage, DocsTitle } from "@/components/docs-shell/page";
import { SearchButton } from "@/components/docs-shell/search-button";

/** A missing docs page, inside the docs shell so the sidebar and search stay in reach. */
export default function NotFound() {
  return (
    <DocsPage>
      <DocsTitle>Page not found</DocsTitle>
      <DocsDescription>This page moved or no longer exists.</DocsDescription>
      <div className="launch-home-actions launch-docs-not-found-actions">
        <SearchButton className="launch-home-cta-primary" />
        <Link href="/docs" className="launch-home-cta-secondary">
          Back to Get started
        </Link>
      </div>
    </DocsPage>
  );
}
