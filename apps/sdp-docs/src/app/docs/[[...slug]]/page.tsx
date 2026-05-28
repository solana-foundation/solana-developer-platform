import { findNeighbour } from "fumadocs-core/page-tree";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { ComponentType } from "react";
import { HOME_TOC } from "@/components/docs-shell/home";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "@/components/docs-shell/page";
import { getDocsPagePath } from "@/lib/site";
import { source } from "@/lib/source";
import { getMDXComponents } from "../../../../mdx-components";

const mdxComponents = getMDXComponents({
  Tabs,
  Tab,
});

type DocsData = {
  title: string;
  description?: string;
  hideTitle?: boolean;
  body?: ComponentType<{ components?: Record<string, unknown> }>;
  content?: ComponentType<{ components?: Record<string, unknown> }>;
  toc?: Parameters<typeof DocsPage>[0]["toc"];
  full?: Parameters<typeof DocsPage>[0]["full"];
  steps?: string[];
};

type DocsPageProps = {
  params: Promise<{ slug?: string[] }>;
};

type ResolvedPage = {
  page: NonNullable<ReturnType<typeof source.getPage>>;
  pageSlug: string[];
};

function resolvePage(slug?: string[]): ResolvedPage | null {
  if (!slug || slug.length === 0) {
    return null;
  }

  const directPage = source.getPage(slug);
  if (directPage) {
    return { page: directPage, pageSlug: slug };
  }

  const indexSlug = [...slug, "index"];
  const indexPage = source.getPage(indexSlug);
  if (indexPage) {
    return { page: indexPage, pageSlug: indexSlug };
  }

  return null;
}

export default async function Page({ params }: DocsPageProps) {
  const { slug } = await params;

  if (!slug || slug.length === 0) {
    redirect("/docs/home");
  }

  const resolvedPage = resolvePage(slug);

  if (!resolvedPage) {
    notFound();
  }

  const data = resolvedPage.page.data as DocsData;
  const MDX = data.body ?? data.content;

  if (!MDX) {
    notFound();
  }

  const neighbours = findNeighbour(source.pageTree, resolvedPage.page.url);
  const prev = neighbours.previous
    ? { name: String(neighbours.previous.name), url: neighbours.previous.url }
    : undefined;
  const next = neighbours.next
    ? { name: String(neighbours.next.name), url: neighbours.next.url }
    : undefined;

  const isHome = resolvedPage.pageSlug.join("/") === "home";
  const baseToc = isHome ? HOME_TOC : (data.toc ?? []);
  const steps = data.steps ?? [];
  let toc = baseToc;
  if (steps.length > 0) {
    const stepItems = steps.map((title, i) => ({ title, url: `#step-${i + 1}`, depth: 3 }));
    const howItWorksIdx = baseToc.findIndex((item) => item.url === "#how-it-works");
    toc =
      howItWorksIdx >= 0
        ? [
            ...baseToc.slice(0, howItWorksIdx + 1),
            ...stepItems,
            ...baseToc.slice(howItWorksIdx + 1),
          ]
        : [...baseToc, ...stepItems];
  }

  return (
    <DocsPage toc={toc} full={data.full}>
      {!data.hideTitle && <DocsTitle>{data.title}</DocsTitle>}
      {!data.hideTitle && <DocsDescription>{data.description}</DocsDescription>}
      <DocsBody prev={prev} next={next} bare={data.hideTitle}>
        <MDX components={mdxComponents} />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: DocsPageProps): Promise<Metadata> {
  const { slug } = await params;
  const resolvedPage = resolvePage(slug);

  if (!resolvedPage) {
    return {};
  }

  const data = resolvedPage.page.data as DocsData;

  const pagePath = getDocsPagePath(Array.isArray(slug) ? slug.join("/") : "");
  return {
    title: data.title,
    description: data.description,
    alternates: {
      canonical: pagePath,
      types: {
        "text/markdown": `${pagePath}.md`,
      },
    },
  };
}
