import type { ReactNode } from "react";
import { ExternalIcon } from "./external-icon";
import type { NavLink } from "./homepage-links";
import styles from "./more-link.module.css";
import { NavAnchor } from "./nav-anchor";

type MoreLinkProps = {
  link: Pick<NavLink, "href" | "external">;
  /** "arrow" moves on within the page; "product" leads into the product. */
  icon: "arrow" | "product";
  children: ReactNode;
};

/** The design's "read on" link, under a section's words. */
export function MoreLink({ link, icon, children }: MoreLinkProps) {
  return (
    <NavAnchor link={link} className={styles.more}>
      {children}
      {icon === "arrow" ? (
        <svg className={styles.arrow} viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 12 12 4M6 4h6v6" />
        </svg>
      ) : (
        <ExternalIcon className="opacity-100" />
      )}
    </NavAnchor>
  );
}
