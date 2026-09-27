import assert from "node:assert/strict";
import test from "node:test";
import { verifyCloudRunIngressTopology } from "../.github/scripts/verify-cloud-run-ingress.mjs";

function serviceDescription({ ingress, trustValue } = {}) {
  return {
    metadata: {
      annotations: ingress ? { "run.googleapis.com/ingress": ingress } : {},
    },
    spec: {
      template: {
        spec: {
          containers: [
            { env: trustValue ? [{ name: "TRUST_PROXY_HEADERS", value: trustValue }] : [] },
          ],
        },
      },
    },
  };
}

test("accepts the load-balancer-only ingress with the explicit proxy-trust opt-in", () => {
  const topology = verifyCloudRunIngressTopology(
    serviceDescription({
      ingress: "internal-and-cloud-load-balancing",
      trustValue: "true",
    })
  );
  assert.equal(topology.ingress, "internal-and-cloud-load-balancing");
});

test("rejects public ingress because the run.app URL serves caller-controlled headers", () => {
  assert.throws(
    () => verifyCloudRunIngressTopology(serviceDescription({ ingress: "all", trustValue: "true" })),
    /ingress is "all" but must be "internal-and-cloud-load-balancing"/
  );
});

test("rejects a missing ingress annotation, which defaults to public traffic", () => {
  assert.throws(
    () => verifyCloudRunIngressTopology(serviceDescription({ trustValue: "true" })),
    /ingress is unset \(defaults to public run\.app traffic\)/
  );
});

test("rejects a deployment that forgets the explicit proxy-trust opt-in", () => {
  assert.throws(
    () =>
      verifyCloudRunIngressTopology(
        serviceDescription({ ingress: "internal-and-cloud-load-balancing" })
      ),
    /must define TRUST_PROXY_HEADERS=true/
  );
});

test("rejects a proxy-trust value the runtime does not treat as opt-in", () => {
  assert.throws(
    () =>
      verifyCloudRunIngressTopology(
        serviceDescription({
          ingress: "internal-and-cloud-load-balancing",
          trustValue: "false",
        })
      ),
    /must define TRUST_PROXY_HEADERS=true/
  );
});

test("rejects a proxy-trust variable set through an unverifiable secret reference", () => {
  const description = serviceDescription({
    ingress: "internal-and-cloud-load-balancing",
  });
  description.spec.template.spec.containers[0].env = [
    { name: "TRUST_PROXY_HEADERS", valueFrom: { secretKeyRef: { name: "s", key: "k" } } },
  ];

  assert.throws(
    () => verifyCloudRunIngressTopology(description),
    /must define TRUST_PROXY_HEADERS=true/
  );
});
