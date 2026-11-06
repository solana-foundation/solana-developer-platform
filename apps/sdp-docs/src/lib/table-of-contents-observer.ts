/** Tracks visible article headings and releases both observers on teardown. */
export function observeTableOfContents<T extends { url: string }>(
  article: HTMLElement,
  items: T[],
  onVisibleItems: (items: T[]) => void,
  onActiveId: (id: string) => void
): () => void {
  let observed: HTMLElement[] | undefined;
  let visibleIds = new Set<string>();
  let disposed = false;

  const observer = new IntersectionObserver(
    (entries) => {
      if (disposed) return;
      for (const entry of entries) {
        if (entry.isIntersecting && visibleIds.has(entry.target.id)) {
          onActiveId(`#${entry.target.id}`);
          return;
        }
      }
    },
    { rootMargin: "0px 0px -60% 0px", threshold: 0 }
  );

  const updateHeadings = () => {
    if (disposed) return;
    const headings = items.flatMap((item) => {
      const element = article.ownerDocument.getElementById(item.url.slice(1));
      // Inactive panels stay mounted so search and hash links can open them.
      if (
        !element ||
        !article.contains(element) ||
        element.closest('[data-state="inactive"], [hidden]')
      ) {
        return [];
      }
      return [{ item, element }];
    });
    const elements = headings.map(({ element }) => element);
    if (
      observed?.length === elements.length &&
      observed.every((element, index) => element === elements[index])
    ) {
      return;
    }
    observed = elements;
    visibleIds = new Set(elements.map((element) => element.id));
    onVisibleItems(headings.map(({ item }) => item));
    observer.disconnect();
    for (const element of elements) observer.observe(element);
  };

  updateHeadings();
  const panels = new MutationObserver(updateHeadings);
  panels.observe(article, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-state", "hidden"],
  });

  return () => {
    disposed = true;
    panels.disconnect();
    observer.disconnect();
  };
}
