import { parseArgs } from "node:util";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { Project } from "@sdp/types/projects";
import { z } from "zod";
import { closeDatabasePools, type DatabaseClient, getDb } from "@/db/client";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import {
  type SponsorshipBudgetPolicy,
  SponsorshipBudgetRepository,
} from "@/db/repositories/sponsorship-budget.repository";
import { getProcessEnv } from "@/lib/runtime-env";
import { closeAllRedisClients } from "@/runtime/kv-redis";
import { SponsorshipBudgetRedis } from "@/runtime/sponsorship-budget-redis";
import {
  isPolicyControlInSync,
  parseSponsorshipBudgetCommand,
  type SponsorshipBudgetCommand,
} from "@/scripts/lib/sponsorship-budget-operator";
import { ProjectService } from "@/services/project.service";

const FLAG_NAMES = [
  "environment",
  "mode",
  "organization-id",
  "per-tx-lamports",
  "hourly-lamports",
  "daily-lamports",
  "enabled",
  "expected-version",
  "operator",
  "reason",
] as const;

const organizationRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: z.string(),
});

type OrganizationSummary = z.infer<typeof organizationRowSchema>;

interface ProjectSummary {
  id: string;
  environment: string;
  status: string;
}

type PolicyTarget =
  | { scopeType: "global"; environment: SdpEnvironment; organization: null; project: null }
  | {
      scopeType: "project";
      environment: SdpEnvironment;
      organization: OrganizationSummary;
      project: ProjectSummary;
    };

interface ProposedPolicy {
  enabled: boolean;
  perTransactionLamports: number | null;
  hourlyLamports: number | null;
  dailyLamports: number | null;
}

interface PolicyChangePlan {
  command: Exclude<SponsorshipBudgetCommand["command"], "status">;
  mode: "preview" | "apply";
  operator: string;
  reason: string;
  target: PolicyTarget;
  current: SponsorshipBudgetPolicy | null;
  proposed: ProposedPolicy;
  expectedVersion: number | null;
  currentVersion: number;
  result: SponsorshipBudgetPolicy | null;
}

type SponsorshipPolicyStatus = SponsorshipBudgetPolicy & {
  organization: OrganizationSummary | null;
  project: ProjectSummary | null;
  redisControl: { version: number; enabled: boolean } | null;
  inSync: boolean;
};

/**
 * Read the positional command and every `--flag value` pair, refusing unknown flags.
 *
 * @returns The command and the flags that were given.
 */
function readCommandLine(): { command: string | undefined; flags: Record<string, string> } {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: Object.fromEntries(FLAG_NAMES.map((name) => [name, { type: "string" as const }])),
  });
  if (positionals.length > 1) {
    throw new Error(`Expected one command, got: ${positionals.join(" ")}`);
  }
  const flags: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) flags[name] = value;
  }
  return { command: positionals[0], flags };
}

/**
 * Read the organization an operator named, so every change prints who it caps.
 *
 * @param db - The database client.
 * @param organizationId - The organization id.
 * @returns The organization's id, name, slug and status, or null when no such organization exists.
 */
async function getOrganizationSummary(
  db: DatabaseClient,
  organizationId: string
): Promise<OrganizationSummary | null> {
  const row = await db
    .prepare("SELECT id, name, slug, status FROM organizations WHERE id = ?")
    .bind(organizationId)
    .first();
  return row === null ? null : organizationRowSchema.parse(row);
}

/**
 * Summarize a project for output.
 *
 * @param project - The project.
 * @returns Its id, environment and status.
 */
function projectSummary(project: Project): ProjectSummary {
  return { id: project.id, environment: project.environment, status: project.status };
}

/**
 * Mirror a committed policy into Redis. Admission reads `enabled` from Postgres
 * and re-syncs every policy it resolves, so a failed sync here leaves the
 * committed change in force; the operator re-runs `status` to confirm.
 *
 * @param redis - The budget's Redis store.
 * @param policy - The policy just committed.
 * @returns The committed policy.
 */
async function syncCommitted(
  redis: SponsorshipBudgetRedis,
  policy: SponsorshipBudgetPolicy
): Promise<SponsorshipBudgetPolicy> {
  try {
    await redis.syncPolicy(policy);
  } catch (error) {
    throw new Error(
      `Policy ${policy.id} is committed at version ${policy.version}, but the Redis sync failed; run status to confirm`,
      { cause: error }
    );
  }
  return policy;
}

/**
 * Read the policy a target names as it stands now.
 *
 * @param repository - The budget repository.
 * @param target - The environment row or the project row.
 * @returns The policy, or null when it does not exist.
 */
async function currentPolicy(
  repository: SponsorshipBudgetRepository,
  target: PolicyTarget
): Promise<SponsorshipBudgetPolicy | null> {
  return target.scopeType === "global"
    ? repository.getGlobalPolicy(target.environment)
    : repository.getProjectPolicy({
        environment: target.environment,
        projectId: target.project.id,
      });
}

/**
 * Describe a policy's version for a refusal message.
 *
 * @param policy - The policy as it stands, or null when it does not exist.
 * @returns A one-line description of its version and last change.
 */
function describeVersion(policy: SponsorshipBudgetPolicy | null): string {
  return policy === null
    ? "no policy (version 0)"
    : `version ${policy.version} (enabled=${policy.enabled}, last changed by ${policy.updatedBy}: ${policy.updateReason})`;
}

/**
 * Resolve where a write lands: the organization and its active project in the
 * environment for `set-project`, or the global row otherwise.
 *
 * @param db - The database client.
 * @param projects - The project service.
 * @param command - The write command.
 * @returns The target scope with the organization and project it names.
 */
async function resolveTarget(
  db: DatabaseClient,
  projects: ProjectService,
  command: Exclude<SponsorshipBudgetCommand, { command: "status" }>
): Promise<PolicyTarget> {
  switch (command.command) {
    case "set-project": {
      const organization = await getOrganizationSummary(db, command.organizationId);
      if (!organization) throw new Error(`Organization ${command.organizationId} does not exist`);
      const project = (await projects.listProjects(command.organizationId)).find(
        (candidate) => candidate.environment === command.environment
      );
      if (!project) {
        throw new Error(
          `Organization ${organization.name} (${organization.id}) has no active ${command.environment} project`
        );
      }
      return {
        environment: command.environment,
        scopeType: "project",
        organization,
        project: projectSummary(project),
      };
    }
    case "set-global":
    case "kill":
    case "resume":
      return {
        environment: command.environment,
        scopeType: "global",
        organization: null,
        project: null,
      };
    default: {
      const unreachable: never = command;
      throw new Error(`Unknown sponsorship budget command: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The policy a command proposes for its target.
 *
 * @param command - The write command.
 * @param current - The target policy as it stands, or null when it does not exist.
 * @returns The enabled flag and limits the command would write.
 */
function proposedPolicy(
  command: Exclude<SponsorshipBudgetCommand, { command: "status" }>,
  current: SponsorshipBudgetPolicy | null
): ProposedPolicy {
  switch (command.command) {
    case "set-project":
    case "set-global":
      return {
        enabled: command.enabled,
        perTransactionLamports: command.perTransactionLamports,
        hourlyLamports: command.hourlyLamports,
        dailyLamports: command.dailyLamports,
      };
    case "kill":
    case "resume":
      return {
        enabled: command.command === "resume",
        perTransactionLamports: current === null ? null : current.perTransactionLamports,
        hourlyLamports: current === null ? null : current.hourlyLamports,
        dailyLamports: current === null ? null : current.dailyLamports,
      };
    default: {
      const unreachable: never = command;
      throw new Error(`Unknown sponsorship budget command: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Apply a planned change. Every write except `kill` is a compare-and-set on the
 * version the operator read; `kill` stamps the operator over any disable so the
 * breaker's auto-recovery never undoes it.
 *
 * @param repository - The budget repository.
 * @param redis - The budget's Redis store.
 * @param command - The write command.
 * @param target - Where the write lands.
 * @returns The policy as written, or the unchanged policy when a kill found it already killed.
 */
async function applyChange(
  repository: SponsorshipBudgetRepository,
  redis: SponsorshipBudgetRedis,
  command: Extract<SponsorshipBudgetCommand, { mode: "apply" }>,
  target: PolicyTarget
): Promise<SponsorshipBudgetPolicy> {
  switch (command.command) {
    case "set-project":
    case "set-global": {
      const policy =
        target.scopeType === "project"
          ? await repository.writeProjectPolicyAtVersion({
              ...command,
              projectId: target.project.id,
            })
          : await repository.writeGlobalPolicyAtVersion(command);
      if (!policy) {
        throw new Error(
          `Refused: expected version ${command.expectedVersion}, found ${describeVersion(await currentPolicy(repository, target))}. Run status and retry.`
        );
      }
      return syncCommitted(redis, policy);
    }
    case "kill": {
      const policy = await repository.setGlobalPolicyEnabled({
        environment: command.environment,
        enabled: false,
        operator: command.operator,
        reason: command.reason,
      });
      if (policy) return syncCommitted(redis, policy);
      const current = await repository.getGlobalPolicy(command.environment);
      if (!current) throw new Error(`No global ${command.environment} policy exists`);
      return current;
    }
    case "resume": {
      const policy = await repository.resumeGlobalPolicyAtVersion(command);
      if (!policy) {
        const current = await repository.getGlobalPolicy(command.environment);
        throw new Error(
          `Refused: resume expected a disabled global policy at version ${command.expectedVersion}, found ${describeVersion(current)}. Run status and retry.`
        );
      }
      return syncCommitted(redis, policy);
    }
    default: {
      const unreachable: never = command;
      throw new Error(`Unknown sponsorship budget command: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Plan a write, and apply it when the mode is `apply`. A preview refuses a
 * stale expected version too, so an approver is never asked to approve a run
 * that would be refused.
 *
 * @param db - The database client.
 * @param repository - The budget repository.
 * @param redis - The budget's Redis store.
 * @param command - The write command.
 * @returns The plan, with the written policy when applied.
 */
async function planAndApply(
  db: DatabaseClient,
  repository: SponsorshipBudgetRepository,
  redis: SponsorshipBudgetRedis,
  command: Exclude<SponsorshipBudgetCommand, { command: "status" }>
): Promise<PolicyChangePlan> {
  const target = await resolveTarget(db, new ProjectService(db), command);
  const current = await currentPolicy(repository, target);
  const expectedVersion = command.command === "kill" ? null : command.expectedVersion;
  if (expectedVersion !== null && (current === null ? 0 : current.version) !== expectedVersion) {
    throw new Error(
      `Refused: expected version ${expectedVersion}, found ${describeVersion(current)}. Run status and retry.`
    );
  }
  const plan: PolicyChangePlan = {
    command: command.command,
    mode: command.mode,
    operator: command.operator,
    reason: command.reason,
    target,
    current,
    proposed: proposedPolicy(command, current),
    expectedVersion,
    currentVersion: current === null ? 0 : current.version,
    result: null,
  };
  if (command.mode === "preview") return plan;
  return { ...plan, result: await applyChange(repository, redis, command, target) };
}

/**
 * List an environment's policies with the organization and project each override
 * caps. Each policy is first mirrored into Redis (forward-only by version, as
 * admission does), so `inSync` false means Redis holds a newer version than
 * Postgres, never merely a row no sponsorship has touched yet.
 *
 * @param db - The database client.
 * @param repository - The budget repository.
 * @param redis - The budget's Redis store.
 * @param environment - The SDP environment.
 * @returns Every policy on the environment, global first.
 */
async function status(
  db: DatabaseClient,
  repository: SponsorshipBudgetRepository,
  redis: SponsorshipBudgetRedis,
  environment: SdpEnvironment
): Promise<SponsorshipPolicyStatus[]> {
  const projects = new ProjectService(db);
  return Promise.all(
    (await repository.listPolicies(environment)).map(
      async (policy): Promise<SponsorshipPolicyStatus> => {
        await redis.syncPolicy(policy);
        const control = await redis.getPolicyControl(policy);
        const project =
          policy.scopeType === "global" ? null : await projects.getProject(policy.projectId);
        return {
          ...policy,
          organization:
            project === null ? null : await getOrganizationSummary(db, project.organizationId),
          project: project === null ? null : projectSummary(project),
          redisControl: control,
          inSync: isPolicyControlInSync(policy, control),
        };
      }
    )
  );
}

/** Output is one JSON line on stdout, so a Cloud Run execution logs it as one entry. */
runWithSystemDatabaseIdentity("script:sponsorship-budget", async () => {
  const command = parseSponsorshipBudgetCommand(readCommandLine());
  const env = getProcessEnv();
  const db = getDb(env);
  const repository = new SponsorshipBudgetRepository(db);
  const redis = new SponsorshipBudgetRedis(env);
  if (command.command === "status") {
    const policies = await status(db, repository, redis, command.environment);
    const projectsWithoutPolicy = await repository.listProjectsWithoutPolicy(command.environment);
    console.log(JSON.stringify({ policies, projectsWithoutPolicy }));
    if (projectsWithoutPolicy.length > 0 || policies.some((policy) => !policy.inSync)) {
      process.exitCode = 2;
    }
    return;
  }
  console.log(JSON.stringify(await planAndApply(db, repository, redis, command)));
})
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    if (error instanceof Error && error.cause instanceof Error) {
      console.error(`Caused by: ${error.cause.message}`);
    }
    process.exitCode = 1;
  })
  .finally(() => Promise.all([closeDatabasePools(), closeAllRedisClients()]));
