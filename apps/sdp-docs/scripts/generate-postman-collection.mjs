import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openApiPath = path.resolve(__dirname, "../../sdp-api/generated/openapi.json");
const downloadsDir = path.resolve(__dirname, "../public/downloads");
const collectionPath = path.join(downloadsDir, "sdp-api-admin.postman_collection.json");
const manifestPath = path.join(downloadsDir, "sdp-api-admin.postman_manifest.json");
const environmentTemplatePath = path.join(
  downloadsDir,
  "sdp-api-admin.postman_environment.template.json"
);

const DEFAULT_EXTERNAL_ADDRESS = "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ";
const DEFAULT_SECONDARY_ADDRESS = "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv";
const HIDDEN_TAG_SLUGS = new Set([
  "rpc",
  "admin",
  "onboarding",
  "auth",
  "organizations",
  "members",
]);

const JSON_HEADERS = [{ key: "Content-Type", value: "application/json" }];
const AUTH_HEADER = { key: "Authorization", value: "Bearer {{apiKey}}" };

function statusTest(status, ...lines) {
  return [
    `pm.test("Status ${status}", function () { pm.response.to.have.status(${status}); });`,
    ...lines,
  ];
}

function jsonStatusTest(status, ...lines) {
  return statusTest(status, "const body = pm.response.json();", ...lines);
}

function requireVar(name) {
  return `if (!pm.collectionVariables.get("${name}")) { throw new Error("${name} is required before this request."); }`;
}

function request({
  operationId,
  folder,
  name,
  method,
  url,
  body,
  prerequest = [],
  tests = [],
  description,
}) {
  return {
    operationId,
    folder,
    item: {
      name,
      request: {
        method,
        header: body ? [AUTH_HEADER, ...JSON_HEADERS] : [AUTH_HEADER],
        url: `{{baseUrl}}${url}`,
        ...(description ? { description } : {}),
        ...(body
          ? {
              body: {
                mode: "raw",
                raw: body,
                options: {
                  raw: {
                    language: "json",
                  },
                },
              },
            }
          : {}),
      },
      event: [
        ...(prerequest.length > 0
          ? [
              {
                listen: "prerequest",
                script: {
                  type: "text/javascript",
                  exec: prerequest,
                },
              },
            ]
          : []),
        {
          listen: "test",
          script: {
            type: "text/javascript",
            exec: tests,
          },
        },
      ],
    },
  };
}

function nestedFolderTree() {
  return [];
}

function insertItem(root, folderPath, item) {
  let cursor = root;
  for (const segment of folderPath) {
    let folder = cursor.find(
      (candidate) => candidate.name === segment && Array.isArray(candidate.item)
    );
    if (!folder) {
      folder = { name: segment, item: [] };
      cursor.push(folder);
    }
    cursor = folder.item;
  }
  cursor.push(item);
}

function slugTitle(value) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function operationRequestDescription(operation) {
  return operation?.description || operation?.summary || slugTitle(operation?.operationId || "");
}

function buildEnvironmentTemplate() {
  return {
    id: "sdp-api-admin-template",
    name: "SDP Admin API",
    values: [
      {
        key: "baseUrl",
        value: "https://api.solana.com",
        enabled: true,
        type: "default",
      },
      {
        key: "apiKey",
        value: "sk_test_replace_me",
        enabled: true,
        type: "secret",
      },
    ],
    _postman_variable_scope: "environment",
    _postman_exported_at: new Date().toISOString(),
    _postman_exported_using: "Codex",
  };
}

async function loadOpenApi() {
  const raw = await fs.readFile(openApiPath, "utf8");
  return JSON.parse(raw);
}

function apiKeyOperationsFromSpec(spec) {
  const operations = new Map();

  for (const [routePath, pathItem] of Object.entries(spec.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem || {})) {
      if (!operation || typeof operation !== "object") {
        continue;
      }

      const security = operation.security || spec.security || [];
      const usesApiKey = security.some((entry) =>
        Object.prototype.hasOwnProperty.call(entry, "apiKeyAuth")
      );

      if (!usesApiKey || !operation.operationId) {
        continue;
      }

      const primaryTag = Array.isArray(operation.tags) ? operation.tags[0] : null;
      if (primaryTag && HIDDEN_TAG_SLUGS.has(slugify(primaryTag))) {
        continue;
      }

      operations.set(operation.operationId, {
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path: routePath,
        summary: operation.summary || "",
        description: operation.description || "",
      });
    }
  }

  return operations;
}

const excludedOperations = {
  getOrganization:
    "Requires an explicit organization id that cannot be derived from a bare API key in the collection bootstrap flow.",
  updateOrganization:
    "Requires an explicit organization id and mutates shared organization settings, so it is excluded from the CI-safe admin suite.",
  deleteOrganization:
    "Destructive organization deletion is not safe for a recurring required CI suite.",
  listMembers:
    "The Members tag is intentionally hidden from the public docs, so it is excluded from the downloadable Postman suite.",
  inviteMember:
    "The handler requires a Clerk-authenticated human user to send invitations, so a machine API key cannot execute it.",
  removeMember:
    "Organization member removal is excluded from the CI-safe suite because it mutates human membership state.",
  initializeWalletSigning:
    "Initializes org-level custody configuration and is excluded from the recurring suite to avoid provider bootstrap side effects.",
  switchWalletSigningProvider:
    "Switches the org default signing provider and is excluded from the recurring suite to avoid global side effects.",
  createWallet:
    "Wallet provisioning depends on provider capabilities and mutates shared custody state, so it is excluded from the recurring suite.",
  deleteWallet:
    "Wallet deletion mutates shared custody state and is excluded from the recurring suite.",
  setDefaultWallet:
    "Changing the default wallet mutates shared custody state and is excluded from the recurring suite.",
  addProjectMember:
    "Requires an additional organization member user id, which is not derivable from a single admin API key bootstrap flow.",
  updateProjectMember:
    "Requires a mutable project member target and is excluded from the CI-safe suite.",
  removeProjectMember:
    "Requires a mutable project member target and is excluded from the CI-safe suite.",
  listRpcProviders:
    "The RPC tag is intentionally hidden from the public docs, so it is excluded from the downloadable Postman suite.",
  proxyRpcRequest:
    "The RPC tag is intentionally hidden from the public docs, so it is excluded from the downloadable Postman suite.",
  executePaymentOnramp:
    "Depends on external provider availability and hosted third-party ramp services, so it is excluded from the required CI suite.",
  executePaymentOfframp:
    "Depends on external provider availability and hosted third-party ramp services, so it is excluded from the required CI suite.",
  getOnboardingStatus: "Requires a Clerk onboarding session, not an API key.",
  linkOnboardingOrganization: "Requires a Clerk onboarding session, not an API key.",
};

function automatedRequests(operations) {
  const op = (operationId) => operationRequestDescription(operations.get(operationId));

  return [
    request({
      operationId: "listWallets",
      folder: ["Bootstrap"],
      name: "List wallets",
      method: "GET",
      url: "/v1/wallets?includeAllProviders=true",
      description: op("listWallets"),
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.wallets.length, "expected at least one wallet").to.be.greaterThan(0);',
        "const wallet = body.data.wallets[0];",
        'pm.collectionVariables.set("walletId", wallet.walletId);',
        'pm.collectionVariables.set("walletPublicKey", wallet.publicKey);'
      ),
    }),
    request({
      operationId: "listApiKeys",
      folder: ["API Keys"],
      name: "List API keys",
      method: "GET",
      url: "/v1/api-keys",
      description: op("listApiKeys"),
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.apiKeys, "apiKeys array").to.be.an("array");'
      ),
    }),
    request({
      operationId: "createApiKey",
      folder: ["API Keys"],
      name: "Create temporary API key",
      method: "POST",
      url: "/v1/api-keys",
      description: op("createApiKey"),
      prerequest: [requireVar("walletId")],
      body: JSON.stringify(
        {
          name: "Postman temp key {{suiteRunId}}",
          description: "Generated by the Postman admin CI suite",
          role: "api_developer",
          environment: "sandbox",
          walletScope: "selected",
          signingWalletId: "{{walletId}}",
          walletBindings: [{ walletId: "{{walletId}}" }],
        },
        null,
        2
      ),
      tests: jsonStatusTest(
        201,
        "const apiKey = body.data.apiKey;",
        "pm.expect(apiKey.id).to.match(/^key_/);",
        "pm.expect(apiKey.key).to.match(/^sk_test_/);",
        'pm.collectionVariables.set("temporaryApiKeyId", apiKey.id);',
        'pm.collectionVariables.set("temporaryApiKeyName", apiKey.name);'
      ),
    }),
    request({
      operationId: "getApiKey",
      folder: ["API Keys"],
      name: "Get temporary API key",
      method: "GET",
      url: "/v1/api-keys/{{temporaryApiKeyId}}",
      description: op("getApiKey"),
      prerequest: [requireVar("temporaryApiKeyId")],
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.apiKey.id).to.eql(pm.collectionVariables.get("temporaryApiKeyId"));'
      ),
    }),
    request({
      operationId: "updateApiKey",
      folder: ["API Keys"],
      name: "Update temporary API key",
      method: "PATCH",
      url: "/v1/api-keys/{{temporaryApiKeyId}}",
      description: op("updateApiKey"),
      prerequest: [requireVar("temporaryApiKeyId")],
      body: JSON.stringify(
        {
          description: "Updated by the Postman admin CI suite",
        },
        null,
        2
      ),
      tests: jsonStatusTest(200, "pm.expect(body.data.success).to.eql(true);"),
    }),
    request({
      operationId: "rotateApiKey",
      folder: ["API Keys"],
      name: "Rotate temporary API key",
      method: "POST",
      url: "/v1/api-keys/{{temporaryApiKeyId}}/rotate",
      description: op("rotateApiKey"),
      prerequest: [requireVar("temporaryApiKeyId")],
      body: JSON.stringify({ gracePeriodHours: 1 }, null, 2),
      tests: jsonStatusTest(
        201,
        "pm.expect(body.data.apiKey.id).to.match(/^key_/);",
        "pm.expect(body.data.apiKey.key).to.match(/^sk_test_/);"
      ),
    }),
    request({
      operationId: "revokeApiKey",
      folder: ["API Keys"],
      name: "Revoke temporary API key",
      method: "DELETE",
      url: "/v1/api-keys/{{temporaryApiKeyId}}",
      description: op("revokeApiKey"),
      prerequest: [requireVar("temporaryApiKeyId"), requireVar("temporaryApiKeyName")],
      body: JSON.stringify({ confirmation: "{{temporaryApiKeyName}}" }, null, 2),
      tests: jsonStatusTest(200, "pm.expect(body.data.success).to.eql(true);"),
    }),
    request({
      operationId: "getWalletById",
      folder: ["Wallets"],
      name: "Get wallet by id",
      method: "GET",
      url: "/v1/wallets/{{walletId}}",
      description: op("getWalletById"),
      prerequest: [requireVar("walletId")],
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.wallet.walletId).to.eql(pm.collectionVariables.get("walletId"));'
      ),
    }),
    request({
      operationId: "getWalletPublicKey",
      folder: ["Wallets"],
      name: "Get wallet public key",
      method: "GET",
      url: "/v1/wallets/public-key?walletId={{walletId}}",
      description: op("getWalletPublicKey"),
      prerequest: [requireVar("walletId")],
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.publicKey).to.eql(pm.collectionVariables.get("walletPublicKey"));'
      ),
    }),
    request({
      operationId: "getWalletConfig",
      folder: ["Wallets"],
      name: "Get wallet config",
      method: "GET",
      url: "/v1/wallets/config",
      description: op("getWalletConfig"),
      tests: jsonStatusTest(200, "pm.expect(body.data.config || body.data.walletConfig).to.exist;"),
    }),
    request({
      operationId: "listWalletConfigs",
      folder: ["Wallets"],
      name: "List wallet configs",
      method: "GET",
      url: "/v1/wallets/configs",
      description: op("listWalletConfigs"),
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.configs, "configs array").to.be.an("array");'
      ),
    }),
    request({
      operationId: "listSwitchProviderOptions",
      folder: ["Wallets"],
      name: "List switch provider options",
      method: "GET",
      url: "/v1/wallets/switch-options",
      description: op("listSwitchProviderOptions"),
      tests: jsonStatusTest(200, "pm.expect(body.data.options || body.data.providers).to.exist;"),
    }),
    request({
      operationId: "aggregateWalletBalances",
      folder: ["Wallets"],
      name: "Aggregate wallet balances",
      method: "GET",
      url: "/v1/wallets/aggregate?includeAllProviders=true",
      description: op("aggregateWalletBalances"),
      tests: jsonStatusTest(
        200,
        "pm.expect(body.data.aggregate.walletCount).to.be.greaterThan(0);"
      ),
    }),
    request({
      operationId: "checkWalletSigner",
      folder: ["Wallets"],
      name: "Signer check",
      method: "POST",
      url: "/v1/wallets/signer-check",
      description: op("checkWalletSigner"),
      prerequest: [requireVar("walletId")],
      body: JSON.stringify(
        { walletId: "{{walletId}}", memo: "postman signer-check {{suiteRunId}}" },
        null,
        2
      ),
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.walletId).to.eql(pm.collectionVariables.get("walletId"));',
        'pm.expect(body.data.signature).to.be.a("string").and.not.empty;'
      ),
    }),
    request({
      operationId: "createProject",
      folder: ["Projects"],
      name: "Create temporary project",
      method: "POST",
      url: "/v1/projects",
      description: op("createProject"),
      body: JSON.stringify(
        {
          name: "Postman Project {{suiteRunId}}",
          slug: "postman-{{suiteRunId}}",
          description: "Created by the Postman admin CI suite",
          environment: "sandbox",
        },
        null,
        2
      ),
      tests: jsonStatusTest(
        201,
        "const project = body.data.project;",
        "pm.expect(project.id).to.match(/^prj_/);",
        'pm.collectionVariables.set("projectId", project.id);'
      ),
    }),
    request({
      operationId: "listProjects",
      folder: ["Projects"],
      name: "List projects",
      method: "GET",
      url: "/v1/projects",
      description: op("listProjects"),
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.projects, "projects array").to.be.an("array");'
      ),
    }),
    request({
      operationId: "getProject",
      folder: ["Projects"],
      name: "Get temporary project",
      method: "GET",
      url: "/v1/projects/{{projectId}}",
      description: op("getProject"),
      prerequest: [requireVar("projectId")],
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.project.id).to.eql(pm.collectionVariables.get("projectId"));'
      ),
    }),
    request({
      operationId: "updateProject",
      folder: ["Projects"],
      name: "Update temporary project",
      method: "PATCH",
      url: "/v1/projects/{{projectId}}",
      description: op("updateProject"),
      prerequest: [requireVar("projectId")],
      body: JSON.stringify(
        {
          description: "Updated by the Postman admin CI suite",
        },
        null,
        2
      ),
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.project.id).to.eql(pm.collectionVariables.get("projectId"));'
      ),
    }),
    request({
      operationId: "listProjectMembers",
      folder: ["Projects"],
      name: "List project members",
      method: "GET",
      url: "/v1/projects/{{projectId}}/members",
      description: op("listProjectMembers"),
      prerequest: [requireVar("projectId")],
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.members, "members array").to.be.an("array");'
      ),
    }),
    request({
      operationId: "createProjectApiKey",
      folder: ["Projects"],
      name: "Create project API key",
      method: "POST",
      url: "/v1/projects/{{projectId}}/api-keys",
      description: op("createProjectApiKey"),
      prerequest: [requireVar("projectId")],
      body: JSON.stringify(
        {
          name: "Project Key {{suiteRunId}}",
          environment: "sandbox",
          walletScope: "all",
        },
        null,
        2
      ),
      tests: jsonStatusTest(
        201,
        "pm.expect(body.data.apiKey.id).to.match(/^key_/);",
        'pm.collectionVariables.set("projectApiKeyId", body.data.apiKey.id);'
      ),
    }),
    request({
      operationId: "listProjectApiKeys",
      folder: ["Projects"],
      name: "List project API keys",
      method: "GET",
      url: "/v1/projects/{{projectId}}/api-keys",
      description: op("listProjectApiKeys"),
      prerequest: [requireVar("projectId")],
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.apiKeys, "apiKeys array").to.be.an("array");'
      ),
    }),
    request({
      operationId: "archiveProject",
      folder: ["Projects"],
      name: "Archive temporary project",
      method: "DELETE",
      url: "/v1/projects/{{projectId}}",
      description: op("archiveProject"),
      prerequest: [requireVar("projectId")],
      tests: statusTest(204),
    }),
    request({
      operationId: "listTokenTemplates",
      folder: ["Issuance", "CRUD"],
      name: "List token templates",
      method: "GET",
      url: "/v1/issuance/templates",
      description: op("listTokenTemplates"),
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.templates, "templates array").to.be.an("array").and.not.empty;'
      ),
    }),
    request({
      operationId: "getTokenTemplate",
      folder: ["Issuance", "CRUD"],
      name: "Get stablecoin template",
      method: "GET",
      url: "/v1/issuance/templates/stablecoin",
      description: op("getTokenTemplate"),
      tests: jsonStatusTest(200, 'pm.expect(body.data.template.id).to.eql("stablecoin");'),
    }),
    request({
      operationId: "createToken",
      folder: ["Issuance", "CRUD"],
      name: "Create CRUD token",
      method: "POST",
      url: "/v1/issuance/tokens",
      description: op("createToken"),
      body: JSON.stringify(
        {
          name: "Postman CRUD {{suiteRunId}}",
          symbol: "PC{{symbolSuffix}}",
          template: "stablecoin",
          decimals: 6,
          isMintable: true,
          isFreezable: true,
        },
        null,
        2
      ),
      tests: jsonStatusTest(201, 'pm.collectionVariables.set("crudTokenId", body.data.token.id);'),
    }),
    request({
      operationId: "listTokens",
      folder: ["Issuance", "CRUD"],
      name: "List tokens",
      method: "GET",
      url: "/v1/issuance/tokens?page=1&pageSize=20",
      description: op("listTokens"),
      tests: jsonStatusTest(200, 'pm.expect(body.data, "token list").to.be.an("array");'),
    }),
    request({
      operationId: "getToken",
      folder: ["Issuance", "CRUD"],
      name: "Get CRUD token",
      method: "GET",
      url: "/v1/issuance/tokens/{{crudTokenId}}",
      description: op("getToken"),
      prerequest: [requireVar("crudTokenId")],
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.token.id).to.eql(pm.collectionVariables.get("crudTokenId"));'
      ),
    }),
    request({
      operationId: "updateToken",
      folder: ["Issuance", "CRUD"],
      name: "Update CRUD token",
      method: "PATCH",
      url: "/v1/issuance/tokens/{{crudTokenId}}",
      description: op("updateToken"),
      prerequest: [requireVar("crudTokenId")],
      body: JSON.stringify({ description: "Updated by the Postman admin CI suite" }, null, 2),
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.token.id).to.eql(pm.collectionVariables.get("crudTokenId"));'
      ),
    }),
    request({
      operationId: "listTokenAllowlist",
      folder: ["Issuance", "CRUD"],
      name: "List token allowlist",
      method: "GET",
      url: "/v1/issuance/tokens/{{crudTokenId}}/allowlist?page=1&pageSize=10",
      description: op("listTokenAllowlist"),
      prerequest: [requireVar("crudTokenId")],
      tests: jsonStatusTest(200, 'pm.expect(body.data, "allowlist entries").to.be.an("array");'),
    }),
    request({
      operationId: "addTokenAllowlistEntry",
      folder: ["Issuance", "CRUD"],
      name: "Add allowlist entry",
      method: "POST",
      url: "/v1/issuance/tokens/{{crudTokenId}}/allowlist",
      description: op("addTokenAllowlistEntry"),
      prerequest: [requireVar("crudTokenId")],
      body: JSON.stringify(
        { address: "{{externalAddress}}", label: "Postman Allowlist {{suiteRunId}}" },
        null,
        2
      ),
      tests: jsonStatusTest(
        201,
        'pm.collectionVariables.set("crudAllowlistEntryId", body.data.entry.id);'
      ),
    }),
    request({
      operationId: "listTokenAllowlist",
      folder: ["Issuance", "CRUD"],
      name: "List token allowlist after insert",
      method: "GET",
      url: "/v1/issuance/tokens/{{crudTokenId}}/allowlist?page=1&pageSize=10",
      description: op("listTokenAllowlist"),
      prerequest: [requireVar("crudTokenId")],
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.some((entry) => entry.id === pm.collectionVariables.get("crudAllowlistEntryId"))).to.eql(true);'
      ),
    }),
    request({
      operationId: "removeTokenAllowlistEntry",
      folder: ["Issuance", "CRUD"],
      name: "Remove allowlist entry",
      method: "DELETE",
      url: "/v1/issuance/tokens/{{crudTokenId}}/allowlist/{{crudAllowlistEntryId}}",
      description: op("removeTokenAllowlistEntry"),
      prerequest: [requireVar("crudTokenId"), requireVar("crudAllowlistEntryId")],
      tests: statusTest(204),
    }),
    request({
      operationId: "createToken",
      folder: ["Issuance", "Prepare"],
      name: "Create prepare token",
      method: "POST",
      url: "/v1/issuance/tokens",
      description: op("createToken"),
      body: JSON.stringify(
        {
          name: "Postman Prepare {{suiteRunId}}",
          symbol: "PP{{symbolSuffix}}",
          template: "stablecoin",
          decimals: 6,
          isMintable: true,
          isFreezable: true,
        },
        null,
        2
      ),
      tests: jsonStatusTest(
        201,
        'pm.collectionVariables.set("prepareTokenId", body.data.token.id);'
      ),
    }),
    request({
      operationId: "prepareDeployToken",
      folder: ["Issuance", "Prepare"],
      name: "Prepare deploy token",
      method: "POST",
      url: "/v1/issuance/tokens/{{prepareTokenId}}/deploy/prepare",
      description: op("prepareDeployToken"),
      prerequest: [requireVar("prepareTokenId")],
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.transaction.serialized).to.be.a("string").and.not.empty;'
      ),
    }),
    request({
      operationId: "deployToken",
      folder: ["Issuance", "Prepare"],
      name: "Deploy prepare token",
      method: "POST",
      url: "/v1/issuance/tokens/{{prepareTokenId}}/deploy",
      description: op("deployToken"),
      prerequest: [requireVar("prepareTokenId")],
      tests: jsonStatusTest(
        200,
        'pm.collectionVariables.set("prepareMintAddress", body.data.token.mintAddress);'
      ),
    }),
    request({
      operationId: "prepareMint",
      folder: ["Issuance", "Prepare"],
      name: "Prepare mint",
      method: "POST",
      url: "/v1/issuance/tokens/{{prepareTokenId}}/mint/prepare",
      description: op("prepareMint"),
      prerequest: [requireVar("prepareTokenId")],
      body: JSON.stringify(
        {
          mint: { destination: "{{externalAddress}}", amount: "1" },
          options: { simulate: true },
        },
        null,
        2
      ),
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.preparedTransaction.serialized).to.be.a("string").and.not.empty;'
      ),
    }),
    request({
      operationId: "executeMint",
      folder: ["Issuance", "Prepare"],
      name: "Mint to external address",
      method: "POST",
      url: "/v1/issuance/tokens/{{prepareTokenId}}/mint",
      description: op("executeMint"),
      prerequest: [requireVar("prepareTokenId")],
      body: JSON.stringify({ mint: { destination: "{{externalAddress}}", amount: "3" } }, null, 2),
      tests: jsonStatusTest(
        200,
        'pm.collectionVariables.set("prepareSourceTokenAccount", body.data.tokenAccount);'
      ),
    }),
    request({
      operationId: "executeMint",
      folder: ["Issuance", "Prepare"],
      name: "Mint to secondary address",
      method: "POST",
      url: "/v1/issuance/tokens/{{prepareTokenId}}/mint",
      description: op("executeMint"),
      prerequest: [requireVar("prepareTokenId")],
      body: JSON.stringify({ mint: { destination: "{{secondaryAddress}}", amount: "1" } }, null, 2),
      tests: jsonStatusTest(
        200,
        'pm.collectionVariables.set("prepareDestinationTokenAccount", body.data.tokenAccount);'
      ),
    }),
    request({
      operationId: "executeMint",
      folder: ["Issuance", "Prepare"],
      name: "Mint to custody wallet",
      method: "POST",
      url: "/v1/issuance/tokens/{{prepareTokenId}}/mint",
      description: op("executeMint"),
      prerequest: [requireVar("prepareTokenId"), requireVar("walletPublicKey")],
      body: JSON.stringify({ mint: { destination: "{{walletPublicKey}}", amount: "1" } }, null, 2),
      tests: jsonStatusTest(
        200,
        'pm.collectionVariables.set("prepareCustodyTokenAccount", body.data.tokenAccount);'
      ),
    }),
    request({
      operationId: "prepareBurn",
      folder: ["Issuance", "Prepare"],
      name: "Prepare burn",
      method: "POST",
      url: "/v1/issuance/tokens/{{prepareTokenId}}/burn/prepare",
      description: op("prepareBurn"),
      prerequest: [requireVar("prepareTokenId"), requireVar("walletPublicKey")],
      body: JSON.stringify({ burn: { source: "{{walletPublicKey}}", amount: "1" } }, null, 2),
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.preparedTransaction.serialized).to.be.a("string").and.not.empty;'
      ),
    }),
    request({
      operationId: "prepareSeize",
      folder: ["Issuance", "Prepare"],
      name: "Prepare seize",
      method: "POST",
      url: "/v1/issuance/tokens/{{prepareTokenId}}/seize/prepare",
      description: op("prepareSeize"),
      prerequest: [
        requireVar("prepareTokenId"),
        requireVar("prepareSourceTokenAccount"),
        requireVar("prepareDestinationTokenAccount"),
      ],
      body: JSON.stringify(
        {
          seize: {
            source: "{{prepareSourceTokenAccount}}",
            destination: "{{prepareDestinationTokenAccount}}",
            amount: "1",
          },
        },
        null,
        2
      ),
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.preparedTransaction.serialized).to.be.a("string").and.not.empty;'
      ),
    }),
    request({
      operationId: "prepareForceBurn",
      folder: ["Issuance", "Prepare"],
      name: "Prepare force burn",
      method: "POST",
      url: "/v1/issuance/tokens/{{prepareTokenId}}/force-burn/prepare",
      description: op("prepareForceBurn"),
      prerequest: [requireVar("prepareTokenId"), requireVar("prepareDestinationTokenAccount")],
      body: JSON.stringify(
        { forceBurn: { source: "{{prepareDestinationTokenAccount}}", amount: "1" } },
        null,
        2
      ),
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.preparedTransaction.serialized).to.be.a("string").and.not.empty;'
      ),
    }),
    request({
      operationId: "prepareUpdateAuthority",
      folder: ["Issuance", "Prepare"],
      name: "Prepare authority update",
      method: "POST",
      url: "/v1/issuance/tokens/{{prepareTokenId}}/authority/prepare",
      description: op("prepareUpdateAuthority"),
      prerequest: [requireVar("prepareTokenId")],
      body: JSON.stringify(
        { authority: { role: "mint", newAuthority: "{{secondaryAddress}}" } },
        null,
        2
      ),
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.preparedTransaction.serialized).to.be.a("string").and.not.empty;'
      ),
    }),
    request({
      operationId: "listTokenTransactions",
      folder: ["Issuance", "Prepare"],
      name: "List pending token transactions",
      method: "GET",
      url: "/v1/issuance/tokens/{{prepareTokenId}}/transactions?status=pending&page=1&pageSize=20",
      description: op("listTokenTransactions"),
      prerequest: [requireVar("prepareTokenId")],
      tests: jsonStatusTest(200, 'pm.expect(body.data, "transactions array").to.be.an("array");'),
    }),
    request({
      operationId: "createToken",
      folder: ["Issuance", "Execute"],
      name: "Create execute token",
      method: "POST",
      url: "/v1/issuance/tokens",
      description: op("createToken"),
      body: JSON.stringify(
        {
          name: "Postman Execute {{suiteRunId}}",
          symbol: "PE{{symbolSuffix}}",
          template: "stablecoin",
          decimals: 6,
          isMintable: true,
          isFreezable: true,
        },
        null,
        2
      ),
      tests: jsonStatusTest(
        201,
        'pm.collectionVariables.set("executeTokenId", body.data.token.id);'
      ),
    }),
    request({
      operationId: "deployToken",
      folder: ["Issuance", "Execute"],
      name: "Deploy execute token",
      method: "POST",
      url: "/v1/issuance/tokens/{{executeTokenId}}/deploy",
      description: op("deployToken"),
      prerequest: [requireVar("executeTokenId")],
      tests: jsonStatusTest(200, 'pm.expect(body.data.token.status).to.eql("active");'),
    }),
    request({
      operationId: "executeMint",
      folder: ["Issuance", "Execute"],
      name: "Mint execute source account",
      method: "POST",
      url: "/v1/issuance/tokens/{{executeTokenId}}/mint",
      description: op("executeMint"),
      prerequest: [requireVar("executeTokenId")],
      body: JSON.stringify({ mint: { destination: "{{externalAddress}}", amount: "4" } }, null, 2),
      tests: jsonStatusTest(
        200,
        'pm.collectionVariables.set("executeSourceTokenAccount", body.data.tokenAccount);'
      ),
    }),
    request({
      operationId: "executeMint",
      folder: ["Issuance", "Execute"],
      name: "Mint execute destination account",
      method: "POST",
      url: "/v1/issuance/tokens/{{executeTokenId}}/mint",
      description: op("executeMint"),
      prerequest: [requireVar("executeTokenId")],
      body: JSON.stringify({ mint: { destination: "{{secondaryAddress}}", amount: "1" } }, null, 2),
      tests: jsonStatusTest(
        200,
        'pm.collectionVariables.set("executeDestinationTokenAccount", body.data.tokenAccount);'
      ),
    }),
    request({
      operationId: "executeMint",
      folder: ["Issuance", "Execute"],
      name: "Mint execute custody account",
      method: "POST",
      url: "/v1/issuance/tokens/{{executeTokenId}}/mint",
      description: op("executeMint"),
      prerequest: [requireVar("executeTokenId"), requireVar("walletPublicKey")],
      body: JSON.stringify({ mint: { destination: "{{walletPublicKey}}", amount: "1" } }, null, 2),
      tests: jsonStatusTest(
        200,
        'pm.collectionVariables.set("executeCustodyTokenAccount", body.data.tokenAccount);'
      ),
    }),
    request({
      operationId: "pauseToken",
      folder: ["Issuance", "Execute"],
      name: "Pause token",
      method: "POST",
      url: "/v1/issuance/tokens/{{executeTokenId}}/pause",
      description: op("pauseToken"),
      prerequest: [requireVar("executeTokenId")],
      body: JSON.stringify({}, null, 2),
      tests: jsonStatusTest(200, 'pm.expect(body.data.transaction.type).to.eql("pause");'),
    }),
    request({
      operationId: "getToken",
      folder: ["Issuance", "Execute"],
      name: "Get paused token",
      method: "GET",
      url: "/v1/issuance/tokens/{{executeTokenId}}",
      description: op("getToken"),
      prerequest: [requireVar("executeTokenId")],
      tests: jsonStatusTest(200, 'pm.expect(body.data.token.status).to.eql("paused");'),
    }),
    request({
      operationId: "unpauseToken",
      folder: ["Issuance", "Execute"],
      name: "Unpause token",
      method: "POST",
      url: "/v1/issuance/tokens/{{executeTokenId}}/unpause",
      description: op("unpauseToken"),
      prerequest: [requireVar("executeTokenId")],
      body: JSON.stringify({}, null, 2),
      tests: jsonStatusTest(200, 'pm.expect(body.data.transaction.type).to.eql("unpause");'),
    }),
    request({
      operationId: "freezeAccount",
      folder: ["Issuance", "Execute"],
      name: "Freeze token account",
      method: "POST",
      url: "/v1/issuance/tokens/{{executeTokenId}}/freeze",
      description: op("freezeAccount"),
      prerequest: [requireVar("executeTokenId"), requireVar("executeSourceTokenAccount")],
      body: JSON.stringify(
        {
          accountAddress: "{{executeSourceTokenAccount}}",
          reason: "Postman freeze {{suiteRunId}}",
        },
        null,
        2
      ),
      tests: jsonStatusTest(
        201,
        'pm.expect(body.data.frozenAccount.accountAddress).to.eql(pm.collectionVariables.get("executeSourceTokenAccount"));'
      ),
    }),
    request({
      operationId: "listFrozenAccounts",
      folder: ["Issuance", "Execute"],
      name: "List frozen accounts",
      method: "GET",
      url: "/v1/issuance/tokens/{{executeTokenId}}/frozen?page=1&pageSize=10",
      description: op("listFrozenAccounts"),
      prerequest: [requireVar("executeTokenId"), requireVar("executeSourceTokenAccount")],
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.some((entry) => entry.accountAddress === pm.collectionVariables.get("executeSourceTokenAccount"))).to.eql(true);'
      ),
    }),
    request({
      operationId: "unfreezeAccount",
      folder: ["Issuance", "Execute"],
      name: "Unfreeze token account",
      method: "POST",
      url: "/v1/issuance/tokens/{{executeTokenId}}/unfreeze",
      description: op("unfreezeAccount"),
      prerequest: [requireVar("executeTokenId"), requireVar("executeSourceTokenAccount")],
      body: JSON.stringify({ accountAddress: "{{executeSourceTokenAccount}}" }, null, 2),
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.frozenAccount.accountAddress).to.eql(pm.collectionVariables.get("executeSourceTokenAccount"));'
      ),
    }),
    request({
      operationId: "executeBurn",
      folder: ["Issuance", "Execute"],
      name: "Burn tokens",
      method: "POST",
      url: "/v1/issuance/tokens/{{executeTokenId}}/burn",
      description: op("executeBurn"),
      prerequest: [requireVar("executeTokenId"), requireVar("walletPublicKey")],
      body: JSON.stringify({ burn: { source: "{{walletPublicKey}}", amount: "1" } }, null, 2),
      tests: jsonStatusTest(200, 'pm.expect(body.data.transaction.type).to.eql("burn");'),
    }),
    request({
      operationId: "executeSeize",
      folder: ["Issuance", "Execute"],
      name: "Seize tokens",
      method: "POST",
      url: "/v1/issuance/tokens/{{executeTokenId}}/seize",
      description: op("executeSeize"),
      prerequest: [
        requireVar("executeTokenId"),
        requireVar("executeSourceTokenAccount"),
        requireVar("executeDestinationTokenAccount"),
      ],
      body: JSON.stringify(
        {
          seize: {
            source: "{{executeSourceTokenAccount}}",
            destination: "{{executeDestinationTokenAccount}}",
            amount: "2",
          },
        },
        null,
        2
      ),
      tests: jsonStatusTest(200, 'pm.expect(body.data.transaction.type).to.eql("seize");'),
    }),
    request({
      operationId: "executeForceBurn",
      folder: ["Issuance", "Execute"],
      name: "Force burn tokens",
      method: "POST",
      url: "/v1/issuance/tokens/{{executeTokenId}}/force-burn",
      description: op("executeForceBurn"),
      prerequest: [requireVar("executeTokenId"), requireVar("executeDestinationTokenAccount")],
      body: JSON.stringify(
        { forceBurn: { source: "{{executeDestinationTokenAccount}}", amount: "1" } },
        null,
        2
      ),
      tests: jsonStatusTest(200, 'pm.expect(body.data.transaction.type).to.eql("force_burn");'),
    }),
    request({
      operationId: "executeUpdateAuthority",
      folder: ["Issuance", "Execute"],
      name: "Update mint authority",
      method: "POST",
      url: "/v1/issuance/tokens/{{executeTokenId}}/authority",
      description: op("executeUpdateAuthority"),
      prerequest: [requireVar("executeTokenId"), requireVar("walletPublicKey")],
      body: JSON.stringify(
        {
          authority: {
            role: "mint",
            currentAuthority: "{{walletPublicKey}}",
            newAuthority: "{{externalAddress}}",
          },
        },
        null,
        2
      ),
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.transaction.type).to.eql("update_authority");'
      ),
    }),
    request({
      operationId: "refreshTokenSupply",
      folder: ["Issuance", "Execute"],
      name: "Refresh token supply",
      method: "POST",
      url: "/v1/issuance/tokens/{{executeTokenId}}/supply/refresh",
      description: op("refreshTokenSupply"),
      prerequest: [requireVar("executeTokenId")],
      tests: jsonStatusTest(200, 'pm.expect(body.data.token.totalSupply).to.be.a("string");'),
    }),
    request({
      operationId: "listTokenTransactions",
      folder: ["Issuance", "Execute"],
      name: "List confirmed token transactions",
      method: "GET",
      url: "/v1/issuance/tokens/{{executeTokenId}}/transactions?status=confirmed&page=1&pageSize=50",
      description: op("listTokenTransactions"),
      prerequest: [requireVar("executeTokenId")],
      tests: jsonStatusTest(200, 'pm.expect(body.data, "transactions array").to.be.an("array");'),
    }),
    request({
      operationId: "screenComplianceAddress",
      folder: ["Compliance"],
      name: "Screen address",
      method: "POST",
      url: "/v1/compliance/address-screenings",
      description: op("screenComplianceAddress"),
      body: JSON.stringify(
        { address: "{{externalAddress}}", network: "solana", intent: "transfer_destination" },
        null,
        2
      ),
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.screening.address).to.eql(pm.collectionVariables.get("externalAddress"));'
      ),
    }),
    request({
      operationId: "getPaymentWalletBalances",
      folder: ["Payments"],
      name: "Get wallet balances",
      method: "GET",
      url: "/v1/payments/wallets/{{walletId}}/balances",
      description: op("getPaymentWalletBalances"),
      prerequest: [requireVar("walletId")],
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.walletBalances.walletId).to.eql(pm.collectionVariables.get("walletId"));'
      ),
    }),
    request({
      operationId: "getPaymentWalletPolicy",
      folder: ["Payments"],
      name: "Get wallet policy",
      method: "GET",
      url: "/v1/payments/wallets/{{walletId}}/policies",
      description: op("getPaymentWalletPolicy"),
      prerequest: [requireVar("walletId")],
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.policy.walletId).to.eql(pm.collectionVariables.get("walletId"));'
      ),
    }),
    request({
      operationId: "updatePaymentWalletPolicy",
      folder: ["Payments"],
      name: "Update wallet policy",
      method: "PUT",
      url: "/v1/payments/wallets/{{walletId}}/policies",
      description: op("updatePaymentWalletPolicy"),
      prerequest: [requireVar("walletId")],
      body: JSON.stringify(
        {
          destinationAllowlist: ["{{externalAddress}}"],
          maxTransferAmount: "0.1",
          maxDailyAmount: "1",
        },
        null,
        2
      ),
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.policy.walletId).to.eql(pm.collectionVariables.get("walletId"));'
      ),
    }),
    request({
      operationId: "preparePaymentTransfer",
      folder: ["Payments"],
      name: "Prepare SOL transfer",
      method: "POST",
      url: "/v1/payments/transfers/prepare",
      description: op("preparePaymentTransfer"),
      prerequest: [requireVar("walletId")],
      body: JSON.stringify(
        {
          source: "{{walletId}}",
          destination: "{{externalAddress}}",
          token: "SOL",
          amount: "0.000001",
        },
        null,
        2
      ),
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.transfer.status).to.eql("pending");',
        'pm.expect(body.data.preparedTransaction.serialized).to.be.a("string").and.not.empty;'
      ),
    }),
    request({
      operationId: "createPaymentTransfer",
      folder: ["Payments"],
      name: "Execute SOL transfer",
      method: "POST",
      url: "/v1/payments/transfers",
      description: op("createPaymentTransfer"),
      prerequest: [requireVar("walletId")],
      body: JSON.stringify(
        {
          source: "{{walletId}}",
          destination: "{{externalAddress}}",
          token: "SOL",
          amount: "0.000001",
        },
        null,
        2
      ),
      tests: jsonStatusTest(
        200,
        "pm.expect(body.data.transfer.id).to.match(/^xfr_/);",
        'pm.collectionVariables.set("paymentTransferId", body.data.transfer.id);'
      ),
    }),
    request({
      operationId: "listPaymentTransfers",
      folder: ["Payments"],
      name: "List wallet transfers",
      method: "GET",
      url: "/v1/payments/transfers?wallet={{walletId}}",
      description: op("listPaymentTransfers"),
      prerequest: [requireVar("walletId")],
      tests: jsonStatusTest(200, 'pm.expect(body.data, "transfers array").to.be.an("array");'),
    }),
    request({
      operationId: "getPaymentTransfer",
      folder: ["Payments"],
      name: "Get executed transfer",
      method: "GET",
      url: "/v1/payments/transfers/{{paymentTransferId}}",
      description: op("getPaymentTransfer"),
      prerequest: [requireVar("paymentTransferId")],
      tests: jsonStatusTest(
        200,
        'pm.expect(body.data.transfer.id).to.eql(pm.collectionVariables.get("paymentTransferId"));'
      ),
    }),
  ];
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function run() {
  const spec = await loadOpenApi();
  const operations = apiKeyOperationsFromSpec(spec);
  const automated = automatedRequests(operations);

  const automatedIds = new Set(automated.map((entry) => entry.operationId));
  const excludedIds = new Set(Object.keys(excludedOperations));
  const visibleExcludedIds = [...excludedIds].filter((operationId) => operations.has(operationId));

  const uncovered = [...operations.keys()].filter(
    (operationId) => !automatedIds.has(operationId) && !excludedIds.has(operationId)
  );
  if (uncovered.length > 0) {
    throw new Error(`Postman suite is missing API-key operations: ${uncovered.join(", ")}`);
  }

  await fs.mkdir(downloadsDir, { recursive: true });

  const items = nestedFolderTree();
  for (const entry of automated) {
    insertItem(items, entry.folder, entry.item);
  }

  const collection = {
    info: {
      name: "Solana Developer Platform - Admin API Key Suite",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      description:
        "Generated admin API key smoke suite for SDP. This collection is CI-safe and exercises every supported machine-usable API-key endpoint while documenting explicit exclusions for session-only or destructive operations.",
    },
    variable: [
      { key: "baseUrl", value: "https://api.solana.com" },
      { key: "apiKey", value: "sk_test_replace_me" },
      { key: "externalAddress", value: DEFAULT_EXTERNAL_ADDRESS },
      { key: "secondaryAddress", value: DEFAULT_SECONDARY_ADDRESS },
    ],
    event: [
      {
        listen: "prerequest",
        script: {
          type: "text/javascript",
          exec: [
            'const existingRunId = pm.collectionVariables.get("suiteRunId");',
            "if (!existingRunId) {",
            '  pm.collectionVariables.set("suiteRunId", String(Date.now()));',
            "}",
            'const runId = pm.collectionVariables.get("suiteRunId");',
            'pm.collectionVariables.set("symbolSuffix", runId.slice(-4));',
            'if (!pm.collectionVariables.get("externalAddress")) {',
            `  pm.collectionVariables.set("externalAddress", "${DEFAULT_EXTERNAL_ADDRESS}");`,
            "}",
            'if (!pm.collectionVariables.get("secondaryAddress")) {',
            `  pm.collectionVariables.set("secondaryAddress", "${DEFAULT_SECONDARY_ADDRESS}");`,
            "}",
          ],
        },
      },
    ],
    item: items,
  };

  const manifest = {
    generatedAt: new Date().toISOString(),
    sourceOpenApi: "apps/sdp-api/generated/openapi.json",
    totals: {
      apiKeyOperations: operations.size,
      coveredOperations: automatedIds.size,
      automatedRequests: automated.length,
      excluded: visibleExcludedIds.length,
    },
    automated: automated.map(({ operationId, folder, item }) => {
      const operation = operations.get(operationId);
      return {
        operationId,
        folder,
        name: item.name,
        method: operation?.method ?? null,
        path: operation?.path ?? null,
      };
    }),
    excluded: visibleExcludedIds.sort().map((operationId) => {
      const operation = operations.get(operationId);
      return {
        operationId,
        reason: excludedOperations[operationId],
        method: operation?.method ?? null,
        path: operation?.path ?? null,
      };
    }),
  };

  await writeJson(collectionPath, collection);
  await writeJson(manifestPath, manifest);
  await writeJson(environmentTemplatePath, buildEnvironmentTemplate());

  console.log(
    `Generated Postman collection with ${automated.length} automated requests covering ${automatedIds.size} visible API-key operations and ${visibleExcludedIds.length} visible exclusions.`
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
