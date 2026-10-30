import { getMessages } from "@/i18n/messages";

/**
 * The hrefs of the homepage links that carry the "Coming soon" pill, in document order.
 *
 * @param links - The rendered links to check.
 * @returns Each pilled link's href.
 */
export function comingSoonHrefs(links: Iterable<Element>): (string | null)[] {
  const label = getMessages("en").Homepage.comingSoon;
  return Array.from(links)
    .filter((link) => link.textContent.includes(label))
    .map((link) => link.getAttribute("href"));
}
