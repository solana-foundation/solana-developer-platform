export const HOME_SECTIONS = {
  gettingStarted: { id: "platform-model", title: "Getting Started" },
  tutorials: { id: "tutorials", title: "Tutorials" },
  buildWithAi: { id: "build-with-ai", title: "Build with AI" },
  partners: { id: "supported-partners", title: "Supported Partners" },
} as const satisfies Record<string, { id: string; title: string }>;

export const HOME_TOC = Object.values(HOME_SECTIONS).map((section) => ({
  title: section.title,
  url: `#${section.id}`,
  depth: 2,
}));
