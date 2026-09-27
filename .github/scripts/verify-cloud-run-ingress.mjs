import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const INGRESS_ANNOTATION = "run.googleapis.com/ingress";
// Only this ingress value blocks direct run.app traffic, which otherwise hands
// the service an entirely caller-controlled X-Forwarded-For chain.
const REQUIRED_INGRESS = "internal-and-cloud-load-balancing";
const PROXY_TRUST_ENV = "TRUST_PROXY_HEADERS";
const PROXY_TRUST_VALUE = "true";

/**
 * The runtime resolves client IPs from X-Forwarded-For only after the explicit
 * TRUST_PROXY_HEADERS=true opt-in (client-ip.ts), because K_SERVICE marks the
 * Cloud Run runtime but says nothing about the network path a request took. A
 * deployment that forgets the opt-in silently loses every client address
 * (API-key and organization IP allowlists fail closed; per-IP rate limits
 * collapse into one shared bucket), so the deploy must stop instead of
 * shipping that state.
 */
export function verifyCloudRunIngressTopology(serviceDescription) {
  const ingress = serviceDescription?.metadata?.annotations?.[INGRESS_ANNOTATION];
  if (ingress !== REQUIRED_INGRESS) {
    throw new Error(
      ingress
        ? `Cloud Run service ingress is "${ingress}" but must be "${REQUIRED_INGRESS}", or the default run.app URL serves caller-controlled X-Forwarded-For headers to the API. Update with: gcloud run services update <service> --region <region> --project <project> --ingress ${REQUIRED_INGRESS}`
        : `Cloud Run service ingress is unset (defaults to public run.app traffic) but must be "${REQUIRED_INGRESS}". Update with: gcloud run services update <service> --region <region> --project <project> --ingress ${REQUIRED_INGRESS}`
    );
  }

  const containers = serviceDescription?.spec?.template?.spec?.containers ?? [];
  const trusted = Array.isArray(containers)
    ? containers.some(
        (container) =>
          Array.isArray(container?.env) &&
          container.env.some(
            (entry) => entry?.name === PROXY_TRUST_ENV && entry?.value === PROXY_TRUST_VALUE
          )
      )
    : false;
  if (!trusted) {
    throw new Error(
      `Cloud Run service must define ${PROXY_TRUST_ENV}=${PROXY_TRUST_VALUE} as a plain container environment variable: the runtime trusts X-Forwarded-For only after this explicit opt-in, and without it no client address resolves for IP allowlists or per-IP rate limits.`
    );
  }

  return { ingress, proxyTrustEnv: PROXY_TRUST_ENV };
}

function gcloud(args) {
  return execFileSync("gcloud", args, { encoding: "utf8" }).trim();
}

function main([service, region, project]) {
  if (!service || !region || !project) {
    throw new Error("Usage: verify-cloud-run-ingress.mjs <service> <region> <project>");
  }

  const serviceDescription = JSON.parse(
    gcloud([
      "run",
      "services",
      "describe",
      service,
      "--region",
      region,
      "--project",
      project,
      "--format=json",
    ])
  );

  const topology = verifyCloudRunIngressTopology(serviceDescription);
  console.log(
    `Verified Cloud Run ingress topology for ${service}: ${topology.ingress}, ${topology.proxyTrustEnv}=${PROXY_TRUST_VALUE}`
  );
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
