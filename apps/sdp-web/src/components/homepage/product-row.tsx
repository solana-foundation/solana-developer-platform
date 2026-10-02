import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { FormHeading } from "./form-heading";
import homepage from "./homepage.module.css";
import type { NavLink } from "./homepage-links";
import { MoreLink } from "./more-link";
import styles from "./product-row.module.css";
import { Rise } from "./rise";

type ProductRowProps = {
  id: string;
  title: [string, string];
  body: string;
  more: { link: Pick<NavLink, "href" | "external">; label: string };
  /** The words on the right and the picture on the left. */
  flip?: boolean;
  /** The first row: no hairline above it, more room. */
  first?: boolean;
  /** Give the picture the wider column. */
  wideVisual?: boolean;
  /** Center the words and the picture vertically instead of stretching them. */
  centered?: boolean;
  /** Rendered under the words, in the same column. */
  aside?: ReactNode;
  children: ReactNode;
};

/** One product: its headline, its line and a link on one side, the thing itself on the other. */
export function ProductRow({
  id,
  title,
  body,
  more,
  flip,
  first,
  wideVisual,
  centered,
  aside,
  children,
}: ProductRowProps) {
  return (
    <section id={id} data-ground="paper">
      <div
        className={cn(
          homepage.band,
          styles.row,
          flip && styles.flip,
          first && styles.first,
          wideVisual && styles.wideVisual,
          centered && styles.centered
        )}
      >
        <Rise className={styles.words}>
          <div>
            <FormHeading className={styles.title} lines={title} />
            <p className={styles.body}>{body}</p>
            <MoreLink link={more.link} icon="product">
              {more.label}
            </MoreLink>
          </div>
          {aside}
        </Rise>
        <Rise className={styles.visual}>{children}</Rise>
      </div>
    </section>
  );
}
