import { z } from "zod";
import { SDP_ENVIRONMENTS } from "./api-keys";
import { CUSTODY_PROVIDER_CATEGORIES, CUSTODY_PROVIDERS, PROVIDER_MODES } from "./custody";
import { COMPLIANCE_PROVIDERS, RAMP_PROVIDERS } from "./provider-access";
import { MANAGED_RPC_PROVIDERS } from "./rpc";

/** The integration families a project can have, in the order the read returns them. */
export const PROJECT_INTEGRATION_FAMILIES = [
  "custody",
  "rpc",
  "ramps",
  "compliance",
  "private_channels",
] as const;
export type ProjectIntegrationFamily = (typeof PROJECT_INTEGRATION_FAMILIES)[number];

const providerModeSchema = z.enum(PROVIDER_MODES);

export const integrationStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("not_configured"),
    modes: z.tuple([providerModeSchema]).rest(providerModeSchema),
  }),
  z.object({ status: z.literal("provided"), modes: z.array(providerModeSchema) }),
  z.object({ status: z.literal("connected"), mode: providerModeSchema }),
]);
export type IntegrationState = z.infer<typeof integrationStateSchema>;

const custodyIntegrationSchema = z.object({
  provider: z.enum(CUSTODY_PROVIDERS),
  category: z.enum(CUSTODY_PROVIDER_CATEGORIES),
  state: integrationStateSchema,
});

const rpcIntegrationSchema = z.object({
  provider: z.enum(MANAGED_RPC_PROVIDERS).exclude(["default"]),
  state: integrationStateSchema,
});

const rampIntegrationSchema = z.object({
  provider: z.enum(RAMP_PROVIDERS),
  state: integrationStateSchema,
});

const complianceIntegrationSchema = z.object({
  provider: z.enum(COMPLIANCE_PROVIDERS),
  state: integrationStateSchema,
});

const privateChannelsIntegrationSchema = z.object({
  provider: z.literal("private_channels"),
  state: integrationStateSchema,
});

export const integrationFamilySchema = z.discriminatedUnion("family", [
  z.object({
    family: z.literal("custody"),
    integrations: z.array(custodyIntegrationSchema).min(1),
  }),
  z.object({ family: z.literal("rpc"), integrations: z.array(rpcIntegrationSchema).min(1) }),
  z.object({ family: z.literal("ramps"), integrations: z.array(rampIntegrationSchema).min(1) }),
  z.object({
    family: z.literal("compliance"),
    integrations: z.array(complianceIntegrationSchema).min(1),
  }),
  z.object({
    family: z.literal("private_channels"),
    integrations: z.array(privateChannelsIntegrationSchema).min(1),
  }),
]);
export type IntegrationFamily = z.infer<typeof integrationFamilySchema>;
export type CustodyIntegration = z.infer<typeof custodyIntegrationSchema>;
export type RpcIntegration = z.infer<typeof rpcIntegrationSchema>;
export type RampIntegration = z.infer<typeof rampIntegrationSchema>;
export type ComplianceIntegration = z.infer<typeof complianceIntegrationSchema>;
export type PrivateChannelsIntegration = z.infer<typeof privateChannelsIntegrationSchema>;

/**
 * A project's integrations. A family the deployment does not run, or with no
 * provider the project can use, is absent; families follow
 * `PROJECT_INTEGRATION_FAMILIES` order.
 */
export const projectIntegrationsSchema = z.object({
  projectId: z.string(),
  environment: z.enum(SDP_ENVIRONMENTS),
  families: z.array(integrationFamilySchema),
});
export type ProjectIntegrations = z.infer<typeof projectIntegrationsSchema>;
