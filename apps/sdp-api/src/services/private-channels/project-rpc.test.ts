import { SANDBOX_DEFAULTS } from "@sdp/private-channels";
import type { SolanaRpc } from "@sdp/rpc/solana";
import * as solanaRpc from "@sdp/rpc/solana";
import { CLUSTER_BY_SDP_ENVIRONMENT } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { type SeededDefaultProjects, seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { loadProjectRpcClient, probeProjectRpcDeployment } from "./project-rpc";

const OTHER_OWNER = "11111111111111111111111111111111";

interface AccountShape {
  executable: boolean;
  owner: string;
}

function rpcWithAccounts(input?: {
  program?: AccountShape | null;
  instance?: AccountShape | null;
  version?: string;
}): SolanaRpc {
  const program =
    input && "program" in input ? input.program : { executable: true, owner: OTHER_OWNER };
  const instance =
    input && "instance" in input
      ? input.instance
      : { executable: false, owner: SANDBOX_DEFAULTS.escrowProgramId };

  return {
    getVersion: () => ({
      send: vi.fn().mockResolvedValue({ "solana-core": input?.version ?? "1.18.4" }),
    }),
    getAccountInfo: (address: { toString(): string }) => ({
      send: vi.fn().mockResolvedValue({
        value: address.toString() === SANDBOX_DEFAULTS.escrowProgramId ? program : instance,
      }),
    }),
  } as unknown as SolanaRpc;
}

const deployment = {
  escrowProgramId: SANDBOX_DEFAULTS.escrowProgramId,
  escrowInstanceAddr: SANDBOX_DEFAULTS.escrowInstanceAddr,
};

describe("probeProjectRpcDeployment", () => {
  it("preserves the legacy connectivity-only probe when no deployment is supplied", async () => {
    const getAccountInfo = vi.fn();
    const rpc = {
      getVersion: () => ({
        send: vi.fn().mockResolvedValue({ "solana-core": "1.18.4" }),
      }),
      getAccountInfo,
    } as unknown as SolanaRpc;

    const result = await probeProjectRpcDeployment(rpc, "devnet");

    expect(result).toMatchObject({ ok: true, version: "1.18.4" });
    expect(getAccountInfo).not.toHaveBeenCalled();
  });

  it("accepts an executable program and an instance owned by it", async () => {
    const result = await probeProjectRpcDeployment(rpcWithAccounts(), "devnet", deployment);

    expect(result).toMatchObject({ ok: true, version: "1.18.4" });
  });

  it("rejects a project RPC where the escrow program is missing", async () => {
    const result = await probeProjectRpcDeployment(
      rpcWithAccounts({ program: null }),
      "devnet",
      deployment
    );

    expect(result).toMatchObject({
      ok: false,
      error: "Escrow program is not deployed on devnet.",
    });
  });

  it("rejects a non-executable escrow program account", async () => {
    const result = await probeProjectRpcDeployment(
      rpcWithAccounts({ program: { executable: false, owner: OTHER_OWNER } }),
      "devnet",
      deployment
    );

    expect(result).toMatchObject({
      ok: false,
      error: "Escrow program is not executable on devnet.",
    });
  });

  it("rejects a project RPC where the escrow instance is missing", async () => {
    const result = await probeProjectRpcDeployment(
      rpcWithAccounts({ instance: null }),
      "devnet",
      deployment
    );

    expect(result).toMatchObject({
      ok: false,
      error: "Escrow instance was not found on devnet.",
    });
  });

  it("rejects an escrow instance owned by another program", async () => {
    const result = await probeProjectRpcDeployment(
      rpcWithAccounts({ instance: { executable: false, owner: OTHER_OWNER } }),
      "mainnet-beta",
      deployment
    );

    expect(result).toMatchObject({
      ok: false,
      error: "Escrow instance is not owned by the configured escrow program on mainnet-beta.",
    });
  });
});

describe("loadProjectRpcClient", () => {
  let projects: SeededDefaultProjects;
  let managedRpc: SolanaRpc;
  let createRpcMock: MockInstance<typeof solanaRpc.createRpc>;

  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await db
      .prepare("INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)")
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare("INSERT INTO users (id, email) VALUES (?, ?)")
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    projects = await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: "prj_project_rpc_sandbox", production: "prj_project_rpc_production" },
    });
    managedRpc = rpcWithAccounts({ program: null });
    createRpcMock = vi.spyOn(solanaRpc, "createRpc").mockReturnValue(managedRpc);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("takes the cluster from the passed environment without reading the project row", async () => {
    const client = await loadProjectRpcClient({
      env,
      organizationId: TEST_ORG.id,
      projectId: "prj_project_rpc_unseeded",
      environment: "production",
    });

    expect(client.cluster).toBe(CLUSTER_BY_SDP_ENVIRONMENT.production);
    expect(client.rpc).toBe(managedRpc);
  });

  it.each(["sandbox", "production"] as const)(
    "reads the cluster from the active %s project row when no environment is passed",
    async (environment) => {
      const client = await loadProjectRpcClient({
        env,
        organizationId: TEST_ORG.id,
        projectId: projects[environment].id,
      });

      expect(client.cluster).toBe(CLUSTER_BY_SDP_ENVIRONMENT[environment]);
    }
  );

  it("builds the client on the managed pool from env and binds the probe to it and the cluster", async () => {
    const client = await loadProjectRpcClient({
      env,
      organizationId: TEST_ORG.id,
      projectId: projects.production.id,
    });

    expect(createRpcMock).toHaveBeenCalledExactlyOnceWith(env);
    await expect(client.probe(deployment)).resolves.toMatchObject({
      ok: false,
      error: `Escrow program is not deployed on ${CLUSTER_BY_SDP_ENVIRONMENT.production}.`,
    });
  });

  it("throws for a project that does not exist", async () => {
    await expect(
      loadProjectRpcClient({
        env,
        organizationId: TEST_ORG.id,
        projectId: "prj_project_rpc_missing",
      })
    ).rejects.toThrow(
      "Active project prj_project_rpc_missing was not found while resolving its RPC"
    );
    expect(createRpcMock).not.toHaveBeenCalled();
  });

  it("throws for a project owned by another organization", async () => {
    await expect(
      loadProjectRpcClient({
        env,
        organizationId: "org_project_rpc_other",
        projectId: projects.sandbox.id,
      })
    ).rejects.toThrow(
      `Active project ${projects.sandbox.id} was not found while resolving its RPC`
    );
  });

  it("throws for an archived project", async () => {
    await getDb(env)
      .prepare("UPDATE projects SET status = 'archived' WHERE id = ?")
      .bind(projects.sandbox.id)
      .run();

    await expect(
      loadProjectRpcClient({
        env,
        organizationId: TEST_ORG.id,
        projectId: projects.sandbox.id,
      })
    ).rejects.toThrow(
      `Active project ${projects.sandbox.id} was not found while resolving its RPC`
    );
    expect(createRpcMock).not.toHaveBeenCalled();
  });
});
