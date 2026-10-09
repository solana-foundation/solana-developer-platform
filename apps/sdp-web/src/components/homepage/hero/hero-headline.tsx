import { cn } from "@/lib/utils";
import { FormHeadline } from "../form-headline";
import styles from "./hero.module.css";

/* the headline forms 700ms in, letter after letter at 30ms */
const FORM_AT_MS = 700;
const FORM_STAGGER_MS = 30;

/**
 * The hero's statement: "The interface / to onchain finance", formed letter by letter from 700ms
 * after first paint and the two phrases selected in turn (hero.module.css). Both run on the CSS
 * clock, so the words and their selection boxes keep time whenever the page hydrates.
 */
export function HeroHeadline({
  lead,
  selected,
  secondLead,
  chosen,
}: {
  lead: string;
  selected: string;
  secondLead: string;
  chosen: string;
}) {
  return (
    <FormHeadline
      as="h1"
      className={styles.title}
      stagger={FORM_STAGGER_MS}
      formAt={FORM_AT_MS}
      parts={[
        `${lead} `,
        { text: selected, className: cn(styles.sel, styles.selA) },
        { lineBreak: true },
        `${secondLead} `,
        { text: chosen, className: cn(styles.sel, styles.selB) },
      ]}
    />
  );
}
