import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { ComponentType } from "react";
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
  body?: ComponentType<{ components?: Record<string, unknown> }>;
  content?: ComponentType<{ components?: Record<string, unknown> }>;
  toc?: Parameters<typeof DocsPage>[0]["toc"];
  full?: Parameters<typeof DocsPage>[0]["full"];
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
    redirect("/docs/what-is-solana-developer-platform");
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

  return (
    <DocsPage toc={data.toc} full={data.full}>
      <DocsTitle>{data.title}</DocsTitle>
      <DocsDescription>{data.description}</DocsDescription>
      <DocsBody>
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

  return {
    title: data.title,
    description: data.description,
    alternates: {
      canonical: getDocsPagePath(Array.isArray(slug) ? slug.join("/") : ""),
    },
  };
}
