import { DEFAULT_SDP_DOCS_URL, getSdpDocsOrigin } from "@sdp/types/site";
import { z } from "zod";

const relatedProjectsSchema = z.array(
  z.object({
    project: z.object({ name: z.string() }),
    preview: z.object({ branch: z.string().optional(), customEnvironment: z.string().optional() }),
    production: z.object({ alias: z.string().optional(), url: z.string().optional() }),
  })
);
const vercelEnvironmentSchema = z.enum(["preview", "production", "development"]).optional();
type VercelEnvironment = z.infer<typeof vercelEnvironmentSchema>;

function relatedDashboardUrl(
  env: NodeJS.ProcessEnv,
  environment: VercelEnvironment
): string | null {
  const raw = env.VERCEL_RELATED_PROJECTS;
  if (!raw) return null;

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("VERCEL_RELATED_PROJECTS must be valid JSON");
  }
  const projects = relatedProjectsSchema.safeParse(data);
  if (!projects.success) throw new Error("VERCEL_RELATED_PROJECTS has invalid project data");
  const web = projects.data.find(({ project }) => project.name === "sdp-web");
  if (!web) throw new Error("VERCEL_RELATED_PROJECTS must include sdp-web");
  let host: string | undefined;
  switch (environment) {
    case "preview":
      host = web.preview.customEnvironment ?? web.preview.branch;
      break;
    case "production":
      host = web.production.alias ?? web.production.url;
      break;
    case "development":
    case undefined:
      return null;
    default: {
      const exhaustive: never = environment;
      return exhaustive;
    }
  }
  return host ? `https://${host}` : null;
}

function normalizeDashboardUrl(candidate: string, setting: string): string {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${setting} must be an absolute HTTP URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${setting} must be an HTTP URL`);
  }
  return `${parsed.origin}/`;
}

/** The dashboard deployment paired with this docs build. */
export function resolveDashboardUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const environment = vercelEnvironmentSchema.parse(env.VERCEL_ENV);
  const configured = env.NEXT_PUBLIC_SDP_WEB_URL?.trim();
  let configuredUrl: string | null = null;
  if (configured) configuredUrl = normalizeDashboardUrl(configured, "NEXT_PUBLIC_SDP_WEB_URL");
  const related = relatedDashboardUrl(env, environment);
  if (related) return normalizeDashboardUrl(related, "VERCEL_RELATED_PROJECTS");
  if (environment === "preview") return null;
  if (configuredUrl) return configuredUrl;
  if (env.NODE_ENV === "production") return `${getSdpDocsOrigin(DEFAULT_SDP_DOCS_URL)}/`;
  return "http://localhost:3000/";
}
