import { DEFAULT_SDP_DOCS_URL, getSdpDocsOrigin } from "@sdp/types/site";
import { z } from "zod";

const relatedProjectsSchema = z.array(
  z.object({
    project: z.object({ name: z.string() }),
    preview: z.object({ branch: z.string().optional(), customEnvironment: z.string().optional() }),
    production: z.object({ alias: z.string().optional(), url: z.string().optional() }),
  })
);

function relatedDashboardUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = env.VERCEL_RELATED_PROJECTS;
  if (!raw) return null;

  try {
    const projects = relatedProjectsSchema.safeParse(JSON.parse(raw) as unknown);
    if (!projects.success) return null;
    const web = projects.data.find(({ project }) => project.name === "sdp-web");
    const host =
      env.VERCEL_ENV === "preview"
        ? (web?.preview.customEnvironment ?? web?.preview.branch)
        : env.VERCEL_ENV === "production"
          ? (web?.production.alias ?? web?.production.url)
          : null;
    return host ? `https://${host}` : null;
  } catch {
    return null;
  }
}

/** The dashboard deployment paired with this docs build. */
export function resolveDashboardUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidate =
    relatedDashboardUrl(env) ??
    (env.VERCEL_ENV === "preview"
      ? null
      : (env.NEXT_PUBLIC_SDP_WEB_URL?.trim() ??
        (env.NODE_ENV === "production"
          ? getSdpDocsOrigin(DEFAULT_SDP_DOCS_URL)
          : "http://localhost:3000")));
  if (!candidate) return null;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}
