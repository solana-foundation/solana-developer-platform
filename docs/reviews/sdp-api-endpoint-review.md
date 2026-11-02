# SDP stable API — endpoint review

Internal working document · November 2, 2026 · source branch `codex/api-endpoint-review` at `5ea058a90` · pre-review baseline `1566aeffa`

**118 stable-channel endpoints · 0 good · 0 needs work · 118 pending**

This branch retains the original review branch’s changes only for routes supported in the stable release channel. Eligibility comes from the current route owners and module/provider maturity declarations. Core routes are included. Fireblocks-only helpers are excluded because Fireblocks is beta. Stable wallet routes remain available through Privy.

SDP does not custody wallets. Endpoint descriptions identify whether the caller signs or SDP requests signing through the connected provider.

## Retained endpoint naming changes

**22 route renames retained; 94 non-stable route renames omitted.** Every excluded route and its internal OpenAPI operation are restored to the pre-review baseline. Request/response shapes, action grants, middleware, and release-channel boundaries are unchanged. New URLs require matching client updates.

| Method   | Previous path                                                                | Retained path                                                                          | Owner                |
| -------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------- |
| `DELETE` | `/admin/allowlist/{id}`                                                      | `/admin/onboarding-allowlist/{id}`                                                     | `core`               |
| `GET`    | `/admin/allowlist`                                                           | `/admin/onboarding-allowlist`                                                          | `core`               |
| `GET`    | `/internal/dashboard/custody/connections/{connectionId}/provider-credential` | `/internal/dashboard/custody/connections/{connectionId}/provider-credential/lifecycle` | `custody`            |
| `GET`    | `/v1/counterparties/metadata`                                                | `/v1/counterparties/field-options`                                                     | `payments`           |
| `GET`    | `/v1/organizations/{orgId}/provider-access`                                  | `/v1/organizations/{orgId}/provider-availability`                                      | `core`               |
| `GET`    | `/v1/payments/requests/{paymentRequestId}/link`                              | `/v1/payments/requests/{paymentRequestId}/link-token`                                  | `payments`           |
| `GET`    | `/v1/wallets/aggregate`                                                      | `/v1/wallets/balances/aggregate`                                                       | `custody`            |
| `GET`    | `/v1/wallets/configs`                                                        | `/v1/wallets/managed-signing/configurations`                                           | `custody`            |
| `POST`   | `/admin/allowlist`                                                           | `/admin/onboarding-allowlist`                                                          | `core`               |
| `POST`   | `/internal/dashboard/custody/connections/{connectionId}/cancel`              | `/internal/dashboard/custody/connections/{connectionId}/cancel-installation`           | `custody`            |
| `POST`   | `/internal/dashboard/custody/connections/{connectionId}/complete`            | `/internal/dashboard/custody/connections/{connectionId}/complete-installation`         | `custody`            |
| `POST`   | `/internal/dashboard/custody/provider-credentials/{credentialId}/rollback`   | `/internal/dashboard/custody/provider-credentials/{credentialId}/rollback-rotation`    | `custody`            |
| `POST`   | `/v1/members/invite`                                                         | `/v1/members/invitations`                                                              | `core`               |
| `POST`   | `/v1/payments/subscription-plans/{planId}/prepare-create`                    | `/v1/payments/subscription-plans/{planId}/create/build-unsigned-transaction`           | `recurring_payments` |
| `POST`   | `/v1/payments/subscriptions/{subscriptionId}/prepare-authorization`          | `/v1/payments/subscriptions/{subscriptionId}/authorize/build-unsigned-transaction`     | `recurring_payments` |
| `POST`   | `/v1/payments/subscriptions/{subscriptionId}/prepare-cancel`                 | `/v1/payments/subscriptions/{subscriptionId}/cancel/build-unsigned-transaction`        | `recurring_payments` |
| `POST`   | `/v1/payments/subscriptions/{subscriptionId}/prepare-collection`             | `/v1/payments/subscriptions/{subscriptionId}/collect/build-unsigned-transaction`       | `recurring_payments` |
| `POST`   | `/v1/payments/subscriptions/{subscriptionId}/prepare-resume`                 | `/v1/payments/subscriptions/{subscriptionId}/resume/build-unsigned-transaction`        | `recurring_payments` |
| `POST`   | `/v1/payments/transfer-batches`                                              | `/v1/payments/transfer-batches/execute`                                                | `payments`           |
| `POST`   | `/v1/payments/transfers`                                                     | `/v1/payments/transfers/execute`                                                       | `payments`           |
| `POST`   | `/v1/wallets/initialize`                                                     | `/v1/wallets/managed-signing/initialize-with-wallet`                                   | `custody`            |
| `POST`   | `/webhooks/clerk/link-orgs`                                                  | `/webhooks/clerk`                                                                      | `core`               |

Deploying the Clerk webhook rename requires updating its configured delivery URL to `/webhooks/clerk`.

## Review map

Endpoint IDs and existing verdicts/notes are preserved where an entry existed in the original review. Six stable routes absent from that original snapshot are included with new IDs. Contracts below come from the current internal OpenAPI document; internal routes without a declared operation link to their implementation.

| Section                                             | Endpoints |
| --------------------------------------------------- | --------: |
| [Projects](#projects)                               |         7 |
| [Organizations](#organizations)                     |         7 |
| [Members and invitations](#members-and-invitations) |         8 |
| [API keys](#api-keys)                               |         6 |
| [Wallets](#wallets)                                 |        10 |
| [Counterparties](#counterparties)                   |        12 |
| [Transfer batches](#transfer-batches)               |         5 |
| [Transfers](#transfers)                             |         3 |
| [Payments](#payments)                               |         1 |
| [Service and discovery](#service-and-discovery)     |         9 |
| [Payment requests](#payment-requests)               |         5 |
| [Recurring payments](#recurring-payments)           |         8 |
| [Subscriptions](#subscriptions)                     |        13 |
| [Transactions](#transactions)                       |         1 |
| [Places](#places)                                   |         3 |
| [Dashboard helpers](#dashboard-helpers)             |        15 |
| [Onboarding](#onboarding)                           |         1 |
| [Webhooks](#webhooks)                               |         1 |
| [Administration](#administration)                   |         3 |


## Projects

| ID                     | Endpoint                                             | Verdict |
| ---------------------- | ---------------------------------------------------- | ------- |
| [E001](#endpoint-e001) | `GET /v1/projects`                                   | Pending |
| [E002](#endpoint-e002) | `GET /v1/projects/{projectId}`                       | Pending |
| [E003](#endpoint-e003) | `PATCH /v1/projects/{projectId}`                     | Pending |
| [E004](#endpoint-e004) | `GET /v1/projects/{projectId}/api-keys`              | Pending |
| [E005](#endpoint-e005) | `POST /v1/projects/{projectId}/api-keys`             | Pending |
| [E006](#endpoint-e006) | `GET /v1/projects/{projectId}/members`               | Pending |
| [E007](#endpoint-e007) | `GET /v1/projects/{projectId}/provider-availability` | Pending |

<a id="endpoint-e001"></a>

### E001: List projects

`GET /v1/projects`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value           |
| --------------- | --------------- |
| Module          | `core`          |
| Release channel | Stable          |
| Action / access | `projects.read` |
| Operation ID    | `listProjects`  |

Lists projects in the organization.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Projects"
  ],
  "summary": "List projects",
  "operationId": "listProjects",
  "description": "Lists projects in the organization.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema001"
      },
      "required": false,
      "description": "Include archived resources in results.",
      "name": "includeArchived",
      "in": "query"
    }
  ],
  "responses": {
    "200": {
      "description": "Projects list",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema002"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `projects.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e002"></a>

### E002: Get project

`GET /v1/projects/{projectId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value           |
| --------------- | --------------- |
| Module          | `core`          |
| Release channel | Stable          |
| Action / access | `projects.read` |
| Operation ID    | `getProject`    |

Gets project details.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Projects"
  ],
  "summary": "Get project",
  "operationId": "getProject",
  "description": "Gets project details.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema004"
      },
      "required": true,
      "description": "Project identifier.",
      "name": "projectId",
      "in": "path"
    }
  ],
  "responses": {
    "200": {
      "description": "Project",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema005"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `projects.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e003"></a>

### E003: Update project

`PATCH /v1/projects/{projectId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value             |
| --------------- | ----------------- |
| Module          | `core`            |
| Release channel | Stable            |
| Action / access | `projects.manage` |
| Operation ID    | `updateProject`   |

Updates project attributes.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Projects"
  ],
  "summary": "Update project",
  "operationId": "updateProject",
  "description": "Updates project attributes.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema004"
      },
      "required": true,
      "description": "Project identifier.",
      "name": "projectId",
      "in": "path"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema006"
        }
      }
    }
  },
  "responses": {
    "200": {
      "description": "Project updated",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema005"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `projects.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e004"></a>

### E004: List project API keys

`GET /v1/projects/{projectId}/api-keys`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                |
| --------------- | -------------------- |
| Module          | `core`               |
| Release channel | Stable               |
| Action / access | `api_keys.read`      |
| Operation ID    | `listProjectApiKeys` |

Lists API keys scoped to the project.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Projects"
  ],
  "summary": "List project API keys",
  "operationId": "listProjectApiKeys",
  "description": "Lists API keys scoped to the project.",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema004"
      },
      "required": true,
      "description": "Project identifier.",
      "name": "projectId",
      "in": "path"
    }
  ],
  "responses": {
    "200": {
      "description": "Project API keys",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema007"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `api_keys.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e005"></a>

### E005: Create project API key

`POST /v1/projects/{projectId}/api-keys`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                 |
| --------------- | --------------------- |
| Module          | `core`                |
| Release channel | Stable                |
| Action / access | `api_keys.manage`     |
| Operation ID    | `createProjectApiKey` |

Creates an API key scoped to the project. The full key is returned once.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Projects"
  ],
  "summary": "Create project API key",
  "operationId": "createProjectApiKey",
  "description": "Creates an API key scoped to the project. The full key is returned once.",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema004"
      },
      "required": true,
      "description": "Project identifier.",
      "name": "projectId",
      "in": "path"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema008"
        }
      }
    }
  },
  "responses": {
    "201": {
      "description": "Project API key created",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema009"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `api_keys.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "503": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e006"></a>

### E006: List project members

`GET /v1/projects/{projectId}/members`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                |
| --------------- | -------------------- |
| Module          | `core`               |
| Release channel | Stable               |
| Action / access | `members.read`       |
| Operation ID    | `listProjectMembers` |

Lists members assigned to the project.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Projects"
  ],
  "summary": "List project members",
  "operationId": "listProjectMembers",
  "description": "Lists members assigned to the project.",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema004"
      },
      "required": true,
      "description": "Project identifier.",
      "name": "projectId",
      "in": "path"
    }
  ],
  "responses": {
    "200": {
      "description": "Project members",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema010"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `members.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e007"></a>

### E007: Get project provider availability

`GET /v1/projects/{projectId}/provider-availability`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                            |
| --------------- | -------------------------------- |
| Module          | `core`                           |
| Release channel | Stable                           |
| Action / access | `projects.read`                  |
| Operation ID    | `getProjectProviderAvailability` |

Lists every provider this deployment's release channel publishes, with whether this project can use it, counting the deployment's provider credentials for the project's environment. The same rule gates every provider entry point, so a provider reported unavailable is refused there with 403, or 503 when the deployment does not hold its credentials. A project outside the caller's organization, or another project for a project-bound API key, returns 404.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Projects"
  ],
  "summary": "Get project provider availability",
  "operationId": "getProjectProviderAvailability",
  "description": "Lists every provider this deployment's release channel publishes, with whether this project can use it, counting the deployment's provider credentials for the project's environment. The same rule gates every provider entry point, so a provider reported unavailable is refused there with 403, or 503 when the deployment does not hold its credentials. A project outside the caller's organization, or another project for a project-bound API key, returns 404.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema004"
      },
      "required": true,
      "description": "Project identifier.",
      "name": "projectId",
      "in": "path"
    }
  ],
  "responses": {
    "200": {
      "description": "Project provider availability",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema011"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `projects.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>



## Organizations

| ID                     | Endpoint                                               | Verdict |
| ---------------------- | ------------------------------------------------------ | ------- |
| [E008](#endpoint-e008) | `POST /v1/organizations`                               | Pending |
| [E009](#endpoint-e009) | `GET /v1/organizations/{orgId}`                        | Pending |
| [E010](#endpoint-e010) | `PATCH /v1/organizations/{orgId}`                      | Pending |
| [E012](#endpoint-e012) | `GET /v1/organizations/{orgId}/provider-availability`  | Pending |
| [E290](#endpoint-e290) | `GET /v1/organizations/{orgId}/mainnet-access`         | Pending |
| [E291](#endpoint-e291) | `POST /v1/organizations/{orgId}/mainnet-access`        | Pending |
| [E292](#endpoint-e292) | `POST /v1/organizations/{orgId}/mainnet-access/notify` | Pending |

<a id="endpoint-e008"></a>

### E008: Create organization

`POST /v1/organizations`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------- |
| Module          | `core`                                                                                       |
| Release channel | Stable                                                                                       |
| Action / access | signed-in people with no organization: creates the caller's own organization, one per person |
| Operation ID    | `createOrganization`                                                                         |

Creates the caller's organization and makes them its admin, with a Sandbox and a Production project. Called with a signed-in Clerk session that has no active organization. A person creates one organization: repeating the request with the same name finishes or returns it, and another name is refused (409).

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Organizations"
  ],
  "summary": "Create organization",
  "operationId": "createOrganization",
  "description": "Creates the caller's organization and makes them its admin, with a Sandbox and a Production project. Called with a signed-in Clerk session that has no active organization. A person creates one organization: repeating the request with the same name finishes or returns it, and another name is refused (409).",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema012"
        }
      }
    }
  },
  "responses": {
    "201": {
      "description": "Organization created",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema013"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "429": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e009"></a>

### E009: Get organization

`GET /v1/organizations/{orgId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                |
| --------------- | -------------------- |
| Module          | `core`               |
| Release channel | Stable               |
| Action / access | `organizations.read` |
| Operation ID    | `getOrganization`    |

Returns organization details for the authenticated organization.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Organizations"
  ],
  "summary": "Get organization",
  "operationId": "getOrganization",
  "description": "Returns organization details for the authenticated organization.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema014"
      },
      "required": true,
      "description": "Organization identifier.",
      "name": "orgId",
      "in": "path"
    }
  ],
  "responses": {
    "200": {
      "description": "Organization found",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema015"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `organizations.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e010"></a>

### E010: Update organization

`PATCH /v1/organizations/{orgId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                  |
| --------------- | ---------------------- |
| Module          | `core`                 |
| Release channel | Stable                 |
| Action / access | `organizations.manage` |
| Operation ID    | `updateOrganization`   |

Updates organization name or settings.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Organizations"
  ],
  "summary": "Update organization",
  "operationId": "updateOrganization",
  "description": "Updates organization name or settings.",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema014"
      },
      "required": true,
      "description": "Organization identifier.",
      "name": "orgId",
      "in": "path"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema016"
        }
      }
    }
  },
  "responses": {
    "200": {
      "description": "Organization updated",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema015"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `organizations.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e012"></a>

### E012: Get Organization Provider Access

`GET /v1/organizations/{orgId}/provider-availability`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                |
| --------------- | -------------------- |
| Module          | `core`               |
| Release channel | Stable               |
| Action / access | `organizations.read` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/organizations/index.ts) · [handler](../../apps/sdp-api/src/routes/organizations/handlers.ts)


<a id="endpoint-e290"></a>

### E290: Get mainnet access

`GET /v1/organizations/{orgId}/mainnet-access`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                  |
| --------------- | ---------------------- |
| Module          | `core`                 |
| Release channel | Stable                 |
| Action / access | `organizations.manage` |
| Operation ID    | `getMainnetAccess`     |

Returns where the organization's mainnet access stands, with its declared jurisdiction and Terms and Conditions acceptance, and whether this deployment takes requests. A signed-in admin only, never an API key.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Organizations"
  ],
  "summary": "Get mainnet access",
  "operationId": "getMainnetAccess",
  "description": "Returns where the organization's mainnet access stands, with its declared jurisdiction and Terms and Conditions acceptance, and whether this deployment takes requests. A signed-in admin only, never an API key.",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema014"
      },
      "required": true,
      "description": "Organization identifier.",
      "name": "orgId",
      "in": "path"
    }
  ],
  "responses": {
    "200": {
      "description": "Mainnet access",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema017"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `organizations.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e291"></a>

### E291: Request mainnet access

`POST /v1/organizations/{orgId}/mainnet-access`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                  |
| --------------- | ---------------------- |
| Module          | `core`                 |
| Release channel | Stable                 |
| Action / access | `organizations.manage` |
| Operation ID    | `requestMainnetAccess` |

Records the organization's jurisdiction and its acceptance of the current SDP Terms and Conditions, and asks SDP to enable mainnet. Once per organization; an operator approves it. A signed-in admin only, never an API key. Refused with 409 once the organization asked, when mainnet is already enabled, or when the terms version is not the current one. If the email to SDP fails, the request stays recorded and `POST …/notify` sends it.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Organizations"
  ],
  "summary": "Request mainnet access",
  "operationId": "requestMainnetAccess",
  "description": "Records the organization's jurisdiction and its acceptance of the current SDP Terms and Conditions, and asks SDP to enable mainnet. Once per organization; an operator approves it. A signed-in admin only, never an API key. Refused with 409 once the organization asked, when mainnet is already enabled, or when the terms version is not the current one. If the email to SDP fails, the request stays recorded and `POST …/notify` sends it.",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema014"
      },
      "required": true,
      "description": "Organization identifier.",
      "name": "orgId",
      "in": "path"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/RequestMainnetAccessRequest"
        }
      }
    }
  },
  "responses": {
    "201": {
      "description": "Request sent",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema017"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `organizations.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "503": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e292"></a>

### E292: Send a mainnet access request again

`POST /v1/organizations/{orgId}/mainnet-access/notify`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                  |
| --------------- | ---------------------- |
| Module          | `core`                 |
| Release channel | Stable                 |
| Action / access | `organizations.manage` |
| Operation ID    | `notifyMainnetAccess`  |

Sends the organization's recorded request to SDP when its email did not go out. Changes nothing else. A signed-in admin only, never an API key. Refused with 409 when the organization has not asked or its request was already sent.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Organizations"
  ],
  "summary": "Send a mainnet access request again",
  "operationId": "notifyMainnetAccess",
  "description": "Sends the organization's recorded request to SDP when its email did not go out. Changes nothing else. A signed-in admin only, never an API key. Refused with 409 when the organization has not asked or its request was already sent.",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema014"
      },
      "required": true,
      "description": "Organization identifier.",
      "name": "orgId",
      "in": "path"
    }
  ],
  "responses": {
    "200": {
      "description": "Request sent",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema017"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `organizations.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "503": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>



## Members and invitations

| ID                     | Endpoint                                        | Verdict |
| ---------------------- | ----------------------------------------------- | ------- |
| [E013](#endpoint-e013) | `GET /v1/members`                               | Pending |
| [E014](#endpoint-e014) | `DELETE /v1/members/invitations/{invitationId}` | Pending |
| [E015](#endpoint-e015) | `POST /v1/members/invitations`                  | Pending |
| [E016](#endpoint-e016) | `GET /v1/members/me`                            | Pending |
| [E017](#endpoint-e017) | `DELETE /v1/members/me`                         | Pending |
| [E018](#endpoint-e018) | `PATCH /v1/members/{memberId}`                  | Pending |
| [E019](#endpoint-e019) | `DELETE /v1/members/{memberId}`                 | Pending |
| [E293](#endpoint-e293) | `GET /v1/members/{memberId}/api-keys`           | Pending |

<a id="endpoint-e013"></a>

### E013: List organization members

`GET /v1/members`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value          |
| --------------- | -------------- |
| Module          | `core`         |
| Release channel | Stable         |
| Action / access | `members.read` |
| Operation ID    | `listMembers`  |

Lists members of the authenticated organization, followed by any pending invitations the caller is permitted to see. The two page as one sequence. Invitations require `members.manage`, because each names an invitee's email address. Clerk's acceptance link is never returned: it reaches only the invitee's inbox.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Members"
  ],
  "summary": "List organization members",
  "operationId": "listMembers",
  "description": "Lists members of the authenticated organization, followed by any pending invitations the caller is permitted to see. The two page as one sequence. Invitations require `members.manage`, because each names an invitee's email address. Clerk's acceptance link is never returned: it reaches only the invitee's inbox.",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema018"
      },
      "required": false,
      "description": "Page number (1-based).",
      "name": "page",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema019"
      },
      "required": false,
      "description": "Records per page. Values above 100 are clamped to 100.",
      "name": "pageSize",
      "in": "query"
    }
  ],
  "responses": {
    "200": {
      "description": "Members list",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema020"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `members.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e014"></a>

### E014: Revoke invitation

`DELETE /v1/members/invitations/{invitationId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value              |
| --------------- | ------------------ |
| Module          | `core`             |
| Release channel | Stable             |
| Action / access | `members.manage`   |
| Operation ID    | `revokeInvitation` |

Withdraws a pending invitation, in SDP and then in Clerk. An accepted or expired invitation cannot be revoked (400). Revoking an invitation already revoked withdraws whatever is still pending in Clerk, so a retry after a failed Clerk call completes the revocation.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Members"
  ],
  "summary": "Revoke invitation",
  "operationId": "revokeInvitation",
  "description": "Withdraws a pending invitation, in SDP and then in Clerk. An accepted or expired invitation cannot be revoked (400). Revoking an invitation already revoked withdraws whatever is still pending in Clerk, so a retry after a failed Clerk call completes the revocation.",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema021"
      },
      "required": true,
      "description": "Invitation identifier.",
      "name": "invitationId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema023"
      },
      "required": false,
      "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` with no `Retry-After`, as does every later retry with that key: read the resource with GET to see whether it ran, then send again with a new key. After a 5xx, a retry with the same key runs again and answers from the original record instead of acting twice; that answer also carries `Idempotent-Replayed: true`.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "responses": {
    "204": {
      "description": "Invitation revoked"
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `members.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e015"></a>

### E015: Invite member

`POST /v1/members/invitations`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value            |
| --------------- | ---------------- |
| Module          | `core`           |
| Release channel | Stable           |
| Action / access | `members.manage` |
| Operation ID    | `inviteMember`   |

Invites an address to the organization at the given role. The invitation, and Clerk's emailed link, expire after 7 days. An address can hold one pending invitation per organization: a second one is refused (409) before any email is sent.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Members"
  ],
  "summary": "Invite member",
  "operationId": "inviteMember",
  "description": "Invites an address to the organization at the given role. The invitation, and Clerk's emailed link, expire after 7 days. An address can hold one pending invitation per organization: a second one is refused (409) before any email is sent.",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema024"
      },
      "required": false,
      "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` with no `Retry-After`, as does every later retry with that key: read the resource with GET to see whether it ran, then send again with a new key. A 5xx is stored and replayed like any other answer; retry it with a new key.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema025"
        }
      }
    }
  },
  "responses": {
    "201": {
      "description": "Invitation created",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema026"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `members.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e016"></a>

### E016: Get current member

`GET /v1/members/me`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value              |
| --------------- | ------------------ |
| Module          | `core`             |
| Release channel | Stable             |
| Action / access | `members.read`     |
| Operation ID    | `getCurrentMember` |

Returns the caller's own membership in the authenticated organization. The role is SDP's, never Clerk's, and is what every permission check uses.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Members"
  ],
  "summary": "Get current member",
  "operationId": "getCurrentMember",
  "description": "Returns the caller's own membership in the authenticated organization. The role is SDP's, never Clerk's, and is what every permission check uses.",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "responses": {
    "200": {
      "description": "Current member",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema027"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `members.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e017"></a>

### E017: Leave organization

`DELETE /v1/members/me`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------- |
| Module          | `core`                                                                                        |
| Release channel | Stable                                                                                        |
| Action / access | signed-in members only: leaving acts on the caller's own membership, which any member may end |
| Operation ID    | `leaveOrganization`                                                                           |

Ends the caller's own membership, their project memberships in the organization and their pending invitations to it. An admin cannot leave (409); another admin removes them instead.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Members"
  ],
  "summary": "Leave organization",
  "operationId": "leaveOrganization",
  "description": "Ends the caller's own membership, their project memberships in the organization and their pending invitations to it. An admin cannot leave (409); another admin removes them instead.",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "responses": {
    "204": {
      "description": "Left the organization"
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e018"></a>

### E018: Change member role

`PATCH /v1/members/{memberId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value              |
| --------------- | ------------------ |
| Module          | `core`             |
| Release channel | Stable             |
| Action / access | `members.manage`   |
| Operation ID    | `updateMemberRole` |

Changes another member's Organization Role. An admin cannot change their own role, and the last active admin cannot be demoted (409). Takes effect on the member's next request.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Members"
  ],
  "summary": "Change member role",
  "operationId": "updateMemberRole",
  "description": "Changes another member's Organization Role. An admin cannot change their own role, and the last active admin cannot be demoted (409). Takes effect on the member's next request.",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema028"
      },
      "required": true,
      "description": "Member identifier.",
      "name": "memberId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema024"
      },
      "required": false,
      "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` with no `Retry-After`, as does every later retry with that key: read the resource with GET to see whether it ran, then send again with a new key. A 5xx is stored and replayed like any other answer; retry it with a new key.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema029"
        }
      }
    }
  },
  "responses": {
    "200": {
      "description": "Member role",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema027"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `members.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e019"></a>

### E019: Remove member

`DELETE /v1/members/{memberId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value            |
| --------------- | ---------------- |
| Module          | `core`           |
| Release channel | Stable           |
| Action / access | `members.manage` |
| Operation ID    | `removeMember`   |

Removes another member from the organization, along with their project memberships in it and their pending invitations, so an unspent invitation cannot readmit them. The last active admin cannot be removed, and nobody can remove themselves (409). Removing a member already removed withdraws their Clerk membership again and changes nothing else, so a retry after a failed Clerk call completes the removal. Re-inviting the removed member issues a fresh invitation that works normally.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Members"
  ],
  "summary": "Remove member",
  "operationId": "removeMember",
  "description": "Removes another member from the organization, along with their project memberships in it and their pending invitations, so an unspent invitation cannot readmit them. The last active admin cannot be removed, and nobody can remove themselves (409). Removing a member already removed withdraws their Clerk membership again and changes nothing else, so a retry after a failed Clerk call completes the removal. Re-inviting the removed member issues a fresh invitation that works normally.",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema028"
      },
      "required": true,
      "description": "Member identifier.",
      "name": "memberId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema023"
      },
      "required": false,
      "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` with no `Retry-After`, as does every later retry with that key: read the resource with GET to see whether it ran, then send again with a new key. After a 5xx, a retry with the same key runs again and answers from the original record instead of acting twice; that answer also carries `Idempotent-Replayed: true`.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "responses": {
    "204": {
      "description": "Member removed"
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `members.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e293"></a>

### E293: List a member's API keys

`GET /v1/members/{memberId}/api-keys`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value               |
| --------------- | ------------------- |
| Module          | `core`              |
| Release channel | Stable              |
| Action / access | `members.manage`    |
| Operation ID    | `listMemberApiKeys` |

Lists the active API keys the member created, across every project of the organization, newest first. Keys belong to the organization: removing the member leaves them working, so an admin reads this before or after a removal to decide which to revoke. A rotated key keeps the creator of the key it replaced.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Members"
  ],
  "summary": "List a member's API keys",
  "operationId": "listMemberApiKeys",
  "description": "Lists the active API keys the member created, across every project of the organization, newest first. Keys belong to the organization: removing the member leaves them working, so an admin reads this before or after a removal to decide which to revoke. A rotated key keeps the creator of the key it replaced.",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema028"
      },
      "required": true,
      "description": "Member identifier.",
      "name": "memberId",
      "in": "path"
    }
  ],
  "responses": {
    "200": {
      "description": "The member's active API keys",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema030"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `members.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>



## API keys

| ID                     | Endpoint                           | Verdict |
| ---------------------- | ---------------------------------- | ------- |
| [E020](#endpoint-e020) | `GET /v1/api-keys`                 | Pending |
| [E021](#endpoint-e021) | `POST /v1/api-keys`                | Pending |
| [E022](#endpoint-e022) | `GET /v1/api-keys/{keyId}`         | Pending |
| [E023](#endpoint-e023) | `PATCH /v1/api-keys/{keyId}`       | Pending |
| [E024](#endpoint-e024) | `DELETE /v1/api-keys/{keyId}`      | Pending |
| [E025](#endpoint-e025) | `POST /v1/api-keys/{keyId}/rotate` | Pending |

<a id="endpoint-e020"></a>

### E020: List API keys

`GET /v1/api-keys`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value           |
| --------------- | --------------- |
| Module          | `core`          |
| Release channel | Stable          |
| Action / access | `api_keys.read` |
| Operation ID    | `listApiKeys`   |

Lists API keys for the authenticated organization.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "API Keys"
  ],
  "summary": "List API keys",
  "operationId": "listApiKeys",
  "description": "Lists API keys for the authenticated organization.",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "API keys",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema031"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `api_keys.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e021"></a>

### E021: Create API key

`POST /v1/api-keys`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value             |
| --------------- | ----------------- |
| Module          | `core`            |
| Release channel | Stable            |
| Action / access | `api_keys.manage` |
| Operation ID    | `createApiKey`    |

Creates a new API key. The full key is returned once.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "API Keys"
  ],
  "summary": "Create API key",
  "operationId": "createApiKey",
  "description": "Creates a new API key. The full key is returned once.",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema008"
        }
      }
    }
  },
  "responses": {
    "201": {
      "description": "API key created",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema009"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `api_keys.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "503": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e022"></a>

### E022: Get API key

`GET /v1/api-keys/{keyId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value           |
| --------------- | --------------- |
| Module          | `core`          |
| Release channel | Stable          |
| Action / access | `api_keys.read` |
| Operation ID    | `getApiKey`     |

Gets API key details by id.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "API Keys"
  ],
  "summary": "Get API key",
  "operationId": "getApiKey",
  "description": "Gets API key details by id.",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema032"
      },
      "required": true,
      "description": "API key identifier.",
      "name": "keyId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "API key details",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema033"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `api_keys.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e023"></a>

### E023: Update API key

`PATCH /v1/api-keys/{keyId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value             |
| --------------- | ----------------- |
| Module          | `core`            |
| Release channel | Stable            |
| Action / access | `api_keys.manage` |
| Operation ID    | `updateApiKey`    |

Updates API key attributes. Use null to clear optional fields.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "API Keys"
  ],
  "summary": "Update API key",
  "operationId": "updateApiKey",
  "description": "Updates API key attributes. Use null to clear optional fields.",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema032"
      },
      "required": true,
      "description": "API key identifier.",
      "name": "keyId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema034"
        }
      }
    }
  },
  "responses": {
    "200": {
      "description": "API key updated",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema035"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `api_keys.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e024"></a>

### E024: Deactivate API key

`DELETE /v1/api-keys/{keyId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value             |
| --------------- | ----------------- |
| Module          | `core`            |
| Release channel | Stable            |
| Action / access | `api_keys.manage` |
| Operation ID    | `revokeApiKey`    |

Deactivates (soft deletes) an API key and invalidates it immediately. Recurring payments the key activated keep collecting: a schedule outlives the key that set it up. If the key may be compromised, set `cancelRecurringPayments` to cancel them as well.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "API Keys"
  ],
  "summary": "Deactivate API key",
  "operationId": "revokeApiKey",
  "description": "Deactivates (soft deletes) an API key and invalidates it immediately. Recurring payments the key activated keep collecting: a schedule outlives the key that set it up. If the key may be compromised, set `cancelRecurringPayments` to cancel them as well.",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema032"
      },
      "required": true,
      "description": "API key identifier.",
      "name": "keyId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema036"
        }
      }
    }
  },
  "responses": {
    "200": {
      "description": "API key revoked",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema037"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `api_keys.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e025"></a>

### E025: Rotate API key

`POST /v1/api-keys/{keyId}/rotate`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value             |
| --------------- | ----------------- |
| Module          | `core`            |
| Release channel | Stable            |
| Action / access | `api_keys.manage` |
| Operation ID    | `rotateApiKey`    |

Rotates an API key and returns the new key plus the old key grace period.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "API Keys"
  ],
  "summary": "Rotate API key",
  "operationId": "rotateApiKey",
  "description": "Rotates an API key and returns the new key plus the old key grace period.",
  "security": [
    {
      "clerkBearerAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema032"
      },
      "required": true,
      "description": "API key identifier.",
      "name": "keyId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": false,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema038"
        }
      }
    }
  },
  "responses": {
    "201": {
      "description": "API key rotated",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema039"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `api_keys.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>



## Wallets

| ID                     | Endpoint                                                  | Verdict |
| ---------------------- | --------------------------------------------------------- | ------- |
| [E026](#endpoint-e026) | `GET /v1/wallets`                                         | Pending |
| [E027](#endpoint-e027) | `POST /v1/wallets`                                        | Pending |
| [E028](#endpoint-e028) | `DELETE /v1/wallets`                                      | Pending |
| [E029](#endpoint-e029) | `GET /v1/wallets/balances/aggregate`                      | Pending |
| [E030](#endpoint-e030) | `GET /v1/wallets/managed-signing/configurations`          | Pending |
| [E031](#endpoint-e031) | `POST /v1/wallets/managed-signing/initialize-with-wallet` | Pending |
| [E032](#endpoint-e032) | `GET /v1/wallets/public-key`                              | Pending |
| [E033](#endpoint-e033) | `POST /v1/wallets/signer-check`                           | Pending |
| [E034](#endpoint-e034) | `GET /v1/wallets/{walletId}`                              | Pending |
| [E035](#endpoint-e035) | `PATCH /v1/wallets/{walletId}`                            | Pending |

<a id="endpoint-e026"></a>

### E026: List wallets

`GET /v1/wallets`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value          |
| --------------- | -------------- |
| Module          | `custody`      |
| Release channel | Stable         |
| Action / access | `wallets.read` |
| Operation ID    | `listWallets`  |

Lists active wallets under active Config and Connection owners, oldest first. Provider narrows the list to one custody provider.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Wallets"
  ],
  "summary": "List wallets",
  "operationId": "listWallets",
  "description": "Lists active wallets under active Config and Connection owners, oldest first. Provider narrows the list to one custody provider.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema040"
      },
      "required": false,
      "description": "Wallet signing provider.",
      "name": "provider",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema041"
      },
      "required": false,
      "name": "includeBalances",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema042"
      },
      "required": false,
      "name": "view",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Wallets",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema043"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `wallets.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e027"></a>

### E027: Create wallet

`POST /v1/wallets`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value            |
| --------------- | ---------------- |
| Module          | `custody`        |
| Release channel | Stable           |
| Action / access | `wallets.manage` |
| Operation ID    | `createWallet`   |

Provisions a new wallet under exactly one provider account: the project's Managed config for provider, or the Custody Connection named by connectionId. A body naming both, or neither, is rejected with 400. With an Idempotency-Key, SDP never records a second wallet for one key: a retry returns the wallet an earlier attempt recorded, including after the 24-hour key window. Privy and Coinbase CDP also receive a request id derived from the key, so they dedupe at the provider. A provider failure is stored as a 503, and a new key is a new provider request. A 503 can mean the provider created the wallet before the error, and with a provider other than Privy or Coinbase CDP, a failure that left no SDP wallet row makes even the same key a new provider request after 24 hours: before any retry after an ambiguous failure, whatever the key, check GET /v1/wallets and, if the wallet is not there, the provider account. The provider request id and the recorded-wallet lookup both include the credential, so after an API key rotation, once the key's 24-hour record has expired, the same key under the new credential is a new provider request and can create a second wallet: after a rotation, list wallets with GET /v1/wallets and check the provider account before retrying a create.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Wallets"
  ],
  "summary": "Create wallet",
  "operationId": "createWallet",
  "description": "Provisions a new wallet under exactly one provider account: the project's Managed config for provider, or the Custody Connection named by connectionId. A body naming both, or neither, is rejected with 400. With an Idempotency-Key, SDP never records a second wallet for one key: a retry returns the wallet an earlier attempt recorded, including after the 24-hour key window. Privy and Coinbase CDP also receive a request id derived from the key, so they dedupe at the provider. A provider failure is stored as a 503, and a new key is a new provider request. A 503 can mean the provider created the wallet before the error, and with a provider other than Privy or Coinbase CDP, a failure that left no SDP wallet row makes even the same key a new provider request after 24 hours: before any retry after an ambiguous failure, whatever the key, check GET /v1/wallets and, if the wallet is not there, the provider account. The provider request id and the recorded-wallet lookup both include the credential, so after an API key rotation, once the key's 24-hour record has expired, the same key under the new credential is a new provider request and can create a second wallet: after a rotation, list wallets with GET /v1/wallets and check the provider account before retrying a create.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema044"
      },
      "required": false,
      "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then takes over and is answered from the record it wrote. A 5xx is stored and replayed like any other answer; retry it with a new key.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema045"
        }
      }
    }
  },
  "responses": {
    "201": {
      "description": "Wallet created",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema046"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `wallets.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.\n\nForbidden: the caller lacks the route's action or the API key is wallet-scoped, or the provider account was refused. A refusal's details.reason names the failed check: custody_mode_not_allowed when provider names a Managed config in a Production project (Production is BYOK only: create the wallet in a Custody Connection with connectionId), custody_provider_not_in_release_channel, or provider_not_entitled.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "503": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e028"></a>

### E028: Delete wallet

`DELETE /v1/wallets`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value             |
| --------------- | ----------------- |
| Module          | `custody`         |
| Release channel | Stable            |
| Action / access | `wallets.execute` |
| Operation ID    | `deleteWallet`    |

Deletes the wallet from its exact owning provider account when that Provider supports wallet deletion. Provider, when supplied, is a consistency assertion.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Wallets"
  ],
  "summary": "Delete wallet",
  "operationId": "deleteWallet",
  "description": "Deletes the wallet from its exact owning provider account when that Provider supports wallet deletion. Provider, when supplied, is a consistency assertion.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema024"
      },
      "required": false,
      "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` with no `Retry-After`, as does every later retry with that key: read the resource with GET to see whether it ran, then send again with a new key. A 5xx is stored and replayed like any other answer; retry it with a new key.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema047"
        }
      }
    }
  },
  "responses": {
    "200": {
      "description": "Wallet deleted",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema048"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `wallets.execute` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e029"></a>

### E029: Aggregate wallet balances

`GET /v1/wallets/balances/aggregate`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                     |
| --------------- | ------------------------- |
| Module          | `custody`                 |
| Release channel | Stable                    |
| Action / access | `wallets.read`            |
| Operation ID    | `aggregateWalletBalances` |

Aggregates tracked balances for active wallets under the same owner-aware inclusion rules as the wallet list, without exposing one aggregate-level owner or runtime-admission value. Returns 503 if any included wallet balance cannot be read, rather than returning an incomplete total.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Wallets"
  ],
  "summary": "Aggregate wallet balances",
  "operationId": "aggregateWalletBalances",
  "description": "Aggregates tracked balances for active wallets under the same owner-aware inclusion rules as the wallet list, without exposing one aggregate-level owner or runtime-admission value. Returns 503 if any included wallet balance cannot be read, rather than returning an incomplete total.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema040"
      },
      "required": false,
      "description": "Wallet signing provider.",
      "name": "provider",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Aggregated wallet balances",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema049"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `wallets.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "503": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e030"></a>

### E030: List managed signing configurations

`GET /v1/wallets/managed-signing/configurations`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value               |
| --------------- | ------------------- |
| Module          | `custody`           |
| Release channel | Stable              |
| Action / access | `wallets.read`      |
| Operation ID    | `listWalletConfigs` |

Returns the active Config-owned wallet signing configurations for the requested scope, one per provider.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Wallets"
  ],
  "summary": "List managed signing configurations",
  "operationId": "listWalletConfigs",
  "description": "Returns the active Config-owned wallet signing configurations for the requested scope, one per provider.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Wallet signing configurations",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema050"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `wallets.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e031"></a>

### E031: Initialize wallet signing

`POST /v1/wallets/managed-signing/initialize-with-wallet`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                     |
| --------------- | ------------------------- |
| Module          | `custody`                 |
| Release channel | Stable                    |
| Action / access | `wallets.configure`       |
| Operation ID    | `initializeWalletSigning` |

Sets up Managed custody for the project's named provider by creating its active signing configuration and first wallet. Production projects use BYOK only: there this returns 403 with details.reason custody_mode_not_allowed, and wallets are created in a Custody Connection with POST /v1/wallets and connectionId.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Wallets"
  ],
  "summary": "Initialize wallet signing",
  "operationId": "initializeWalletSigning",
  "description": "Sets up Managed custody for the project's named provider by creating its active signing configuration and first wallet. Production projects use BYOK only: there this returns 403 with details.reason custody_mode_not_allowed, and wallets are created in a Custody Connection with POST /v1/wallets and connectionId.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema024"
      },
      "required": false,
      "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` with no `Retry-After`, as does every later retry with that key: read the resource with GET to see whether it ran, then send again with a new key. A 5xx is stored and replayed like any other answer; retry it with a new key.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema051"
        }
      }
    }
  },
  "responses": {
    "201": {
      "description": "Wallet signing initialized",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema052"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `wallets.configure` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.\n\nForbidden: the caller lacks the route's action or the API key is wallet-scoped, or custody setup was refused. A refusal's details.reason names the failed check: custody_mode_not_allowed when a Production project names Managed custody (Production is BYOK only), custody_provider_not_in_release_channel, or provider_not_entitled.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "503": {
      "description": "PROVIDER_NOT_CONFIGURED: the deployment holds no credentials for the provider in the project's environment (details.reason provider_not_configured).",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e032"></a>

### E032: Get wallet public key

`GET /v1/wallets/public-key`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                |
| --------------- | -------------------- |
| Module          | `custody`            |
| Release channel | Stable               |
| Action / access | `wallets.read`       |
| Operation ID    | `getWalletPublicKey` |

Returns the persisted public key for an exact active walletId. walletId is required (400 without it); an API key with selected wallets gets 404 for a wallet it does not list. Resolution is DB-backed only.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Wallets"
  ],
  "summary": "Get wallet public key",
  "operationId": "getWalletPublicKey",
  "description": "Returns the persisted public key for an exact active walletId. walletId is required (400 without it); an API key with selected wallets gets 404 for a wallet it does not list. Resolution is DB-backed only.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema053"
      },
      "required": true,
      "description": "Provider wallet ID — the `walletId` field returned by GET /v1/wallets.",
      "name": "walletId",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Wallet public key",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema054"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `wallets.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e033"></a>

### E033: Check signer via simulated memo transaction

`POST /v1/wallets/signer-check`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value               |
| --------------- | ------------------- |
| Module          | `custody`           |
| Release channel | Stable              |
| Action / access | `wallets.execute`   |
| Operation ID    | `checkWalletSigner` |

Signs a server-authored memo message with the named wallet, verifies the signature, and simulates the transaction. Nothing is broadcast and no sponsorship is spent. The wallet is the only readonly signer and the request cannot supply memo text.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Wallets"
  ],
  "summary": "Check signer via simulated memo transaction",
  "operationId": "checkWalletSigner",
  "description": "Signs a server-authored memo message with the named wallet, verifies the signature, and simulates the transaction. Nothing is broadcast and no sponsorship is spent. The wallet is the only readonly signer and the request cannot supply memo text.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema024"
      },
      "required": false,
      "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` with no `Retry-After`, as does every later retry with that key: read the resource with GET to see whether it ran, then send again with a new key. A 5xx is stored and replayed like any other answer; retry it with a new key.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema055"
        }
      }
    }
  },
  "responses": {
    "200": {
      "description": "Signer check verified in simulation",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema056"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `wallets.execute` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "429": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "502": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e034"></a>

### E034: Get wallet by ID

`GET /v1/wallets/{walletId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value           |
| --------------- | --------------- |
| Module          | `custody`       |
| Release channel | Stable          |
| Action / access | `wallets.read`  |
| Operation ID    | `getWalletById` |

Returns active wallet metadata, exact Config or Connection ownership, runtime execution admission, Provider, public key, and by default the current SOL balance. If the balance read fails, returns 503 instead of a zero balance. Set includeBalance=false for a metadata-only read.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Wallets"
  ],
  "summary": "Get wallet by ID",
  "operationId": "getWalletById",
  "description": "Returns active wallet metadata, exact Config or Connection ownership, runtime execution admission, Provider, public key, and by default the current SOL balance. If the balance read fails, returns 503 instead of a zero balance. Set includeBalance=false for a metadata-only read.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema053"
      },
      "required": true,
      "description": "Provider wallet ID — the `walletId` field returned by GET /v1/wallets.",
      "name": "walletId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema057"
      },
      "required": false,
      "description": "Whether to resolve the current SOL balance. Defaults to true; false returns metadata without balance RPC or pricing calls.",
      "name": "includeBalance",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Wallet details",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema058"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `wallets.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "503": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e035"></a>

### E035: Update wallet

`PATCH /v1/wallets/{walletId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value            |
| --------------- | ---------------- |
| Module          | `custody`        |
| Release channel | Stable           |
| Action / access | `wallets.manage` |
| Operation ID    | `updateWallet`   |

Updates the display label of an active wallet under its exact Config or Connection owner.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Wallets"
  ],
  "summary": "Update wallet",
  "operationId": "updateWallet",
  "description": "Updates the display label of an active wallet under its exact Config or Connection owner.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema053"
      },
      "required": true,
      "description": "Provider wallet ID — the `walletId` field returned by GET /v1/wallets.",
      "name": "walletId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema024"
      },
      "required": false,
      "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` with no `Retry-After`, as does every later retry with that key: read the resource with GET to see whether it ran, then send again with a new key. A 5xx is stored and replayed like any other answer; retry it with a new key.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema059"
        }
      }
    }
  },
  "responses": {
    "200": {
      "description": "Wallet updated",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema046"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `wallets.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>



## Counterparties

| ID                     | Endpoint                                                                      | Verdict |
| ---------------------- | ----------------------------------------------------------------------------- | ------- |
| [E036](#endpoint-e036) | `GET /v1/counterparties`                                                      | Pending |
| [E037](#endpoint-e037) | `POST /v1/counterparties`                                                     | Pending |
| [E038](#endpoint-e038) | `GET /v1/counterparties/accounts`                                             | Pending |
| [E039](#endpoint-e039) | `GET /v1/counterparties/field-options`                                        | Pending |
| [E040](#endpoint-e040) | `GET /v1/counterparties/{counterpartyId}`                                     | Pending |
| [E041](#endpoint-e041) | `PATCH /v1/counterparties/{counterpartyId}`                                   | Pending |
| [E042](#endpoint-e042) | `DELETE /v1/counterparties/{counterpartyId}`                                  | Pending |
| [E043](#endpoint-e043) | `GET /v1/counterparties/{counterpartyId}/accounts`                            | Pending |
| [E044](#endpoint-e044) | `POST /v1/counterparties/{counterpartyId}/accounts`                           | Pending |
| [E045](#endpoint-e045) | `GET /v1/counterparties/{counterpartyId}/accounts/{counterpartyAccountId}`    | Pending |
| [E046](#endpoint-e046) | `PATCH /v1/counterparties/{counterpartyId}/accounts/{counterpartyAccountId}`  | Pending |
| [E047](#endpoint-e047) | `DELETE /v1/counterparties/{counterpartyId}/accounts/{counterpartyAccountId}` | Pending |

<a id="endpoint-e036"></a>

### E036: List counterparties

`GET /v1/counterparties`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                 |
| --------------- | --------------------- |
| Module          | `payments`            |
| Release channel | Stable                |
| Action / access | `counterparties.read` |
| Operation ID    | `listCounterparties`  |

Lists counterparties for the authenticated organization.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Counterparties"
  ],
  "x-sdp-group": "Profiles",
  "summary": "List counterparties",
  "operationId": "listCounterparties",
  "description": "Lists counterparties for the authenticated organization.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema060"
      },
      "required": false,
      "description": "Page number (1-based).",
      "name": "page",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema061"
      },
      "required": false,
      "description": "Items per page (max 100).",
      "name": "pageSize",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema062"
      },
      "required": false,
      "description": "Include archived counterparties in results.",
      "name": "includeArchived",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Counterparties list",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema063"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `counterparties.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e037"></a>

### E037: Create counterparty

`POST /v1/counterparties`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                   |
| --------------- | ----------------------- |
| Module          | `payments`              |
| Release channel | Stable                  |
| Action / access | `counterparties.manage` |
| Operation ID    | `createCounterparty`    |

Creates a counterparty. If externalId is provided, it must be unique within the organization.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Counterparties"
  ],
  "x-sdp-group": "Profiles",
  "summary": "Create counterparty",
  "operationId": "createCounterparty",
  "description": "Creates a counterparty. If externalId is provided, it must be unique within the organization.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema024"
      },
      "required": false,
      "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` with no `Retry-After`, as does every later retry with that key: read the resource with GET to see whether it ran, then send again with a new key. A 5xx is stored and replayed like any other answer; retry it with a new key.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema064"
        }
      }
    }
  },
  "responses": {
    "201": {
      "description": "Counterparty created",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema065"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `counterparties.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e038"></a>

### E038: List Project Counterparty Accounts

`GET /v1/counterparties/accounts`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                 |
| --------------- | --------------------- |
| Module          | `payments`            |
| Release channel | Stable                |
| Action / access | `counterparties.read` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/counterparties/index.ts) · [handler](../../apps/sdp-api/src/routes/counterparties/handlers.ts)


<a id="endpoint-e039"></a>

### E039: Get counterparty field options

`GET /v1/counterparties/field-options`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                         |
| --------------- | ----------------------------- |
| Module          | `payments`                    |
| Release channel | Stable                        |
| Action / access | `counterparties.read`         |
| Operation ID    | `getCounterpartyFieldOptions` |

Returns the enum option sets and country list needed to build a counterparty form.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Counterparties"
  ],
  "x-sdp-group": "Profiles",
  "summary": "Get counterparty field options",
  "operationId": "getCounterpartyFieldOptions",
  "description": "Returns the enum option sets and country list needed to build a counterparty form.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Counterparty field options",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema066"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `counterparties.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e040"></a>

### E040: Get counterparty

`GET /v1/counterparties/{counterpartyId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                 |
| --------------- | --------------------- |
| Module          | `payments`            |
| Release channel | Stable                |
| Action / access | `counterparties.read` |
| Operation ID    | `getCounterparty`     |

Gets counterparty details by id.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Counterparties"
  ],
  "x-sdp-group": "Profiles",
  "summary": "Get counterparty",
  "operationId": "getCounterparty",
  "description": "Gets counterparty details by id.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema067"
      },
      "required": true,
      "description": "Counterparty identifier.",
      "name": "counterpartyId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Counterparty",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema065"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `counterparties.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e041"></a>

### E041: Update counterparty

`PATCH /v1/counterparties/{counterpartyId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                   |
| --------------- | ----------------------- |
| Module          | `payments`              |
| Release channel | Stable                  |
| Action / access | `counterparties.manage` |
| Operation ID    | `updateCounterparty`    |

Updates counterparty attributes. At least one field must be provided. Use null on externalId to clear it.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Counterparties"
  ],
  "x-sdp-group": "Profiles",
  "summary": "Update counterparty",
  "operationId": "updateCounterparty",
  "description": "Updates counterparty attributes. At least one field must be provided. Use null on externalId to clear it.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema067"
      },
      "required": true,
      "description": "Counterparty identifier.",
      "name": "counterpartyId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema024"
      },
      "required": false,
      "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` with no `Retry-After`, as does every later retry with that key: read the resource with GET to see whether it ran, then send again with a new key. A 5xx is stored and replayed like any other answer; retry it with a new key.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema068"
        }
      }
    }
  },
  "responses": {
    "200": {
      "description": "Counterparty updated",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema065"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `counterparties.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e042"></a>

### E042: Archive counterparty

`DELETE /v1/counterparties/{counterpartyId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                   |
| --------------- | ----------------------- |
| Module          | `payments`              |
| Release channel | Stable                  |
| Action / access | `counterparties.manage` |
| Operation ID    | `archiveCounterparty`   |

Archives a counterparty. Archived counterparties are hidden from default lists.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Counterparties"
  ],
  "x-sdp-group": "Profiles",
  "summary": "Archive counterparty",
  "operationId": "archiveCounterparty",
  "description": "Archives a counterparty. Archived counterparties are hidden from default lists.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema067"
      },
      "required": true,
      "description": "Counterparty identifier.",
      "name": "counterpartyId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema024"
      },
      "required": false,
      "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` with no `Retry-After`, as does every later retry with that key: read the resource with GET to see whether it ran, then send again with a new key. A 5xx is stored and replayed like any other answer; retry it with a new key.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "responses": {
    "204": {
      "description": "Counterparty archived"
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `counterparties.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e043"></a>

### E043: List counterparty accounts

`GET /v1/counterparties/{counterpartyId}/accounts`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                      |
| --------------- | -------------------------- |
| Module          | `payments`                 |
| Release channel | Stable                     |
| Action / access | `counterparties.read`      |
| Operation ID    | `listCounterpartyAccounts` |

Lists payment accounts for a counterparty. Crypto-wallet accounts can be used by payment flows that send funds to a counterparty wallet.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Counterparties"
  ],
  "x-sdp-group": "Accounts",
  "summary": "List counterparty accounts",
  "operationId": "listCounterpartyAccounts",
  "description": "Lists payment accounts for a counterparty. Crypto-wallet accounts can be used by payment flows that send funds to a counterparty wallet.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema067"
      },
      "required": true,
      "description": "Counterparty identifier.",
      "name": "counterpartyId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema060"
      },
      "required": false,
      "description": "Page number (1-based).",
      "name": "page",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema061"
      },
      "required": false,
      "description": "Items per page (max 100).",
      "name": "pageSize",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema069"
      },
      "required": false,
      "description": "Include archived counterparty accounts in results.",
      "name": "includeArchived",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema070"
      },
      "required": false,
      "description": "Filter accounts by account kind.",
      "name": "accountKind",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Counterparty account list",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema071"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `counterparties.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e044"></a>

### E044: Create counterparty account

`POST /v1/counterparties/{counterpartyId}/accounts`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                       |
| --------------- | --------------------------- |
| Module          | `payments`                  |
| Release channel | Stable                      |
| Action / access | `counterparties.execute`    |
| Operation ID    | `createCounterpartyAccount` |

Creates a payment account for a counterparty. For accountKind "crypto_wallet", details.network must be "solana" and details.address must be a Solana wallet address.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Counterparties"
  ],
  "x-sdp-group": "Accounts",
  "summary": "Create counterparty account",
  "operationId": "createCounterpartyAccount",
  "description": "Creates a payment account for a counterparty. For accountKind \"crypto_wallet\", details.network must be \"solana\" and details.address must be a Solana wallet address.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema067"
      },
      "required": true,
      "description": "Counterparty identifier.",
      "name": "counterpartyId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema024"
      },
      "required": false,
      "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` with no `Retry-After`, as does every later retry with that key: read the resource with GET to see whether it ran, then send again with a new key. A 5xx is stored and replayed like any other answer; retry it with a new key.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema072"
        }
      }
    }
  },
  "responses": {
    "201": {
      "description": "Counterparty account created",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema073"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `counterparties.execute` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e045"></a>

### E045: Get counterparty account

`GET /v1/counterparties/{counterpartyId}/accounts/{counterpartyAccountId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                    |
| --------------- | ------------------------ |
| Module          | `payments`               |
| Release channel | Stable                   |
| Action / access | `counterparties.read`    |
| Operation ID    | `getCounterpartyAccount` |

Gets a counterparty payment account by id.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Counterparties"
  ],
  "x-sdp-group": "Accounts",
  "summary": "Get counterparty account",
  "operationId": "getCounterpartyAccount",
  "description": "Gets a counterparty payment account by id.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema067"
      },
      "required": true,
      "description": "Counterparty identifier.",
      "name": "counterpartyId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema074"
      },
      "required": true,
      "description": "Counterparty account identifier.",
      "name": "counterpartyAccountId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Counterparty account",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema073"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `counterparties.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e046"></a>

### E046: Update counterparty account

`PATCH /v1/counterparties/{counterpartyId}/accounts/{counterpartyAccountId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                       |
| --------------- | --------------------------- |
| Module          | `payments`                  |
| Release channel | Stable                      |
| Action / access | `counterparties.execute`    |
| Operation ID    | `updateCounterpartyAccount` |

Updates a counterparty payment account. At least one field must be provided.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Counterparties"
  ],
  "x-sdp-group": "Accounts",
  "summary": "Update counterparty account",
  "operationId": "updateCounterpartyAccount",
  "description": "Updates a counterparty payment account. At least one field must be provided.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema067"
      },
      "required": true,
      "description": "Counterparty identifier.",
      "name": "counterpartyId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema074"
      },
      "required": true,
      "description": "Counterparty account identifier.",
      "name": "counterpartyAccountId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema024"
      },
      "required": false,
      "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` with no `Retry-After`, as does every later retry with that key: read the resource with GET to see whether it ran, then send again with a new key. A 5xx is stored and replayed like any other answer; retry it with a new key.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema075"
        }
      }
    }
  },
  "responses": {
    "200": {
      "description": "Counterparty account updated",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema073"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `counterparties.execute` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e047"></a>

### E047: Archive counterparty account

`DELETE /v1/counterparties/{counterpartyId}/accounts/{counterpartyAccountId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                        |
| --------------- | ---------------------------- |
| Module          | `payments`                   |
| Release channel | Stable                       |
| Action / access | `counterparties.manage`      |
| Operation ID    | `archiveCounterpartyAccount` |

Archives a counterparty payment account. Archived accounts are hidden from default lists.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Counterparties"
  ],
  "x-sdp-group": "Accounts",
  "summary": "Archive counterparty account",
  "operationId": "archiveCounterpartyAccount",
  "description": "Archives a counterparty payment account. Archived accounts are hidden from default lists.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema067"
      },
      "required": true,
      "description": "Counterparty identifier.",
      "name": "counterpartyId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema074"
      },
      "required": true,
      "description": "Counterparty account identifier.",
      "name": "counterpartyAccountId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema024"
      },
      "required": false,
      "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` with no `Retry-After`, as does every later retry with that key: read the resource with GET to see whether it ran, then send again with a new key. A 5xx is stored and replayed like any other answer; retry it with a new key.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "responses": {
    "204": {
      "description": "Counterparty account archived"
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `counterparties.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>



## Transfer batches

| ID                     | Endpoint                                             | Verdict |
| ---------------------- | ---------------------------------------------------- | ------- |
| [E051](#endpoint-e051) | `GET /v1/payments/transfer-batches`                  | Pending |
| [E052](#endpoint-e052) | `POST /v1/payments/transfer-batches/execute`         | Pending |
| [E053](#endpoint-e053) | `POST /v1/payments/transfer-batches/estimate`        | Pending |
| [E054](#endpoint-e054) | `GET /v1/payments/transfer-batches/{batchId}`        | Pending |
| [E294](#endpoint-e294) | `POST /v1/payments/transfer-batches/{batchId}/retry` | Pending |

<a id="endpoint-e051"></a>

### E051: List transfer batches

`GET /v1/payments/transfer-batches`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                        |
| --------------- | ---------------------------- |
| Module          | `payments`                   |
| Release channel | Stable                       |
| Action / access | `transfer_batches.read`      |
| Operation ID    | `listPaymentTransferBatches` |

Lists transfer batches for the authenticated organization or project scope.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Transfer batches",
  "summary": "List transfer batches",
  "operationId": "listPaymentTransferBatches",
  "description": "Lists transfer batches for the authenticated organization or project scope.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema076"
      },
      "required": false,
      "description": "Filter by exact source SDP Wallet ID.",
      "name": "sourceCustodyWalletId",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema077"
      },
      "required": false,
      "description": "Filter by token symbol or mint.",
      "name": "token",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema078"
      },
      "required": false,
      "description": "Filter by transfer batch status.",
      "name": "status",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema079"
      },
      "required": false,
      "description": "Filter by caller-provided batch correlation ID.",
      "name": "externalId",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema060"
      },
      "required": false,
      "description": "Page number (1-based).",
      "name": "page",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema080"
      },
      "required": false,
      "description": "Number of batches per page.",
      "name": "pageSize",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Transfer batch list",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema081"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `transfer_batches.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e052"></a>

### E052: Create transfer batch

`POST /v1/payments/transfer-batches/execute`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                        |
| --------------- | ---------------------------- |
| Module          | `payments`                   |
| Release channel | Stable                       |
| Action / access | `transfer_batches.execute`   |
| Operation ID    | `createPaymentTransferBatch` |

Executes an outbound transfer batch from one exact SDP Wallet ID, chunks recipients into Solana transactions, and returns the batch, recipient, and transfer records. Requires an Idempotency-Key: a retry with the same key and request returns the original batch without another on-chain submission. Recipient order does not change the request. A native SOL batch is refused with 409 `AMOUNT_BELOW_RENT_MINIMUM`, before anything is written or sent, when a recipient whose address has no account gets less than the rent-exempt minimum (`details.recipientIndexes`) or the source wallet would be left holding more than nothing but less than the minimum (`details.sourceRemainder`). A token batch is refused with 409 `SPONSORED_RENT_OVER_CAP` when one recipient's new token account costs more rent than the sponsor funds in a transaction (`details.recipientIndex`). An `externalId` already used by a batch on the same project and source wallet never pays again: the same request from the same credential returns that batch, and any other returns `409 TRANSFER_BATCH_RUN_EXISTS` with its `batchId` in `error.details`. To finish a batch after a partial failure, call `POST /v1/payments/transfer-batches/{batchId}/retry`: it sends only the batch's `failed` recipients. Never resend the whole batch under a new Idempotency-Key, which pays the recipients that succeeded again.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Transfer batches",
  "summary": "Create transfer batch",
  "operationId": "createPaymentTransferBatch",
  "description": "Executes an outbound transfer batch from one exact SDP Wallet ID, chunks recipients into Solana transactions, and returns the batch, recipient, and transfer records. Requires an Idempotency-Key: a retry with the same key and request returns the original batch without another on-chain submission. Recipient order does not change the request. A native SOL batch is refused with 409 `AMOUNT_BELOW_RENT_MINIMUM`, before anything is written or sent, when a recipient whose address has no account gets less than the rent-exempt minimum (`details.recipientIndexes`) or the source wallet would be left holding more than nothing but less than the minimum (`details.sourceRemainder`). A token batch is refused with 409 `SPONSORED_RENT_OVER_CAP` when one recipient's new token account costs more rent than the sponsor funds in a transaction (`details.recipientIndex`). An `externalId` already used by a batch on the same project and source wallet never pays again: the same request from the same credential returns that batch, and any other returns `409 TRANSFER_BATCH_RUN_EXISTS` with its `batchId` in `error.details`. To finish a batch after a partial failure, call `POST /v1/payments/transfer-batches/{batchId}/retry`: it sends only the batch's `failed` recipients. Never resend the whole batch under a new Idempotency-Key, which pays the recipients that succeeded again.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema082"
      },
      "required": true,
      "description": "Required: a request without one returns 400 `IDEMPOTENCY_KEY_REQUIRED`. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then takes over and is answered from the record it wrote. Once the request has written its record, any answer below 500 is stored: a transfer that fails after that (such as 400 `TRANSACTION_FAILED` or a 409 signer mismatch) answers a same-key retry with the same error and `Idempotent-Replayed: true`, and after 24 hours the record answers with the same status and code. A 5xx is not stored: a same-key retry runs again and is answered from the record. To try again after a failure, send the request with a new key. After a 5xx, a retry with the same key runs again and answers from the original record instead of acting twice; that answer also carries `Idempotent-Replayed: true`.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema083"
        }
      }
    }
  },
  "responses": {
    "200": {
      "description": "Transfer batch created",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema084"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `transfer_batches.execute` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e053"></a>

### E053: Estimate transfer batch

`POST /v1/payments/transfer-batches/estimate`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                          |
| --------------- | ------------------------------ |
| Module          | `payments`                     |
| Release channel | Stable                         |
| Action / access | `transfer_batches.read`        |
| Operation ID    | `estimatePaymentTransferBatch` |

Validates an exact-wallet transfer batch request and estimates transaction chunking and fees. `warnings` lists what would make the batch fail: a native SOL amount below the rent-exempt minimum sent to an address with no account, or a source wallet left below the minimum; create refuses those with 409 `AMOUNT_BELOW_RENT_MINIMUM`.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Transfer batches",
  "summary": "Estimate transfer batch",
  "operationId": "estimatePaymentTransferBatch",
  "description": "Validates an exact-wallet transfer batch request and estimates transaction chunking and fees. `warnings` lists what would make the batch fail: a native SOL amount below the rent-exempt minimum sent to an address with no account, or a source wallet left below the minimum; create refuses those with 409 `AMOUNT_BELOW_RENT_MINIMUM`.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema085"
        }
      }
    }
  },
  "responses": {
    "200": {
      "description": "Transfer batch estimate",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema086"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `transfer_batches.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e054"></a>

### E054: Get transfer batch

`GET /v1/payments/transfer-batches/{batchId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                     |
| --------------- | ------------------------- |
| Module          | `payments`                |
| Release channel | Stable                    |
| Action / access | `transfer_batches.read`   |
| Operation ID    | `getPaymentTransferBatch` |

Retrieves a transfer batch with recipient rows and chunk transfer summaries.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Transfer batches",
  "summary": "Get transfer batch",
  "operationId": "getPaymentTransferBatch",
  "description": "Retrieves a transfer batch with recipient rows and chunk transfer summaries.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema087"
      },
      "required": true,
      "description": "Transfer batch identifier.",
      "name": "batchId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Transfer batch details",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema084"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `transfer_batches.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e294"></a>

### E294: Retry a transfer batch's failed recipients

`POST /v1/payments/transfer-batches/{batchId}/retry`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                       |
| --------------- | --------------------------- |
| Module          | `payments`                  |
| Release channel | Stable                      |
| Action / access | `transfer_batches.execute`  |
| Operation ID    | `retryPaymentTransferBatch` |

Sends the batch's `failed` recipients again, from the same source wallet with the batch's options, and no other recipient. A failed recipient was not paid: its transaction never reached the network or the network rejected it. Recipients still `pending` or `processing` may land and are never sent again. Each resent recipient keeps its row and links to its new chunk transfer. Takes no body and requires an Idempotency-Key: a retry with the same key sends nothing again: while its response is stored, it returns that saved response, and after a server error or once the response has expired, the batch as it stands. Read the batch's current state with `GET /v1/payments/transfer-batches/{batchId}`, and use a new key for each retry you mean to send. Any credential that may send from the batch's wallet can retry it. Each recipient is paid the address the batch recorded for it. Returns 409, sending nothing: `TRANSFER_BATCH_NOTHING_TO_RETRY` when the batch has no failed recipients (while it is `processing`, its unsent recipients become `failed` only once its request can no longer send them), `TRANSFER_BATCH_RETRY_CLAIMED` when a concurrent retry claimed them first, and `TRANSFER_BATCH_DESTINATION_CHANGED` (`details.recipientIds`) when a failed recipient's counterparty account has changed its address since (send that recipient in a new batch). A native SOL retry is refused with 409 `AMOUNT_BELOW_RENT_MINIMUM`, as create is, when a failed recipient would still be paid less than the rent-exempt minimum at an address with no account; its recipients stay `failed`. Only recipients that are still `failed` are ever sent, so a retry under a new key never pays anyone twice.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Transfer batches",
  "summary": "Retry a transfer batch's failed recipients",
  "operationId": "retryPaymentTransferBatch",
  "description": "Sends the batch's `failed` recipients again, from the same source wallet with the batch's options, and no other recipient. A failed recipient was not paid: its transaction never reached the network or the network rejected it. Recipients still `pending` or `processing` may land and are never sent again. Each resent recipient keeps its row and links to its new chunk transfer. Takes no body and requires an Idempotency-Key: a retry with the same key sends nothing again: while its response is stored, it returns that saved response, and after a server error or once the response has expired, the batch as it stands. Read the batch's current state with `GET /v1/payments/transfer-batches/{batchId}`, and use a new key for each retry you mean to send. Any credential that may send from the batch's wallet can retry it. Each recipient is paid the address the batch recorded for it. Returns 409, sending nothing: `TRANSFER_BATCH_NOTHING_TO_RETRY` when the batch has no failed recipients (while it is `processing`, its unsent recipients become `failed` only once its request can no longer send them), `TRANSFER_BATCH_RETRY_CLAIMED` when a concurrent retry claimed them first, and `TRANSFER_BATCH_DESTINATION_CHANGED` (`details.recipientIds`) when a failed recipient's counterparty account has changed its address since (send that recipient in a new batch). A native SOL retry is refused with 409 `AMOUNT_BELOW_RENT_MINIMUM`, as create is, when a failed recipient would still be paid less than the rent-exempt minimum at an address with no account; its recipients stay `failed`. Only recipients that are still `failed` are ever sent, so a retry under a new key never pays anyone twice.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema087"
      },
      "required": true,
      "description": "Transfer batch identifier.",
      "name": "batchId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema082"
      },
      "required": true,
      "description": "Required: a request without one returns 400 `IDEMPOTENCY_KEY_REQUIRED`. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then takes over and is answered from the record it wrote. Once the request has written its record, any answer below 500 is stored: a transfer that fails after that (such as 400 `TRANSACTION_FAILED` or a 409 signer mismatch) answers a same-key retry with the same error and `Idempotent-Replayed: true`, and after 24 hours the record answers with the same status and code. A 5xx is not stored: a same-key retry runs again and is answered from the record. To try again after a failure, send the request with a new key. After a 5xx, a retry with the same key runs again and answers from the original record instead of acting twice; that answer also carries `Idempotent-Replayed: true`.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Failed recipients resent",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema084"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `transfer_batches.execute` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>



## Transfers

| ID                     | Endpoint                                  | Verdict |
| ---------------------- | ----------------------------------------- | ------- |
| [E055](#endpoint-e055) | `GET /v1/payments/transfers`              | Pending |
| [E056](#endpoint-e056) | `POST /v1/payments/transfers/execute`     | Pending |
| [E057](#endpoint-e057) | `GET /v1/payments/transfers/{transferId}` | Pending |

<a id="endpoint-e055"></a>

### E055: List transfers

`GET /v1/payments/transfers`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                  |
| --------------- | ---------------------- |
| Module          | `payments`             |
| Release channel | Stable                 |
| Action / access | `transfers.read`       |
| Operation ID    | `listPaymentTransfers` |

Lists persisted payment transfers for the authenticated scope. Set custodyWalletId to select one exact SDP wallet; observed address history is opt-in with includeObserved=true.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Transfers",
  "summary": "List transfers",
  "operationId": "listPaymentTransfers",
  "description": "Lists persisted payment transfers for the authenticated scope. Set custodyWalletId to select one exact SDP wallet; observed address history is opt-in with includeObserved=true.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema088"
      },
      "required": false,
      "description": "Filter persisted transfers by exact SDP Wallet ID.",
      "name": "custodyWalletId",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema089"
      },
      "required": false,
      "description": "Search transfer ID, signature, provider reference, source or destination address, memo, counterparty ID, or counterparty display name. Use at least 3 non-whitespace characters; a blank value is treated as no search filter.",
      "name": "search",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema090"
      },
      "required": false,
      "description": "Filter by token symbol or mint.",
      "name": "token",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema091"
      },
      "required": false,
      "description": "Filter by transfer direction.",
      "name": "direction",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema092"
      },
      "required": false,
      "description": "Filter by transfer status. Accepts a comma-separated list of statuses.",
      "name": "status",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema093"
      },
      "required": false,
      "description": "Filter by wallet transfers or ramp transfers.",
      "name": "category",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema094"
      },
      "required": false,
      "description": "Filter by one or more comma-separated transfer types.",
      "name": "type",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema095"
      },
      "required": false,
      "description": "Filter transfers tied to a specific counterparty.",
      "name": "counterpartyId",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema096"
      },
      "required": false,
      "description": "Filter ramp transfers by provider.",
      "name": "provider",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema097"
      },
      "required": false,
      "description": "Provider quote or transaction reference. Must be supplied with provider for exact ramp transfer lookup.",
      "name": "providerReference",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema098"
      },
      "required": false,
      "description": "Filter from timestamp.",
      "name": "from",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema099"
      },
      "required": false,
      "description": "Filter to timestamp.",
      "name": "to",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema100"
      },
      "required": false,
      "description": "When custodyWalletId is supplied, also include RPC-observed activity for that exact wallet row's address. Observed rows have custodyWalletId null.",
      "name": "includeObserved",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema101"
      },
      "required": false,
      "description": "Field used to sort the transfer list.",
      "name": "sortBy",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema102"
      },
      "required": false,
      "description": "Sort direction.",
      "name": "sortDirection",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema060"
      },
      "required": false,
      "description": "Page number (1-based).",
      "name": "page",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema103"
      },
      "required": false,
      "description": "Items per page.",
      "name": "pageSize",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Transfer list",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema104"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `transfers.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e056"></a>

### E056: Execute a provider-signed transfer

`POST /v1/payments/transfers/execute`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                   |
| --------------- | ----------------------- |
| Module          | `payments`              |
| Release channel | Stable                  |
| Action / access | `transfers.execute`     |
| Operation ID    | `createPaymentTransfer` |

Executes an on-chain transfer using the exact SDP Wallet ID (`id` from `/v1/wallets`) and server-side signing through the connected provider. Requires an Idempotency-Key: a retry with the same key and request returns the original transfer instead of sending a second one. A 200 may return a processing transfer with its signature when broadcast or confirmation is still being reconciled; do not create a replacement transfer for that payment. A native SOL transfer is refused with 409 `AMOUNT_BELOW_RENT_MINIMUM`, before anything is written or sent, when it pays less than the rent-exempt minimum to an address with no account or would leave the source wallet holding more than nothing but less than the minimum.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Transfers",
  "summary": "Execute a provider-signed transfer",
  "operationId": "createPaymentTransfer",
  "description": "Executes an on-chain transfer using the exact SDP Wallet ID (`id` from `/v1/wallets`) and server-side signing through the connected provider. Requires an Idempotency-Key: a retry with the same key and request returns the original transfer instead of sending a second one. A 200 may return a processing transfer with its signature when broadcast or confirmation is still being reconciled; do not create a replacement transfer for that payment. A native SOL transfer is refused with 409 `AMOUNT_BELOW_RENT_MINIMUM`, before anything is written or sent, when it pays less than the rent-exempt minimum to an address with no account or would leave the source wallet holding more than nothing but less than the minimum.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema082"
      },
      "required": true,
      "description": "Required: a request without one returns 400 `IDEMPOTENCY_KEY_REQUIRED`. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then takes over and is answered from the record it wrote. Once the request has written its record, any answer below 500 is stored: a transfer that fails after that (such as 400 `TRANSACTION_FAILED` or a 409 signer mismatch) answers a same-key retry with the same error and `Idempotent-Replayed: true`, and after 24 hours the record answers with the same status and code. A 5xx is not stored: a same-key retry runs again and is answered from the record. To try again after a failure, send the request with a new key. After a 5xx, a retry with the same key runs again and answers from the original record instead of acting twice; that answer also carries `Idempotent-Replayed: true`.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema105"
        }
      }
    }
  },
  "responses": {
    "200": {
      "description": "Transfer executed",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema106"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `transfers.execute` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "503": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e057"></a>

### E057: Get transfer

`GET /v1/payments/transfers/{transferId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                |
| --------------- | -------------------- |
| Module          | `payments`           |
| Release channel | Stable               |
| Action / access | `transfers.read`     |
| Operation ID    | `getPaymentTransfer` |

Retrieves details for a specific transfer.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Transfers",
  "summary": "Get transfer",
  "operationId": "getPaymentTransfer",
  "description": "Retrieves details for a specific transfer.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema107"
      },
      "required": true,
      "description": "Transfer identifier (SDP record ID, not the on-chain signature).",
      "name": "transferId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Transfer details",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema106"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `transfers.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>



## Payments

| ID                     | Endpoint                                       | Verdict |
| ---------------------- | ---------------------------------------------- | ------- |
| [E058](#endpoint-e058) | `GET /v1/payments/wallets/{walletId}/balances` | Pending |

<a id="endpoint-e058"></a>

### E058: Get wallet balances

`GET /v1/payments/wallets/{walletId}/balances`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                      |
| --------------- | -------------------------- |
| Module          | `payments`                 |
| Release channel | Stable                     |
| Action / access | `wallets.read`             |
| Operation ID    | `getPaymentWalletBalances` |

Retrieves balances for a connected wallet. If any SOL or SPL balance read fails, returns 503 instead of partial or zero balances. Optional minimumSlot requires confirmed account state at or after that Solana slot; the response acknowledges the bound in data.balanceReadContext.minimumSlot. Wallet lifecycle and provisioning are managed through /v1/wallets.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Balances and transactions",
  "summary": "Get wallet balances",
  "operationId": "getPaymentWalletBalances",
  "description": "Retrieves balances for a connected wallet. If any SOL or SPL balance read fails, returns 503 instead of partial or zero balances. Optional minimumSlot requires confirmed account state at or after that Solana slot; the response acknowledges the bound in data.balanceReadContext.minimumSlot. Wallet lifecycle and provisioning are managed through /v1/wallets.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema108"
      },
      "required": true,
      "description": "Provider wallet ID — the `walletId` field returned by GET /v1/wallets. The wallet record `id` and the public key are not accepted.",
      "name": "walletId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema109"
      },
      "required": false,
      "name": "minimumSlot",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Wallet balances",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema110"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `wallets.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "503": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>



## Service and discovery

| ID                     | Endpoint               | Verdict |
| ---------------------- | ---------------------- | ------- |
| [E059](#endpoint-e059) | `GET /pay/{token}`     | Pending |
| [E060](#endpoint-e060) | `GET /pay/{token}/tx`  | Pending |
| [E061](#endpoint-e061) | `POST /pay/{token}/tx` | Pending |
| [E284](#endpoint-e284) | `GET /`                | Pending |
| [E285](#endpoint-e285) | `GET /docs`            | Pending |
| [E286](#endpoint-e286) | `GET /health`          | Pending |
| [E287](#endpoint-e287) | `GET /health/ready`    | Pending |
| [E288](#endpoint-e288) | `GET /llms.txt`        | Pending |
| [E289](#endpoint-e289) | `GET /openapi.json`    | Pending |

<a id="endpoint-e059"></a>

### E059: Get Payment Request

`GET /pay/{token}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                                                   |
| --------------- | ------------------------------------------------------- |
| Module          | `payments`                                              |
| Release channel | Stable                                                  |
| Action / access | payment link: the link's public token is the credential |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/pay/index.ts) · [handler](../../apps/sdp-api/src/routes/pay/handlers.ts)


<a id="endpoint-e060"></a>

### E060: Get Transaction Metadata

`GET /pay/{token}/tx`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                                                   |
| --------------- | ------------------------------------------------------- |
| Module          | `payments`                                              |
| Release channel | Stable                                                  |
| Action / access | payment link: the link's public token is the credential |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/pay/index.ts) · [handler](../../apps/sdp-api/src/routes/pay/handlers.ts)


<a id="endpoint-e061"></a>

### E061: Create Sponsored Transaction

`POST /pay/{token}/tx`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                                                   |
| --------------- | ------------------------------------------------------- |
| Module          | `payments`                                              |
| Release channel | Stable                                                  |
| Action / access | payment link: the link's public token is the credential |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/pay/index.ts) · [handler](../../apps/sdp-api/src/routes/pay/handlers.ts)


<a id="endpoint-e284"></a>

### E284: Root redirect

`GET /`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                               |
| --------------- | ----------------------------------- |
| Module          | `core`                              |
| Release channel | Stable                              |
| Action / access | root: redirects to the health check |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/app.ts) · [handler](../../apps/sdp-api/src/app.ts)


<a id="endpoint-e285"></a>

### E285: API reference page

`GET /docs`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value              |
| --------------- | ------------------ |
| Module          | `core`             |
| Release channel | Stable             |
| Action / access | API reference page |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/docs.ts) · [handler](../../apps/sdp-api/src/routes/docs.ts)


<a id="endpoint-e286"></a>

### E286: Health check

`GET /health`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value         |
| --------------- | ------------- |
| Module          | `core`        |
| Release channel | Stable        |
| Action / access | health check  |
| Operation ID    | `healthCheck` |

Returns service health and build metadata.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Health"
  ],
  "summary": "Health check",
  "operationId": "healthCheck",
  "description": "Returns service health and build metadata.",
  "responses": {
    "200": {
      "description": "Service is healthy",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema111"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e287"></a>

### E287: Readiness check

`GET /health/ready`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value             |
| --------------- | ----------------- |
| Module          | `core`            |
| Release channel | Stable            |
| Action / access | readiness check   |
| Operation ID    | `healthReadiness` |

Performs readiness checks for downstream dependencies.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Health"
  ],
  "summary": "Readiness check",
  "operationId": "healthReadiness",
  "description": "Performs readiness checks for downstream dependencies.",
  "responses": {
    "200": {
      "description": "Service is ready",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema112"
          }
        }
      }
    },
    "503": {
      "description": "Service is not ready",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema113"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e288"></a>

### E288: API discovery resource

`GET /llms.txt`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                 |
| --------------- | --------------------- |
| Module          | `core`                |
| Release channel | Stable                |
| Action / access | AI discovery resource |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/llms.ts) · [handler](../../apps/sdp-api/src/routes/llms.ts)


<a id="endpoint-e289"></a>

### E289: Public OpenAPI document

`GET /openapi.json`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                   |
| --------------- | ----------------------- |
| Module          | `core`                  |
| Release channel | Stable                  |
| Action / access | public OpenAPI document |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/openapi.ts) · [handler](../../apps/sdp-api/src/routes/openapi.ts)



## Payment requests

| ID                     | Endpoint                                                  | Verdict |
| ---------------------- | --------------------------------------------------------- | ------- |
| [E062](#endpoint-e062) | `GET /v1/payments/requests`                               | Pending |
| [E063](#endpoint-e063) | `POST /v1/payments/requests`                              | Pending |
| [E064](#endpoint-e064) | `GET /v1/payments/requests/{paymentRequestId}`            | Pending |
| [E065](#endpoint-e065) | `GET /v1/payments/requests/{paymentRequestId}/link-token` | Pending |
| [E295](#endpoint-e295) | `POST /v1/payments/requests/{paymentRequestId}/cancel`    | Pending |

<a id="endpoint-e062"></a>

### E062: List Payment Requests

`GET /v1/payments/requests`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                   |
| --------------- | ----------------------- |
| Module          | `payments`              |
| Release channel | Stable                  |
| Action / access | `payment_requests.read` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/payments/payment-requests/index.ts) · [handler](../../apps/sdp-api/src/routes/payments/payment-requests/handlers.ts)


<a id="endpoint-e063"></a>

### E063: Create Payment Request

`POST /v1/payments/requests`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                     |
| --------------- | ------------------------- |
| Module          | `payments`                |
| Release channel | Stable                    |
| Action / access | `payment_requests.manage` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/payments/payment-requests/index.ts) · [handler](../../apps/sdp-api/src/routes/payments/payment-requests/handlers.ts)


<a id="endpoint-e064"></a>

### E064: Get Payment Request

`GET /v1/payments/requests/{paymentRequestId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                   |
| --------------- | ----------------------- |
| Module          | `payments`              |
| Release channel | Stable                  |
| Action / access | `payment_requests.read` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/payments/payment-requests/index.ts) · [handler](../../apps/sdp-api/src/routes/payments/payment-requests/handlers.ts)


<a id="endpoint-e065"></a>

### E065: Get Payment Request Link

`GET /v1/payments/requests/{paymentRequestId}/link-token`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                     |
| --------------- | ------------------------- |
| Module          | `payments`                |
| Release channel | Stable                    |
| Action / access | `payment_requests.manage` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/payments/payment-requests/index.ts) · [handler](../../apps/sdp-api/src/routes/payments/payment-requests/handlers.ts)


<a id="endpoint-e295"></a>

### E295: Cancel payment request

`POST /v1/payments/requests/{paymentRequestId}/cancel`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                     |
| --------------- | ------------------------- |
| Module          | `payments`                |
| Release channel | Stable                    |
| Action / access | `payment_requests.manage` |
| Operation ID    | `cancelPaymentRequest`    |

Cancels an open payment request, so its payment link stops building and sponsoring transactions. Requires `payment_requests.manage`. Canceling a request that is already canceled returns it unchanged. A paid or expired request returns 409, and so does one whose fee-sponsored transaction can still land: retry once that transaction's blockhash expires. A payer who signed before the cancel can still land the payment; SDP records it as paid, with `paidLate` set when it landed after the cancel.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Payment requests",
  "summary": "Cancel payment request",
  "operationId": "cancelPaymentRequest",
  "description": "Cancels an open payment request, so its payment link stops building and sponsoring transactions. Requires `payment_requests.manage`. Canceling a request that is already canceled returns it unchanged. A paid or expired request returns 409, and so does one whose fee-sponsored transaction can still land: retry once that transaction's blockhash expires. A payer who signed before the cancel can still land the payment; SDP records it as paid, with `paidLate` set when it landed after the cancel.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema114"
      },
      "required": true,
      "description": "SDP payment request ID.",
      "name": "paymentRequestId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema023"
      },
      "required": false,
      "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` with no `Retry-After`, as does every later retry with that key: read the resource with GET to see whether it ran, then send again with a new key. After a 5xx, a retry with the same key runs again and answers from the original record instead of acting twice; that answer also carries `Idempotent-Replayed: true`.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Payment request canceled",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema115"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `payment_requests.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "502": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>



## Recurring payments

| ID                     | Endpoint                                             | Verdict |
| ---------------------- | ---------------------------------------------------- | ------- |
| [E066](#endpoint-e066) | `GET /v1/payments/recurring-payments`                | Pending |
| [E067](#endpoint-e067) | `POST /v1/payments/recurring-payments`               | Pending |
| [E068](#endpoint-e068) | `GET /v1/payments/recurring-payments/{id}`           | Pending |
| [E069](#endpoint-e069) | `PATCH /v1/payments/recurring-payments/{id}`         | Pending |
| [E070](#endpoint-e070) | `POST /v1/payments/recurring-payments/{id}/activate` | Pending |
| [E071](#endpoint-e071) | `POST /v1/payments/recurring-payments/{id}/cancel`   | Pending |
| [E072](#endpoint-e072) | `POST /v1/payments/recurring-payments/{id}/collect`  | Pending |
| [E073](#endpoint-e073) | `POST /v1/payments/recurring-payments/{id}/resume`   | Pending |

<a id="endpoint-e066"></a>

### E066: List recurring payments

`GET /v1/payments/recurring-payments`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                          |
| --------------- | ------------------------------ |
| Module          | `recurring_payments`           |
| Release channel | Stable                         |
| Action / access | `recurring.read`               |
| Operation ID    | `listPaymentRecurringPayments` |

Lists outbound recurring payments for the authenticated organization or project scope.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Recurring payments",
  "summary": "List recurring payments",
  "operationId": "listPaymentRecurringPayments",
  "description": "Lists outbound recurring payments for the authenticated organization or project scope.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema116"
      },
      "required": false,
      "description": "Filter recurring payments by counterparty.",
      "name": "counterpartyId",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema117"
      },
      "required": false,
      "description": "Recurring payment status.",
      "name": "status",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema118"
      },
      "required": false,
      "name": "page",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema119"
      },
      "required": false,
      "name": "pageSize",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Recurring payment list",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema120"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `recurring.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e067"></a>

### E067: Create recurring payment

`POST /v1/payments/recurring-payments`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                           |
| --------------- | ------------------------------- |
| Module          | `recurring_payments`            |
| Release channel | Stable                          |
| Action / access | `recurring.manage`              |
| Operation ID    | `createPaymentRecurringPayment` |

Creates an outbound recurring payment intent from a connected wallet to a counterparty crypto-wallet account. This stores backend state only; activation and collection are added by follow-up endpoints.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Recurring payments",
  "summary": "Create recurring payment",
  "operationId": "createPaymentRecurringPayment",
  "description": "Creates an outbound recurring payment intent from a connected wallet to a counterparty crypto-wallet account. This stores backend state only; activation and collection are added by follow-up endpoints.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema121"
      },
      "required": true,
      "description": "Required: a request without one returns 400 `IDEMPOTENCY_KEY_REQUIRED`. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then takes over and is answered from the record it wrote. After a 5xx, a retry with the same key runs again and answers from the original record instead of acting twice; that answer also carries `Idempotent-Replayed: true`.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema122"
        }
      }
    }
  },
  "responses": {
    "201": {
      "description": "Recurring payment created",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema123"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `recurring.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e068"></a>

### E068: Get recurring payment

`GET /v1/payments/recurring-payments/{id}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                        |
| --------------- | ---------------------------- |
| Module          | `recurring_payments`         |
| Release channel | Stable                       |
| Action / access | `recurring.read`             |
| Operation ID    | `getPaymentRecurringPayment` |

Retrieves an outbound recurring payment record.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Recurring payments",
  "summary": "Get recurring payment",
  "operationId": "getPaymentRecurringPayment",
  "description": "Retrieves an outbound recurring payment record.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema124"
      },
      "required": true,
      "description": "SDP recurring payment record ID.",
      "name": "id",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Recurring payment",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema123"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `recurring.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e069"></a>

### E069: Update recurring payment

`PATCH /v1/payments/recurring-payments/{id}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                           |
| --------------- | ------------------------------- |
| Module          | `recurring_payments`            |
| Release channel | Stable                          |
| Action / access | `recurring.execute`             |
| Operation ID    | `updatePaymentRecurringPayment` |

Updates a recurring payment. Pending records are updated directly. Active metadata and due-date edits are applied in place, while active term, source, destination, or token edits create a replacement Solana subscription, authorize it, cancel the old subscription, and then swap the recurring payment to the replacement records. Requires an Idempotency-Key, because an edit can sign and broadcast a replacement subscription. A same-key retry of a completed edit replays its answer. A retry of an interrupted edit gets 409 IDEMPOTENCY_KEY_IN_FLIGHT with Retry-After until the attempt is stale, then resumes from the last step SDP recorded. If a step was sent but not yet recorded when the edit was interrupted, which is rare, the retry can fail or send that step again, so read the recurring payment with GET before editing it again.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Recurring payments",
  "summary": "Update recurring payment",
  "operationId": "updatePaymentRecurringPayment",
  "description": "Updates a recurring payment. Pending records are updated directly. Active metadata and due-date edits are applied in place, while active term, source, destination, or token edits create a replacement Solana subscription, authorize it, cancel the old subscription, and then swap the recurring payment to the replacement records. Requires an Idempotency-Key, because an edit can sign and broadcast a replacement subscription. A same-key retry of a completed edit replays its answer. A retry of an interrupted edit gets 409 IDEMPOTENCY_KEY_IN_FLIGHT with Retry-After until the attempt is stale, then resumes from the last step SDP recorded. If a step was sent but not yet recorded when the edit was interrupted, which is rare, the retry can fail or send that step again, so read the recurring payment with GET before editing it again.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema124"
      },
      "required": true,
      "description": "SDP recurring payment record ID.",
      "name": "id",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema121"
      },
      "required": true,
      "description": "Required: a request without one returns 400 `IDEMPOTENCY_KEY_REQUIRED`. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then takes over and is answered from the record it wrote. After a 5xx, a retry with the same key runs again and answers from the original record instead of acting twice; that answer also carries `Idempotent-Replayed: true`.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema125"
        }
      }
    }
  },
  "responses": {
    "200": {
      "description": "Recurring payment updated",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema123"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `recurring.execute` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e070"></a>

### E070: Activate recurring payment

`POST /v1/payments/recurring-payments/{id}/activate`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                             |
| --------------- | --------------------------------- |
| Module          | `recurring_payments`              |
| Release channel | Stable                            |
| Action / access | `recurring.execute`               |
| Operation ID    | `activatePaymentRecurringPayment` |

Activates a pending recurring payment by creating the Solana subscriptions plan, authorizing the subscription, and storing the resulting on-chain identifiers and signatures. The source wallet gives the Subscriptions program's authority for that token an approval of 0, and each collection approves exactly its own amount in the same transaction as the pull, so the token program's `Approve` instruction appears in activation and collection transactions. If your custody provider's wallet policy allowlists programs or instructions, allow `Approve` to that authority, or the provider refuses the collection and SDP pauses the recurring payment with `pausedReason` `custody_policy_refused`.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Recurring payments",
  "summary": "Activate recurring payment",
  "operationId": "activatePaymentRecurringPayment",
  "description": "Activates a pending recurring payment by creating the Solana subscriptions plan, authorizing the subscription, and storing the resulting on-chain identifiers and signatures. The source wallet gives the Subscriptions program's authority for that token an approval of 0, and each collection approves exactly its own amount in the same transaction as the pull, so the token program's `Approve` instruction appears in activation and collection transactions. If your custody provider's wallet policy allowlists programs or instructions, allow `Approve` to that authority, or the provider refuses the collection and SDP pauses the recurring payment with `pausedReason` `custody_policy_refused`.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema124"
      },
      "required": true,
      "description": "SDP recurring payment record ID.",
      "name": "id",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema121"
      },
      "required": true,
      "description": "Required: a request without one returns 400 `IDEMPOTENCY_KEY_REQUIRED`. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then takes over and is answered from the record it wrote. After a 5xx, a retry with the same key runs again and answers from the original record instead of acting twice; that answer also carries `Idempotent-Replayed: true`.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Recurring payment activated",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema123"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `recurring.execute` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e071"></a>

### E071: Cancel recurring payment

`POST /v1/payments/recurring-payments/{id}/cancel`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                           |
| --------------- | ------------------------------- |
| Module          | `recurring_payments`            |
| Release channel | Stable                          |
| Action / access | `recurring.manage`              |
| Operation ID    | `cancelPaymentRecurringPayment` |

Permanently stops an active or paused recurring payment by submitting the Solana subscriptions immediate cancellation, which ends its on-chain subscription at once rather than at the end of the billing period. A canceled recurring payment never collects or resumes again. Every recurring payment from one wallet in one token relies on one token approval. When no other live recurring payment uses it, it is revoked right after the cancel; otherwise it stays for the schedules that still use it. The response's `tokenApproval` says which: `revoked`, `kept` with the recurring payments still using it in `sharedWith`, or `revoking` while a collection that was already processing settles, after which the background sweep revokes it. GET returns the same `tokenApproval` for a canceled recurring payment.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Recurring payments",
  "summary": "Cancel recurring payment",
  "operationId": "cancelPaymentRecurringPayment",
  "description": "Permanently stops an active or paused recurring payment by submitting the Solana subscriptions immediate cancellation, which ends its on-chain subscription at once rather than at the end of the billing period. A canceled recurring payment never collects or resumes again. Every recurring payment from one wallet in one token relies on one token approval. When no other live recurring payment uses it, it is revoked right after the cancel; otherwise it stays for the schedules that still use it. The response's `tokenApproval` says which: `revoked`, `kept` with the recurring payments still using it in `sharedWith`, or `revoking` while a collection that was already processing settles, after which the background sweep revokes it. GET returns the same `tokenApproval` for a canceled recurring payment.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema124"
      },
      "required": true,
      "description": "SDP recurring payment record ID.",
      "name": "id",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema121"
      },
      "required": true,
      "description": "Required: a request without one returns 400 `IDEMPOTENCY_KEY_REQUIRED`. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then takes over and is answered from the record it wrote. After a 5xx, a retry with the same key runs again and answers from the original record instead of acting twice; that answer also carries `Idempotent-Replayed: true`.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Recurring payment canceled",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema123"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `recurring.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e072"></a>

### E072: Collect recurring payment

`POST /v1/payments/recurring-payments/{id}/collect`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                            |
| --------------- | -------------------------------- |
| Module          | `recurring_payments`             |
| Release channel | Stable                           |
| Action / access | `recurring.execute`              |
| Operation ID    | `collectPaymentRecurringPayment` |

Manually starts a due active recurring payment collection, creating a linked payment transfer and collection attempt. If submission cannot be confirmed immediately, a 200 response returns the same transfer as `processing` with its known signature; reconciliation settles it, and the next due time advances only after exact on-chain confirmation.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Recurring payments",
  "summary": "Collect recurring payment",
  "operationId": "collectPaymentRecurringPayment",
  "description": "Manually starts a due active recurring payment collection, creating a linked payment transfer and collection attempt. If submission cannot be confirmed immediately, a 200 response returns the same transfer as `processing` with its known signature; reconciliation settles it, and the next due time advances only after exact on-chain confirmation.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema124"
      },
      "required": true,
      "description": "SDP recurring payment record ID.",
      "name": "id",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema121"
      },
      "required": true,
      "description": "Required: a request without one returns 400 `IDEMPOTENCY_KEY_REQUIRED`. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then takes over and is answered from the record it wrote. After a 5xx, a retry with the same key runs again and answers from the original record instead of acting twice; that answer also carries `Idempotent-Replayed: true`.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Recurring payment collection result",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema126"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `recurring.execute` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e073"></a>

### E073: Resume recurring payment

`POST /v1/payments/recurring-payments/{id}/resume`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                           |
| --------------- | ------------------------------- |
| Module          | `recurring_payments`            |
| Release channel | Stable                          |
| Action / access | `recurring.execute`             |
| Operation ID    | `resumePaymentRecurringPayment` |

Resumes a paused recurring payment. SDP pauses a recurring payment when a due period fails 5 times, or at once when the custody provider's policy refuses to sign a collection. Its on-chain subscription is still in place, so nothing is signed: the recurring payment returns to active, the failure count starts again, and a due period that has already ended moves to the next one. A canceled recurring payment cannot be resumed.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Recurring payments",
  "summary": "Resume recurring payment",
  "operationId": "resumePaymentRecurringPayment",
  "description": "Resumes a paused recurring payment. SDP pauses a recurring payment when a due period fails 5 times, or at once when the custody provider's policy refuses to sign a collection. Its on-chain subscription is still in place, so nothing is signed: the recurring payment returns to active, the failure count starts again, and a due period that has already ended moves to the next one. A canceled recurring payment cannot be resumed.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema124"
      },
      "required": true,
      "description": "SDP recurring payment record ID.",
      "name": "id",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema121"
      },
      "required": true,
      "description": "Required: a request without one returns 400 `IDEMPOTENCY_KEY_REQUIRED`. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then takes over and is answered from the record it wrote. After a 5xx, a retry with the same key runs again and answers from the original record instead of acting twice; that answer also carries `Idempotent-Replayed: true`.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Recurring payment resumed",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema123"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `recurring.execute` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>



## Subscriptions

| ID                     | Endpoint                                                                                | Verdict |
| ---------------------- | --------------------------------------------------------------------------------------- | ------- |
| [E074](#endpoint-e074) | `GET /v1/payments/subscription-plans`                                                   | Pending |
| [E075](#endpoint-e075) | `POST /v1/payments/subscription-plans`                                                  | Pending |
| [E076](#endpoint-e076) | `GET /v1/payments/subscription-plans/{planId}`                                          | Pending |
| [E077](#endpoint-e077) | `PATCH /v1/payments/subscription-plans/{planId}`                                        | Pending |
| [E078](#endpoint-e078) | `POST /v1/payments/subscription-plans/{planId}/create/build-unsigned-transaction`       | Pending |
| [E079](#endpoint-e079) | `GET /v1/payments/subscriptions`                                                        | Pending |
| [E080](#endpoint-e080) | `POST /v1/payments/subscriptions`                                                       | Pending |
| [E081](#endpoint-e081) | `GET /v1/payments/subscriptions/{subscriptionId}`                                       | Pending |
| [E082](#endpoint-e082) | `GET /v1/payments/subscriptions/{subscriptionId}/collection-attempts`                   | Pending |
| [E083](#endpoint-e083) | `POST /v1/payments/subscriptions/{subscriptionId}/authorize/build-unsigned-transaction` | Pending |
| [E084](#endpoint-e084) | `POST /v1/payments/subscriptions/{subscriptionId}/cancel/build-unsigned-transaction`    | Pending |
| [E085](#endpoint-e085) | `POST /v1/payments/subscriptions/{subscriptionId}/collect/build-unsigned-transaction`   | Pending |
| [E086](#endpoint-e086) | `POST /v1/payments/subscriptions/{subscriptionId}/resume/build-unsigned-transaction`    | Pending |

<a id="endpoint-e074"></a>

### E074: List subscription plans

`GET /v1/payments/subscription-plans`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                          |
| --------------- | ------------------------------ |
| Module          | `recurring_payments`           |
| Release channel | Stable                         |
| Action / access | `recurring.read`               |
| Operation ID    | `listPaymentSubscriptionPlans` |

Lists recurring-payment subscription plans.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Subscription plans",
  "summary": "List subscription plans",
  "operationId": "listPaymentSubscriptionPlans",
  "description": "Lists recurring-payment subscription plans.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema127"
      },
      "required": false,
      "description": "Subscription plan status.",
      "name": "status",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema118"
      },
      "required": false,
      "name": "page",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema119"
      },
      "required": false,
      "name": "pageSize",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Subscription plan list",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema128"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `recurring.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e075"></a>

### E075: Create subscription plan

`POST /v1/payments/subscription-plans`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                           |
| --------------- | ------------------------------- |
| Module          | `recurring_payments`            |
| Release channel | Stable                          |
| Action / access | `recurring.manage`              |
| Operation ID    | `createPaymentSubscriptionPlan` |

Creates a recurring-payment subscription plan record. This stores SDP backend state and Solana subscriptions program identifiers; it does not by itself create the on-chain plan.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Subscription plans",
  "summary": "Create subscription plan",
  "operationId": "createPaymentSubscriptionPlan",
  "description": "Creates a recurring-payment subscription plan record. This stores SDP backend state and Solana subscriptions program identifiers; it does not by itself create the on-chain plan.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema024"
      },
      "required": false,
      "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` with no `Retry-After`, as does every later retry with that key: read the resource with GET to see whether it ran, then send again with a new key. A 5xx is stored and replayed like any other answer; retry it with a new key.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema129"
        }
      }
    }
  },
  "responses": {
    "201": {
      "description": "Subscription plan created",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema130"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `recurring.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e076"></a>

### E076: Get subscription plan

`GET /v1/payments/subscription-plans/{planId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                        |
| --------------- | ---------------------------- |
| Module          | `recurring_payments`         |
| Release channel | Stable                       |
| Action / access | `recurring.read`             |
| Operation ID    | `getPaymentSubscriptionPlan` |

Retrieves a recurring-payment subscription plan record.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Subscription plans",
  "summary": "Get subscription plan",
  "operationId": "getPaymentSubscriptionPlan",
  "description": "Retrieves a recurring-payment subscription plan record.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema131"
      },
      "required": true,
      "description": "SDP subscription plan record ID.",
      "name": "planId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Subscription plan",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema130"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `recurring.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e077"></a>

### E077: Update subscription plan

`PATCH /v1/payments/subscription-plans/{planId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                           |
| --------------- | ------------------------------- |
| Module          | `recurring_payments`            |
| Release channel | Stable                          |
| Action / access | `recurring.execute`             |
| Operation ID    | `updatePaymentSubscriptionPlan` |

Updates mutable subscription plan fields and on-chain identifiers.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Subscription plans",
  "summary": "Update subscription plan",
  "operationId": "updatePaymentSubscriptionPlan",
  "description": "Updates mutable subscription plan fields and on-chain identifiers.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema131"
      },
      "required": true,
      "description": "SDP subscription plan record ID.",
      "name": "planId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema024"
      },
      "required": false,
      "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` with no `Retry-After`, as does every later retry with that key: read the resource with GET to see whether it ran, then send again with a new key. A 5xx is stored and replayed like any other answer; retry it with a new key.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema132"
        }
      }
    }
  },
  "responses": {
    "200": {
      "description": "Subscription plan updated",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema130"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `recurring.execute` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e078"></a>

### E078: Prepare subscription plan creation

`POST /v1/payments/subscription-plans/{planId}/create/build-unsigned-transaction`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                                  |
| --------------- | -------------------------------------- |
| Module          | `recurring_payments`                   |
| Release channel | Stable                                 |
| Action / access | `recurring.manage`                     |
| Operation ID    | `preparePaymentSubscriptionPlanCreate` |

Prepares an unsigned Solana subscriptions program create-plan transaction from an SDP subscription plan. This derives and stores the plan PDA but does not submit the transaction.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Subscription plans",
  "summary": "Prepare subscription plan creation",
  "operationId": "preparePaymentSubscriptionPlanCreate",
  "description": "Prepares an unsigned Solana subscriptions program create-plan transaction from an SDP subscription plan. This derives and stores the plan PDA but does not submit the transaction.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema131"
      },
      "required": true,
      "description": "SDP subscription plan record ID.",
      "name": "planId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": false,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema133"
        }
      }
    }
  },
  "responses": {
    "200": {
      "description": "Subscription plan creation prepared",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema134"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `recurring.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e079"></a>

### E079: List subscriptions

`GET /v1/payments/subscriptions`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                      |
| --------------- | -------------------------- |
| Module          | `recurring_payments`       |
| Release channel | Stable                     |
| Action / access | `recurring.read`           |
| Operation ID    | `listPaymentSubscriptions` |

Lists recurring-payment subscriptions.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Subscriptions",
  "summary": "List subscriptions",
  "operationId": "listPaymentSubscriptions",
  "description": "Lists recurring-payment subscriptions.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema135"
      },
      "required": false,
      "name": "planId",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema135"
      },
      "required": false,
      "name": "counterpartyId",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema136"
      },
      "required": false,
      "description": "Subscription status.",
      "name": "status",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema137"
      },
      "required": false,
      "name": "dueBefore",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema118"
      },
      "required": false,
      "name": "page",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema119"
      },
      "required": false,
      "name": "pageSize",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Subscription list",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema138"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `recurring.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e080"></a>

### E080: Create subscription

`POST /v1/payments/subscriptions`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                       |
| --------------- | --------------------------- |
| Module          | `recurring_payments`        |
| Release channel | Stable                      |
| Action / access | `recurring.manage`          |
| Operation ID    | `createPaymentSubscription` |

Creates a recurring-payment subscription record tied to a counterparty. The customer must still sign the Solana subscription authorization transaction. The subscriber must be the customer's own wallet: a subscriber that is one of the organization's SDP wallets answers 409, because to pay on a schedule from an SDP wallet you create a recurring payment, which keeps the wallet's token approval bounded.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Subscriptions",
  "summary": "Create subscription",
  "operationId": "createPaymentSubscription",
  "description": "Creates a recurring-payment subscription record tied to a counterparty. The customer must still sign the Solana subscription authorization transaction. The subscriber must be the customer's own wallet: a subscriber that is one of the organization's SDP wallets answers 409, because to pay on a schedule from an SDP wallet you create a recurring payment, which keeps the wallet's token approval bounded.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema024"
      },
      "required": false,
      "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` with no `Retry-After`, as does every later retry with that key: read the resource with GET to see whether it ran, then send again with a new key. A 5xx is stored and replayed like any other answer; retry it with a new key.",
      "name": "Idempotency-Key",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema139"
        }
      }
    }
  },
  "responses": {
    "201": {
      "description": "Subscription created",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema140"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `recurring.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "422": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e081"></a>

### E081: Get subscription

`GET /v1/payments/subscriptions/{subscriptionId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                    |
| --------------- | ------------------------ |
| Module          | `recurring_payments`     |
| Release channel | Stable                   |
| Action / access | `recurring.read`         |
| Operation ID    | `getPaymentSubscription` |

Retrieves a recurring-payment subscription record.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Subscriptions",
  "summary": "Get subscription",
  "operationId": "getPaymentSubscription",
  "description": "Retrieves a recurring-payment subscription record.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema141"
      },
      "required": true,
      "description": "SDP subscription record ID.",
      "name": "subscriptionId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Subscription",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema140"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `recurring.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e082"></a>

### E082: List subscription collection attempts

`GET /v1/payments/subscriptions/{subscriptionId}/collection-attempts`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                                       |
| --------------- | ------------------------------------------- |
| Module          | `recurring_payments`                        |
| Release channel | Stable                                      |
| Action / access | `recurring.read`                            |
| Operation ID    | `listPaymentSubscriptionCollectionAttempts` |

Lists collection attempts for a recurring-payment subscription.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Subscriptions",
  "summary": "List subscription collection attempts",
  "operationId": "listPaymentSubscriptionCollectionAttempts",
  "description": "Lists collection attempts for a recurring-payment subscription.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema141"
      },
      "required": true,
      "description": "SDP subscription record ID.",
      "name": "subscriptionId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema142"
      },
      "required": false,
      "description": "Collection attempt status.",
      "name": "status",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema118"
      },
      "required": false,
      "name": "page",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema119"
      },
      "required": false,
      "name": "pageSize",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Collection attempt list",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema143"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `recurring.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e083"></a>

### E083: Prepare subscription authorization

`POST /v1/payments/subscriptions/{subscriptionId}/authorize/build-unsigned-transaction`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                                     |
| --------------- | ----------------------------------------- |
| Module          | `recurring_payments`                      |
| Release channel | Stable                                    |
| Action / access | `recurring.execute`                       |
| Operation ID    | `preparePaymentSubscriptionAuthorization` |

Prepares the subscriber-signed Solana transaction that initializes the subscription authority and subscribes to the plan. The transaction must still be signed and submitted by the client. A subscriber that is one of the organization's SDP wallets answers 409: pay from an SDP wallet through a recurring payment.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Subscriptions",
  "summary": "Prepare subscription authorization",
  "operationId": "preparePaymentSubscriptionAuthorization",
  "description": "Prepares the subscriber-signed Solana transaction that initializes the subscription authority and subscribes to the plan. The transaction must still be signed and submitted by the client. A subscriber that is one of the organization's SDP wallets answers 409: pay from an SDP wallet through a recurring payment.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema141"
      },
      "required": true,
      "description": "SDP subscription record ID.",
      "name": "subscriptionId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema144"
        }
      }
    }
  },
  "responses": {
    "200": {
      "description": "Subscription authorization prepared",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema145"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `recurring.execute` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e084"></a>

### E084: Prepare subscription cancellation

`POST /v1/payments/subscriptions/{subscriptionId}/cancel/build-unsigned-transaction`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                              |
| --------------- | ---------------------------------- |
| Module          | `recurring_payments`               |
| Release channel | Stable                             |
| Action / access | `recurring.manage`                 |
| Operation ID    | `preparePaymentSubscriptionCancel` |

Prepares the subscriber-signed Solana transaction that cancels a subscription. The transaction must still be signed and submitted by the client.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Subscriptions",
  "summary": "Prepare subscription cancellation",
  "operationId": "preparePaymentSubscriptionCancel",
  "description": "Prepares the subscriber-signed Solana transaction that cancels a subscription. The transaction must still be signed and submitted by the client.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema141"
      },
      "required": true,
      "description": "SDP subscription record ID.",
      "name": "subscriptionId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": false,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema146"
        }
      }
    }
  },
  "responses": {
    "200": {
      "description": "Subscription cancellation prepared",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema147"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `recurring.manage` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e085"></a>

### E085: Prepare subscription collection

`POST /v1/payments/subscriptions/{subscriptionId}/collect/build-unsigned-transaction`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                                  |
| --------------- | -------------------------------------- |
| Module          | `recurring_payments`                   |
| Release channel | Stable                                 |
| Action / access | `recurring.execute`                    |
| Operation ID    | `preparePaymentSubscriptionCollection` |

Prepares the collector-signed Solana subscriptions transfer transaction for an active subscription. The transaction must still be signed and submitted by the collector/fee-payer flow. A subscription that belongs to a recurring payment, or whose subscriber is one of the organization's SDP wallets, answers 409: SDP collects from an SDP wallet only through a recurring payment.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Subscriptions",
  "summary": "Prepare subscription collection",
  "operationId": "preparePaymentSubscriptionCollection",
  "description": "Prepares the collector-signed Solana subscriptions transfer transaction for an active subscription. The transaction must still be signed and submitted by the collector/fee-payer flow. A subscription that belongs to a recurring payment, or whose subscriber is one of the organization's SDP wallets, answers 409: SDP collects from an SDP wallet only through a recurring payment.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema141"
      },
      "required": true,
      "description": "SDP subscription record ID.",
      "name": "subscriptionId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema148"
        }
      }
    }
  },
  "responses": {
    "200": {
      "description": "Subscription collection prepared",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema149"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `recurring.execute` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e086"></a>

### E086: Prepare subscription resume

`POST /v1/payments/subscriptions/{subscriptionId}/resume/build-unsigned-transaction`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                              |
| --------------- | ---------------------------------- |
| Module          | `recurring_payments`               |
| Release channel | Stable                             |
| Action / access | `recurring.execute`                |
| Operation ID    | `preparePaymentSubscriptionResume` |

Prepares the subscriber-signed Solana transaction that resumes a canceled subscription before revocation. The transaction must still be signed and submitted by the client. A subscription that belongs to a recurring payment answers 409: a recurring payment's cancel is final.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Subscriptions",
  "summary": "Prepare subscription resume",
  "operationId": "preparePaymentSubscriptionResume",
  "description": "Prepares the subscriber-signed Solana transaction that resumes a canceled subscription before revocation. The transaction must still be signed and submitted by the client. A subscription that belongs to a recurring payment answers 409: a recurring payment's cancel is final.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema141"
      },
      "required": true,
      "description": "SDP subscription record ID.",
      "name": "subscriptionId",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": false,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema146"
        }
      }
    }
  },
  "responses": {
    "200": {
      "description": "Subscription resume prepared",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema147"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `recurring.execute` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>



## Transactions

| ID                     | Endpoint               | Verdict |
| ---------------------- | ---------------------- | ------- |
| [E095](#endpoint-e095) | `GET /v1/transactions` | Pending |

<a id="endpoint-e095"></a>

### E095: List transactions

`GET /v1/transactions`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                     |
| --------------- | ------------------------- |
| Module          | `payments`                |
| Release channel | Stable                    |
| Action / access | `transactions.read`       |
| Operation ID    | `listUnifiedTransactions` |

Lists the project's transactions across SDP modules with stable cursor pagination. Requires `transactions.read`. Every row also needs the `read` action of the module it comes from (which its `manage` or `execute` includes): a Payments row needs `transfers.read` for a transfer or deposit, `transfer_batches.read` for a batch item, `recurring.read` for a recurring collection, `payment_requests.read` for a payment request's fulfilment, and `onramp.read` or `offramp.read` for a ramp transfer; every other module's rows need that module's `read`. Rows the caller cannot read are left out. Requesting a module, or a Payments `kind`, without its action returns 403 INSUFFICIENT_PERMISSIONS naming it. `search` matches transaction id, module id, or signature as a prefix, not a substring. The endpoint is metered (60/min per credential, 240/min per organization); exceeding the quota returns 429, and 503 indicates the quota backend was unavailable.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Payments"
  ],
  "x-sdp-group": "Balances and transactions",
  "summary": "List transactions",
  "operationId": "listUnifiedTransactions",
  "description": "Lists the project's transactions across SDP modules with stable cursor pagination. Requires `transactions.read`. Every row also needs the `read` action of the module it comes from (which its `manage` or `execute` includes): a Payments row needs `transfers.read` for a transfer or deposit, `transfer_batches.read` for a batch item, `recurring.read` for a recurring collection, `payment_requests.read` for a payment request's fulfilment, and `onramp.read` or `offramp.read` for a ramp transfer; every other module's rows need that module's `read`. Rows the caller cannot read are left out. Requesting a module, or a Payments `kind`, without its action returns 403 INSUFFICIENT_PERMISSIONS naming it. `search` matches transaction id, module id, or signature as a prefix, not a substring. The endpoint is metered (60/min per credential, 240/min per organization); exceeding the quota returns 429, and 503 indicates the quota backend was unavailable.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema150"
      },
      "required": false,
      "name": "module",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema151"
      },
      "required": false,
      "name": "kind",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema152"
      },
      "required": false,
      "name": "status",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema153"
      },
      "required": false,
      "name": "custodyWalletId",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema153"
      },
      "required": false,
      "name": "counterpartyId",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema153"
      },
      "required": false,
      "name": "token",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema154"
      },
      "required": false,
      "description": "Prefix match against transaction id, module id, or signature — not a substring search.",
      "name": "search",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema137"
      },
      "required": false,
      "name": "createdAtFrom",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema137"
      },
      "required": false,
      "name": "createdAtTo",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema151"
      },
      "required": false,
      "name": "cursor",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema155"
      },
      "required": false,
      "name": "limit",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Unified transactions",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema156"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Forbidden. Requires the `transactions.read` action: an API key must hold it (a module's `manage` or `execute` also covers its `read`), and a signed-in member's organization role must include it. Without it the error is INSUFFICIENT_PERMISSIONS and `error.details.action` names the action. Any other 403 names its own reason.",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "429": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "503": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>



## Places

| ID                     | Endpoint                       | Verdict |
| ---------------------- | ------------------------------ | ------- |
| [E250](#endpoint-e250) | `POST /v1/places/autocomplete` | Pending |
| [E251](#endpoint-e251) | `GET /v1/places/static-map`    | Pending |
| [E252](#endpoint-e252) | `GET /v1/places/{placeId}`     | Pending |

<a id="endpoint-e250"></a>

### E250: Autocomplete

`POST /v1/places/autocomplete`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                   |
| --------------- | ----------------------- |
| Module          | `core`                  |
| Release channel | Stable                  |
| Action / access | `counterparties.manage` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/places/index.ts) · [handler](../../apps/sdp-api/src/routes/places/handlers.ts)


<a id="endpoint-e251"></a>

### E251: Get Static Map

`GET /v1/places/static-map`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                   |
| --------------- | ----------------------- |
| Module          | `core`                  |
| Release channel | Stable                  |
| Action / access | `counterparties.manage` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/places/index.ts) · [handler](../../apps/sdp-api/src/routes/places/handlers.ts)


<a id="endpoint-e252"></a>

### E252: Get Place

`GET /v1/places/{placeId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                   |
| --------------- | ----------------------- |
| Module          | `core`                  |
| Release channel | Stable                  |
| Action / access | `counterparties.manage` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/places/index.ts) · [handler](../../apps/sdp-api/src/routes/places/handlers.ts)



## Dashboard helpers

| ID                     | Endpoint                                                                                   | Verdict |
| ---------------------- | ------------------------------------------------------------------------------------------ | ------- |
| [E253](#endpoint-e253) | `GET /internal/dashboard/custody/connections`                                              | Pending |
| [E254](#endpoint-e254) | `GET /internal/dashboard/custody/connections/{connectionId}`                               | Pending |
| [E255](#endpoint-e255) | `POST /internal/dashboard/custody/connections/{connectionId}/cancel-installation`          | Pending |
| [E256](#endpoint-e256) | `POST /internal/dashboard/custody/connections/{connectionId}/complete-installation`        | Pending |
| [E257](#endpoint-e257) | `POST /internal/dashboard/custody/connections/{connectionId}/deactivate`                   | Pending |
| [E258](#endpoint-e258) | `GET /internal/dashboard/custody/connections/{connectionId}/provider-credential/lifecycle` | Pending |
| [E259](#endpoint-e259) | `POST /internal/dashboard/custody/connections/{connectionId}/provider-credentials`         | Pending |
| [E263](#endpoint-e263) | `POST /internal/dashboard/custody/provider-credentials`                                    | Pending |
| [E264](#endpoint-e264) | `POST /internal/dashboard/custody/provider-credentials/{credentialId}/complete-rotation`   | Pending |
| [E265](#endpoint-e265) | `POST /internal/dashboard/custody/provider-credentials/{credentialId}/deactivate`          | Pending |
| [E266](#endpoint-e266) | `POST /internal/dashboard/custody/provider-credentials/{credentialId}/rollback-rotation`   | Pending |
| [E267](#endpoint-e267) | `POST /internal/dashboard/custody/provider-credentials/{credentialId}/rotate`              | Pending |
| [E268](#endpoint-e268) | `GET /internal/dashboard/custody/providers`                                                | Pending |
| [E270](#endpoint-e270) | `POST /internal/dashboard/wallets/{walletId}/faucet`                                       | Pending |
| [E276](#endpoint-e276) | `GET /internal/dashboard/network`                                                          | Pending |

<a id="endpoint-e253"></a>

### E253: Get connections

`GET /internal/dashboard/custody/connections`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value               |
| --------------- | ------------------- |
| Module          | `custody`           |
| Release channel | Stable              |
| Action / access | `wallets.configure` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/internal-custody/index.ts) · [handler](../../apps/sdp-api/src/routes/internal-custody/index.ts)


<a id="endpoint-e254"></a>

### E254: Get connections {connectionId}

`GET /internal/dashboard/custody/connections/{connectionId}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value               |
| --------------- | ------------------- |
| Module          | `custody`           |
| Release channel | Stable              |
| Action / access | `wallets.configure` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/internal-custody/index.ts) · [handler](../../apps/sdp-api/src/routes/internal-custody/index.ts)


<a id="endpoint-e255"></a>

### E255: Post cancel

`POST /internal/dashboard/custody/connections/{connectionId}/cancel-installation`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value               |
| --------------- | ------------------- |
| Module          | `custody`           |
| Release channel | Stable              |
| Action / access | `wallets.configure` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/internal-custody/index.ts) · [handler](../../apps/sdp-api/src/routes/internal-custody/index.ts)


<a id="endpoint-e256"></a>

### E256: Post complete

`POST /internal/dashboard/custody/connections/{connectionId}/complete-installation`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value               |
| --------------- | ------------------- |
| Module          | `custody`           |
| Release channel | Stable              |
| Action / access | `wallets.configure` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/internal-custody/index.ts) · [handler](../../apps/sdp-api/src/routes/internal-custody/index.ts)


<a id="endpoint-e257"></a>

### E257: Post deactivate

`POST /internal/dashboard/custody/connections/{connectionId}/deactivate`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value               |
| --------------- | ------------------- |
| Module          | `custody`           |
| Release channel | Stable              |
| Action / access | `wallets.configure` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/internal-custody/index.ts) · [handler](../../apps/sdp-api/src/routes/internal-custody/index.ts)


<a id="endpoint-e258"></a>

### E258: Get provider credential

`GET /internal/dashboard/custody/connections/{connectionId}/provider-credential/lifecycle`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value               |
| --------------- | ------------------- |
| Module          | `custody`           |
| Release channel | Stable              |
| Action / access | `wallets.configure` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/internal-custody/index.ts) · [handler](../../apps/sdp-api/src/routes/internal-custody/index.ts)


<a id="endpoint-e259"></a>

### E259: Post provider credentials

`POST /internal/dashboard/custody/connections/{connectionId}/provider-credentials`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value               |
| --------------- | ------------------- |
| Module          | `custody`           |
| Release channel | Stable              |
| Action / access | `wallets.configure` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/internal-custody/index.ts) · [handler](../../apps/sdp-api/src/routes/internal-custody/index.ts)


<a id="endpoint-e263"></a>

### E263: Post provider credentials

`POST /internal/dashboard/custody/provider-credentials`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value               |
| --------------- | ------------------- |
| Module          | `custody`           |
| Release channel | Stable              |
| Action / access | `wallets.configure` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/internal-custody/index.ts) · [handler](../../apps/sdp-api/src/routes/internal-custody/index.ts)


<a id="endpoint-e264"></a>

### E264: Post complete rotation

`POST /internal/dashboard/custody/provider-credentials/{credentialId}/complete-rotation`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value               |
| --------------- | ------------------- |
| Module          | `custody`           |
| Release channel | Stable              |
| Action / access | `wallets.configure` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/internal-custody/index.ts) · [handler](../../apps/sdp-api/src/routes/internal-custody/index.ts)


<a id="endpoint-e265"></a>

### E265: Post deactivate

`POST /internal/dashboard/custody/provider-credentials/{credentialId}/deactivate`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value               |
| --------------- | ------------------- |
| Module          | `custody`           |
| Release channel | Stable              |
| Action / access | `wallets.configure` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/internal-custody/index.ts) · [handler](../../apps/sdp-api/src/routes/internal-custody/index.ts)


<a id="endpoint-e266"></a>

### E266: Post rollback

`POST /internal/dashboard/custody/provider-credentials/{credentialId}/rollback-rotation`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value               |
| --------------- | ------------------- |
| Module          | `custody`           |
| Release channel | Stable              |
| Action / access | `wallets.configure` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/internal-custody/index.ts) · [handler](../../apps/sdp-api/src/routes/internal-custody/index.ts)


<a id="endpoint-e267"></a>

### E267: Post rotate

`POST /internal/dashboard/custody/provider-credentials/{credentialId}/rotate`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value               |
| --------------- | ------------------- |
| Module          | `custody`           |
| Release channel | Stable              |
| Action / access | `wallets.configure` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/internal-custody/index.ts) · [handler](../../apps/sdp-api/src/routes/internal-custody/index.ts)


<a id="endpoint-e268"></a>

### E268: Get providers

`GET /internal/dashboard/custody/providers`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value               |
| --------------- | ------------------- |
| Module          | `custody`           |
| Release channel | Stable              |
| Action / access | `wallets.configure` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/internal-custody/index.ts) · [handler](../../apps/sdp-api/src/routes/internal-custody/index.ts)


<a id="endpoint-e270"></a>

### E270: Request Wallet Faucet

`POST /internal/dashboard/wallets/{walletId}/faucet`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value             |
| --------------- | ----------------- |
| Module          | `custody`         |
| Release channel | Stable            |
| Action / access | `wallets.execute` |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/custody/internal.ts) · [handler](../../apps/sdp-api/src/routes/custody/handlers/faucet.ts)


<a id="endpoint-e276"></a>

### E276: Get Network Snapshot

`GET /internal/dashboard/network`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                                                        |
| --------------- | ------------------------------------------------------------ |
| Module          | `core`                                                       |
| Release channel | Stable                                                       |
| Action / access | a dashboard session reads chain-wide figures; no tenant data |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/internal-network/index.ts) · [handler](../../apps/sdp-api/src/routes/internal-network/handlers.ts)



## Onboarding

| ID                     | Endpoint                    | Verdict |
| ---------------------- | --------------------------- | ------- |
| [E277](#endpoint-e277) | `GET /v1/onboarding/status` | Pending |

<a id="endpoint-e277"></a>

### E277: Get onboarding status

`GET /v1/onboarding/status`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                                                              |
| --------------- | ------------------------------------------------------------------ |
| Module          | `core`                                                             |
| Release channel | Stable                                                             |
| Action / access | onboarding: a Clerk session before its organization is provisioned |
| Operation ID    | `getOnboardingStatus`                                              |

Returns whether the active Clerk organization is linked.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Onboarding"
  ],
  "summary": "Get onboarding status",
  "operationId": "getOnboardingStatus",
  "description": "Returns whether the active Clerk organization is linked.",
  "security": [
    {
      "apiKeyAuth": []
    }
  ],
  "responses": {
    "200": {
      "description": "Onboarding status",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema157"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "403": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>



## Webhooks

| ID                     | Endpoint               | Verdict |
| ---------------------- | ---------------------- | ------- |
| [E278](#endpoint-e278) | `POST /webhooks/clerk` | Pending |

<a id="endpoint-e278"></a>

### E278: Handle Clerk Webhook

`POST /webhooks/clerk`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                                              |
| --------------- | -------------------------------------------------- |
| Module          | `core`                                             |
| Release channel | Stable                                             |
| Action / access | signed webhook: Clerk's signature authenticates it |

This runtime endpoint has no operation in the internal OpenAPI document. Inspect its validators and handler for the exact request and response contract.

**Source:** [route registration](../../apps/sdp-api/src/routes/webhooks/index.ts) · [handler](../../apps/sdp-api/src/routes/webhooks/handlers.ts)



## Administration

| ID                     | Endpoint                                  | Verdict |
| ---------------------- | ----------------------------------------- | ------- |
| [E281](#endpoint-e281) | `GET /admin/onboarding-allowlist`         | Pending |
| [E282](#endpoint-e282) | `POST /admin/onboarding-allowlist`        | Pending |
| [E283](#endpoint-e283) | `DELETE /admin/onboarding-allowlist/{id}` | Pending |

<a id="endpoint-e281"></a>

### E281: List allowlist entries

`GET /admin/onboarding-allowlist`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                                                                         |
| --------------- | ----------------------------------------------------------------------------- |
| Module          | `core`                                                                        |
| Release channel | Stable                                                                        |
| Action / access | operator: ALLOWLIST_ADMIN_KEY or a platform administrator, not a tenant grant |
| Operation ID    | `listAllowlistEntries`                                                        |

Lists allowlist entries for onboarding.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Admin"
  ],
  "summary": "List allowlist entries",
  "operationId": "listAllowlistEntries",
  "description": "Lists allowlist entries for onboarding.",
  "security": [
    {
      "adminKey": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema158"
      },
      "required": false,
      "description": "Filter by allowlist entry type.",
      "name": "type",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema159"
      },
      "required": false,
      "description": "Filter by allowlist entry status.",
      "name": "status",
      "in": "query"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "200": {
      "description": "Allowlist entries",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema160"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e282"></a>

### E282: Add allowlist entry

`POST /admin/onboarding-allowlist`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                                                                         |
| --------------- | ----------------------------------------------------------------------------- |
| Module          | `core`                                                                        |
| Release channel | Stable                                                                        |
| Action / access | operator: ALLOWLIST_ADMIN_KEY or a platform administrator, not a tenant grant |
| Operation ID    | `addAllowlistEntry`                                                           |

Adds an allowlist entry for onboarding.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Admin"
  ],
  "summary": "Add allowlist entry",
  "operationId": "addAllowlistEntry",
  "description": "Adds an allowlist entry for onboarding.",
  "security": [
    {
      "adminKey": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReviewSchema161"
        }
      }
    }
  },
  "responses": {
    "201": {
      "description": "Allowlist entry created",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema162"
          }
        }
      }
    },
    "400": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "409": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>


<a id="endpoint-e283"></a>

### E283: Remove allowlist entry

`DELETE /admin/onboarding-allowlist/{id}`

- [ ] Good
- [ ] Needs work

**Review notes:** _Add your notes here._

| Property        | Value                                                                         |
| --------------- | ----------------------------------------------------------------------------- |
| Module          | `core`                                                                        |
| Release channel | Stable                                                                        |
| Action / access | operator: ALLOWLIST_ADMIN_KEY or a platform administrator, not a tenant grant |
| Operation ID    | `removeAllowlistEntry`                                                        |

Removes (disables) an allowlist entry.

<details>
<summary>Complete current operation contract</summary>

```json
{
  "tags": [
    "Admin"
  ],
  "summary": "Remove allowlist entry",
  "operationId": "removeAllowlistEntry",
  "description": "Removes (disables) an allowlist entry.",
  "security": [
    {
      "adminKey": []
    }
  ],
  "parameters": [
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema163"
      },
      "required": true,
      "description": "Allowlist entry identifier.",
      "name": "id",
      "in": "path"
    },
    {
      "schema": {
        "$ref": "#/components/schemas/ReviewSchema022"
      },
      "required": false,
      "description": "Required for dashboard sessions. API keys use their assigned project.",
      "name": "x-project-id",
      "in": "header"
    }
  ],
  "responses": {
    "204": {
      "description": "Allowlist entry removed"
    },
    "401": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "404": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    },
    "500": {
      "description": "Error",
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReviewSchema003"
          }
        }
      }
    }
  }
}
```

</details>



## Component reference

Named references used by the operation contracts above. Identical inline schemas are deduplicated as `ReviewSchemaNNN`; replacing their local references with the definitions below reproduces the original contract exactly. Unreferenced non-stable components are omitted.


### `#/components/schemas/MainnetAccess`

```json
{
  "type": "object",
  "properties": {
    "state": {
      "type": "string",
      "enum": [
        "not_requested",
        "pending",
        "approved"
      ],
      "description": "`approved` once an operator enables production for the organization; `pending` after a request; otherwise `not_requested`."
    },
    "available": {
      "type": "boolean",
      "description": "Whether this deployment takes requests. While false, a request or resend is refused with 503."
    },
    "countryCode": {
      "type": "string",
      "nullable": true,
      "enum": [
        "AF",
        "AX",
        "AL",
        "DZ",
        "AS",
        "AD",
        "AO",
        "AI",
        "AQ",
        "AG",
        "AR",
        "AM",
        "AW",
        "AU",
        "AT",
        "AZ",
        "BS",
        "BH",
        "BD",
        "BB",
        "BY",
        "BE",
        "BZ",
        "BJ",
        "BM",
        "BT",
        "BO",
        "BA",
        "BW",
        "BV",
        "BR",
        "IO",
        "VG",
        "BN",
        "BG",
        "BF",
        "BI",
        "KH",
        "CM",
        "CA",
        "CV",
        "BQ",
        "KY",
        "CF",
        "TD",
        "CL",
        "CN",
        "CX",
        "CC",
        "CO",
        "KM",
        "CG",
        "CD",
        "CK",
        "CR",
        "CI",
        "HR",
        "CU",
        "CW",
        "CY",
        "CZ",
        "DK",
        "DJ",
        "DM",
        "DO",
        "EC",
        "EG",
        "SV",
        "GQ",
        "ER",
        "EE",
        "SZ",
        "ET",
        "FK",
        "FO",
        "FJ",
        "FI",
        "FR",
        "GF",
        "PF",
        "TF",
        "GA",
        "GM",
        "GE",
        "DE",
        "GH",
        "GI",
        "GR",
        "GL",
        "GD",
        "GP",
        "GU",
        "GT",
        "GG",
        "GN",
        "GW",
        "GY",
        "HT",
        "HM",
        "HN",
        "HK",
        "HU",
        "IS",
        "IN",
        "ID",
        "IR",
        "IQ",
        "IE",
        "IM",
        "IL",
        "IT",
        "JM",
        "JP",
        "JE",
        "JO",
        "KZ",
        "KE",
        "KI",
        "KW",
        "KG",
        "LA",
        "LV",
        "LB",
        "LS",
        "LR",
        "LY",
        "LI",
        "LT",
        "LU",
        "MO",
        "MG",
        "MW",
        "MY",
        "MV",
        "ML",
        "MT",
        "MH",
        "MQ",
        "MR",
        "MU",
        "YT",
        "MX",
        "FM",
        "MD",
        "MC",
        "MN",
        "ME",
        "MS",
        "MA",
        "MZ",
        "MM",
        "NA",
        "NR",
        "NP",
        "NL",
        "NC",
        "NZ",
        "NI",
        "NE",
        "NG",
        "NU",
        "NF",
        "KP",
        "MK",
        "MP",
        "NO",
        "OM",
        "PK",
        "PW",
        "PS",
        "PA",
        "PG",
        "PY",
        "PE",
        "PH",
        "PN",
        "PL",
        "PT",
        "PR",
        "QA",
        "RE",
        "RO",
        "RU",
        "RW",
        "WS",
        "SM",
        "ST",
        "SA",
        "SN",
        "RS",
        "SC",
        "SL",
        "SG",
        "SX",
        "SK",
        "SI",
        "SB",
        "SO",
        "ZA",
        "GS",
        "KR",
        "SS",
        "ES",
        "LK",
        "BL",
        "SH",
        "KN",
        "LC",
        "MF",
        "PM",
        "VC",
        "SD",
        "SR",
        "SJ",
        "SE",
        "CH",
        "SY",
        "TW",
        "TJ",
        "TZ",
        "TH",
        "TL",
        "TG",
        "TK",
        "TO",
        "TT",
        "TN",
        "TR",
        "TM",
        "TC",
        "TV",
        "UM",
        "VI",
        "UG",
        "UA",
        "AE",
        "GB",
        "US",
        "UY",
        "UZ",
        "VU",
        "VA",
        "VE",
        "VN",
        "WF",
        "EH",
        "YE",
        "ZM",
        "ZW",
        null
      ]
    },
    "request": {
      "type": "object",
      "nullable": true,
      "properties": {
        "requestedAt": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        },
        "requestedByUserId": {
          "type": "string",
          "minLength": 1,
          "description": "User identifier.",
          "example": "usr_example"
        },
        "termsVersion": {
          "type": "string",
          "description": "The SDP Terms and Conditions version the requester accepted with the request."
        },
        "notified": {
          "type": "boolean",
          "description": "False until the SDP alias received the request; `POST …/notify` sends it."
        }
      },
      "required": [
        "requestedAt",
        "requestedByUserId",
        "termsVersion",
        "notified"
      ]
    },
    "contactEmail": {
      "type": "string",
      "nullable": true
    }
  },
  "required": [
    "state",
    "available",
    "countryCode",
    "request",
    "contactEmail"
  ],
  "description": "The organization's mainnet access request."
}
```


### `#/components/schemas/RequestMainnetAccessRequest`

```json
{
  "type": "object",
  "properties": {
    "countryCode": {
      "type": "string",
      "enum": [
        "AF",
        "AX",
        "AL",
        "DZ",
        "AS",
        "AD",
        "AO",
        "AI",
        "AQ",
        "AG",
        "AR",
        "AM",
        "AW",
        "AU",
        "AT",
        "AZ",
        "BS",
        "BH",
        "BD",
        "BB",
        "BY",
        "BE",
        "BZ",
        "BJ",
        "BM",
        "BT",
        "BO",
        "BA",
        "BW",
        "BV",
        "BR",
        "IO",
        "VG",
        "BN",
        "BG",
        "BF",
        "BI",
        "KH",
        "CM",
        "CA",
        "CV",
        "BQ",
        "KY",
        "CF",
        "TD",
        "CL",
        "CN",
        "CX",
        "CC",
        "CO",
        "KM",
        "CG",
        "CD",
        "CK",
        "CR",
        "CI",
        "HR",
        "CU",
        "CW",
        "CY",
        "CZ",
        "DK",
        "DJ",
        "DM",
        "DO",
        "EC",
        "EG",
        "SV",
        "GQ",
        "ER",
        "EE",
        "SZ",
        "ET",
        "FK",
        "FO",
        "FJ",
        "FI",
        "FR",
        "GF",
        "PF",
        "TF",
        "GA",
        "GM",
        "GE",
        "DE",
        "GH",
        "GI",
        "GR",
        "GL",
        "GD",
        "GP",
        "GU",
        "GT",
        "GG",
        "GN",
        "GW",
        "GY",
        "HT",
        "HM",
        "HN",
        "HK",
        "HU",
        "IS",
        "IN",
        "ID",
        "IR",
        "IQ",
        "IE",
        "IM",
        "IL",
        "IT",
        "JM",
        "JP",
        "JE",
        "JO",
        "KZ",
        "KE",
        "KI",
        "KW",
        "KG",
        "LA",
        "LV",
        "LB",
        "LS",
        "LR",
        "LY",
        "LI",
        "LT",
        "LU",
        "MO",
        "MG",
        "MW",
        "MY",
        "MV",
        "ML",
        "MT",
        "MH",
        "MQ",
        "MR",
        "MU",
        "YT",
        "MX",
        "FM",
        "MD",
        "MC",
        "MN",
        "ME",
        "MS",
        "MA",
        "MZ",
        "MM",
        "NA",
        "NR",
        "NP",
        "NL",
        "NC",
        "NZ",
        "NI",
        "NE",
        "NG",
        "NU",
        "NF",
        "KP",
        "MK",
        "MP",
        "NO",
        "OM",
        "PK",
        "PW",
        "PS",
        "PA",
        "PG",
        "PY",
        "PE",
        "PH",
        "PN",
        "PL",
        "PT",
        "PR",
        "QA",
        "RE",
        "RO",
        "RU",
        "RW",
        "WS",
        "SM",
        "ST",
        "SA",
        "SN",
        "RS",
        "SC",
        "SL",
        "SG",
        "SX",
        "SK",
        "SI",
        "SB",
        "SO",
        "ZA",
        "GS",
        "KR",
        "SS",
        "ES",
        "LK",
        "BL",
        "SH",
        "KN",
        "LC",
        "MF",
        "PM",
        "VC",
        "SD",
        "SR",
        "SJ",
        "SE",
        "CH",
        "SY",
        "TW",
        "TJ",
        "TZ",
        "TH",
        "TL",
        "TG",
        "TK",
        "TO",
        "TT",
        "TN",
        "TR",
        "TM",
        "TC",
        "TV",
        "UM",
        "VI",
        "UG",
        "UA",
        "AE",
        "GB",
        "US",
        "UY",
        "UZ",
        "VU",
        "VA",
        "VE",
        "VN",
        "WF",
        "EH",
        "YE",
        "ZM",
        "ZW"
      ]
    },
    "termsVersion": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "acceptTerms": {
      "type": "boolean",
      "enum": [
        true
      ]
    }
  },
  "required": [
    "countryCode",
    "termsVersion",
    "acceptTerms"
  ],
  "additionalProperties": false,
  "description": "The organization's self-declared jurisdiction (its primary registered geography for business) and the SDP Terms and Conditions version the admin read and accepted.",
  "example": {
    "countryCode": "US",
    "termsVersion": "2026-10-placeholder",
    "acceptTerms": true
  }
}
```


### `#/components/schemas/ReviewSchema001`

```json
{
  "type": "boolean",
  "description": "Include archived resources in results.",
  "example": false
}
```


### `#/components/schemas/ReviewSchema002`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "projects": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "description": "Project identifier.",
                "example": "prj_example"
              },
              "organizationId": {
                "type": "string",
                "minLength": 1,
                "description": "Organization identifier.",
                "example": "org_example"
              },
              "name": {
                "type": "string",
                "description": "Project name.",
                "example": "Payments"
              },
              "slug": {
                "type": "string",
                "description": "URL-friendly slug.",
                "example": "payments"
              },
              "description": {
                "type": "string",
                "nullable": true,
                "description": "Optional project description.",
                "example": "Payments workflow"
              },
              "environment": {
                "type": "string",
                "enum": [
                  "sandbox",
                  "beta",
                  "production"
                ],
                "description": "Project environment.",
                "example": "sandbox"
              },
              "settings": {
                "type": "object",
                "nullable": true,
                "properties": {
                  "webhookUrl": {
                    "type": "string",
                    "format": "uri",
                    "description": "Webhook URL for event notifications.",
                    "example": "https://example.com/webhook"
                  },
                  "metadata": {
                    "type": "object",
                    "additionalProperties": {
                      "type": "string"
                    },
                    "description": "Arbitrary metadata key/value pairs.",
                    "example": {
                      "region": "us"
                    }
                  }
                },
                "additionalProperties": false,
                "description": "Project settings, or null when none have been set."
              },
              "status": {
                "type": "string",
                "enum": [
                  "active",
                  "archived"
                ],
                "description": "Project status.",
                "example": "active"
              },
              "createdBy": {
                "type": "string",
                "minLength": 1,
                "description": "Identifier of the creator.",
                "example": "usr_example"
              },
              "createdAt": {
                "type": "string",
                "format": "date-time",
                "description": "Creation timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "updatedAt": {
                "type": "string",
                "format": "date-time",
                "description": "Last update timestamp.",
                "example": "2025-01-02T00:00:00.000Z"
              }
            },
            "required": [
              "id",
              "organizationId",
              "name",
              "slug",
              "description",
              "environment",
              "settings",
              "status",
              "createdBy",
              "createdAt",
              "updatedAt"
            ],
            "description": "Project record."
          },
          "description": "Projects."
        }
      },
      "required": [
        "projects"
      ],
      "description": "List of projects."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema003`

```json
{
  "type": "object",
  "properties": {
    "error": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string",
          "enum": [
            "BAD_REQUEST",
            "UNAUTHORIZED",
            "FORBIDDEN",
            "NOT_FOUND",
            "CONFLICT",
            "RATE_LIMITED",
            "SERVICE_UNAVAILABLE",
            "RPC_UNAVAILABLE",
            "INTERNAL_ERROR",
            "NOT_ALLOWLISTED",
            "INVALID_API_KEY",
            "EXPIRED_API_KEY",
            "REVOKED_API_KEY",
            "INSUFFICIENT_PERMISSIONS",
            "INVALID_TOKEN",
            "TOKEN_NOT_FOUND",
            "TOKEN_NOT_ACTIVE",
            "TOKEN_NOT_MINTABLE",
            "TOKEN_NOT_DEPLOYED",
            "TOKEN_PAUSED",
            "NOT_ON_TOKEN_ALLOWLIST",
            "ON_TOKEN_BLOCKLIST",
            "ACCOUNT_FROZEN",
            "ACCOUNT_NOT_FROZEN",
            "MAX_SUPPLY_EXCEEDED",
            "INSUFFICIENT_TOKEN_BALANCE",
            "SOLANA_RPC_ERROR",
            "CUSTODY_ERROR",
            "TRANSACTION_FAILED",
            "SIGNING_FAILED",
            "SIGNING_REJECTED",
            "CUSTODY_POLICY_REFUSED",
            "PROVIDER_NOT_CONFIGURED",
            "PROVIDER_UNAVAILABLE",
            "PROVIDER_RESPONSE_INVALID",
            "UNSUPPORTED_CORRIDOR",
            "VAULT_EXPOSURE_CAP",
            "AMOUNT_BELOW_RENT_MINIMUM",
            "TRANSFER_BATCH_RUN_EXISTS",
            "TRANSFER_BATCH_NOTHING_TO_RETRY",
            "TRANSFER_BATCH_RETRY_CLAIMED",
            "TRANSFER_BATCH_DESTINATION_CHANGED",
            "SPONSORED_RENT_OVER_CAP",
            "IDEMPOTENCY_KEY_REQUIRED",
            "IDEMPOTENCY_KEY_REUSED",
            "IDEMPOTENCY_KEY_IN_FLIGHT",
            "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN"
          ],
          "description": "Machine-readable error code."
        },
        "message": {
          "type": "string",
          "description": "Human-readable error message."
        },
        "details": {
          "type": "object",
          "additionalProperties": {
            "nullable": true
          },
          "description": "Optional error details for debugging."
        }
      },
      "required": [
        "code",
        "message"
      ],
      "description": "Standard error payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        }
      }
    }
  },
  "required": [
    "error"
  ],
  "description": "Standard error response envelope."
}
```


### `#/components/schemas/ReviewSchema004`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Project identifier.",
  "example": "prj_example"
}
```


### `#/components/schemas/ReviewSchema005`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "project": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1,
              "description": "Project identifier.",
              "example": "prj_example"
            },
            "organizationId": {
              "type": "string",
              "minLength": 1,
              "description": "Organization identifier.",
              "example": "org_example"
            },
            "name": {
              "type": "string",
              "description": "Project name.",
              "example": "Payments"
            },
            "slug": {
              "type": "string",
              "description": "URL-friendly slug.",
              "example": "payments"
            },
            "description": {
              "type": "string",
              "nullable": true,
              "description": "Optional project description.",
              "example": "Payments workflow"
            },
            "environment": {
              "type": "string",
              "enum": [
                "sandbox",
                "beta",
                "production"
              ],
              "description": "Project environment.",
              "example": "sandbox"
            },
            "settings": {
              "type": "object",
              "nullable": true,
              "properties": {
                "webhookUrl": {
                  "type": "string",
                  "format": "uri",
                  "description": "Webhook URL for event notifications.",
                  "example": "https://example.com/webhook"
                },
                "metadata": {
                  "type": "object",
                  "additionalProperties": {
                    "type": "string"
                  },
                  "description": "Arbitrary metadata key/value pairs.",
                  "example": {
                    "region": "us"
                  }
                }
              },
              "additionalProperties": false,
              "description": "Project settings, or null when none have been set."
            },
            "status": {
              "type": "string",
              "enum": [
                "active",
                "archived"
              ],
              "description": "Project status.",
              "example": "active"
            },
            "createdBy": {
              "type": "string",
              "minLength": 1,
              "description": "Identifier of the creator.",
              "example": "usr_example"
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "Creation timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "updatedAt": {
              "type": "string",
              "format": "date-time",
              "description": "Last update timestamp.",
              "example": "2025-01-02T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "organizationId",
            "name",
            "slug",
            "description",
            "environment",
            "settings",
            "status",
            "createdBy",
            "createdAt",
            "updatedAt"
          ],
          "description": "Project details."
        }
      },
      "required": [
        "project"
      ],
      "description": "Project response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema006`

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100,
      "description": "Updated project name.",
      "example": "Payments Updated"
    },
    "description": {
      "type": "string",
      "nullable": true,
      "maxLength": 500,
      "description": "Updated description. Use null to clear.",
      "example": "Updated project description."
    },
    "settings": {
      "type": "object",
      "nullable": true,
      "properties": {
        "webhookUrl": {
          "type": "string",
          "format": "uri"
        },
        "metadata": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          }
        }
      },
      "additionalProperties": false,
      "description": "Updated project settings. Use null to clear.",
      "example": {
        "webhookUrl": "https://example.com/webhook"
      }
    }
  },
  "description": "Update project request body."
}
```


### `#/components/schemas/ReviewSchema007`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "apiKeys": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "description": "API key identifier.",
                "example": "key_example"
              },
              "name": {
                "type": "string",
                "description": "API key name.",
                "example": "Primary Key"
              },
              "keyPrefix": {
                "type": "string",
                "description": "API key prefix for display: `sf_` and the key ID.",
                "example": "sf_0018a3cae6a0a034"
              },
              "grants": {
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": [
                    "transfers.read",
                    "transfers.execute",
                    "transfer_batches.read",
                    "transfer_batches.execute",
                    "payment_requests.read",
                    "payment_requests.manage",
                    "counterparties.read",
                    "counterparties.manage",
                    "counterparties.execute",
                    "transactions.read",
                    "recurring.read",
                    "recurring.manage",
                    "recurring.execute",
                    "wallets.read",
                    "wallets.manage",
                    "wallets.execute",
                    "compliance.execute",
                    "projects.read",
                    "organizations.read",
                    "onramp.read",
                    "onramp.execute",
                    "offramp.read",
                    "offramp.execute",
                    "ramp_transfers.manage",
                    "issuance.read",
                    "issuance.manage",
                    "issuance.execute",
                    "issuance.enforce",
                    "issuance.authority",
                    "dvp.read",
                    "dvp.manage",
                    "dvp.execute",
                    "earn.read",
                    "earn.manage",
                    "earn.execute",
                    "private_channels.read",
                    "private_channels.manage",
                    "private_channels.execute",
                    "helius_rings.read",
                    "helius_rings.manage",
                    "helius_rings.execute"
                  ],
                  "description": "An action the key may perform, `module.verb`. `manage` and `execute` each imply the same module's `read`; nothing else implies another action.",
                  "example": "transfers.execute"
                },
                "description": "The actions this key holds. An explicit list: there is no role and no wildcard, and an action added to SDP later is granted to no existing key.",
                "example": [
                  "transfers.execute",
                  "counterparties.read",
                  "wallets.read"
                ]
              },
              "environment": {
                "type": "string",
                "enum": [
                  "sandbox",
                  "production"
                ],
                "description": "API key environment.",
                "example": "sandbox"
              },
              "status": {
                "type": "string",
                "enum": [
                  "active",
                  "revoked",
                  "expired",
                  "deactivated"
                ],
                "description": "API key status.",
                "example": "active"
              },
              "walletScope": {
                "type": "string",
                "enum": [
                  "all",
                  "selected"
                ],
                "description": "Which connected wallets the key may sign with: `all` wallets in its project, or only the `selected` ones in `walletIds`. A `selected` key with no wallets signs with no connected wallet (the fee sponsor is outside wallet scope). The scope applies when SDP requests a provider signature; it also narrows the key's wallet list and wallet detail reads, while every other read covers the whole project.",
                "example": "selected"
              },
              "walletIds": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "The connected wallets (`id` from `GET /v1/wallets`, `cwlt_...`) a `selected` key may sign with. Empty for `all`.",
                "example": [
                  "cwlt_0f2c8c1e"
                ]
              },
              "lastUsedAt": {
                "type": "string",
                "nullable": true,
                "format": "date-time",
                "description": "Timestamp of the last key usage.",
                "example": "2025-01-10T12:00:00.000Z"
              },
              "expiresAt": {
                "type": "string",
                "nullable": true,
                "format": "date-time",
                "description": "Expiration timestamp, if set.",
                "example": "2025-12-31T00:00:00.000Z"
              },
              "rotationDeadline": {
                "type": "string",
                "nullable": true,
                "format": "date-time",
                "description": "When this key stops working because it was rotated; null unless it is in its rotation grace period.",
                "example": null
              },
              "createdAt": {
                "type": "string",
                "format": "date-time",
                "description": "Creation timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              }
            },
            "required": [
              "id",
              "name",
              "keyPrefix",
              "grants",
              "environment",
              "status",
              "walletScope",
              "walletIds",
              "lastUsedAt",
              "expiresAt",
              "rotationDeadline",
              "createdAt"
            ],
            "description": "API key list item."
          },
          "description": "Project API keys."
        }
      },
      "required": [
        "apiKeys"
      ],
      "description": "List of project API keys."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema008`

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100,
      "description": "Friendly name for the API key.",
      "example": "Primary Key"
    },
    "description": {
      "type": "string",
      "maxLength": 500,
      "description": "Optional key description.",
      "example": "Used by backend service."
    },
    "grants": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "transfers.read",
          "transfers.execute",
          "transfer_batches.read",
          "transfer_batches.execute",
          "payment_requests.read",
          "payment_requests.manage",
          "counterparties.read",
          "counterparties.manage",
          "counterparties.execute",
          "transactions.read",
          "recurring.read",
          "recurring.manage",
          "recurring.execute",
          "wallets.read",
          "wallets.manage",
          "wallets.execute",
          "compliance.execute",
          "projects.read",
          "organizations.read",
          "onramp.read",
          "onramp.execute",
          "offramp.read",
          "offramp.execute",
          "ramp_transfers.manage",
          "issuance.read",
          "issuance.manage",
          "issuance.execute",
          "issuance.enforce",
          "issuance.authority",
          "dvp.read",
          "dvp.manage",
          "dvp.execute",
          "earn.read",
          "earn.manage",
          "earn.execute",
          "private_channels.read",
          "private_channels.manage",
          "private_channels.execute",
          "helius_rings.read",
          "helius_rings.manage",
          "helius_rings.execute"
        ],
        "description": "An action the key may perform, `module.verb`. `manage` and `execute` each imply the same module's `read`; nothing else implies another action.",
        "example": "transfers.execute"
      },
      "description": "The actions the key holds, `module.verb`. Required; an empty list grants nothing. Unknown actions, and actions no API key may hold (`api_keys.*`, `members.*`, `organizations.manage`, `projects.manage`, any `*.configure`), are refused with 400, as are actions of a module this deployment's release channel does not run. You can grant only actions you hold yourself.",
      "example": [
        "transfers.execute",
        "counterparties.read",
        "wallets.read"
      ]
    },
    "walletScope": {
      "type": "string",
      "enum": [
        "all",
        "selected"
      ],
      "description": "Which connected wallets the key may sign with: `all` in its project, or only the `selected` ones in `walletIds`. Required.",
      "example": "selected"
    },
    "walletIds": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      },
      "maxItems": 100,
      "description": "Connected wallet ids (`id` from `GET /v1/wallets`) a `selected` key may sign with. Not allowed with `all`. Omitted or empty, a `selected` key signs with no connected wallet.",
      "example": [
        "cwlt_0f2c8c1e"
      ]
    },
    "allowedIps": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Optional list of IPv4/IPv6 addresses or CIDR ranges allowed to use the key.",
      "example": [
        "203.0.113.0/24"
      ]
    },
    "expiresAt": {
      "type": "string",
      "format": "date-time",
      "description": "Optional expiration timestamp.",
      "example": "2025-12-31T00:00:00.000Z"
    }
  },
  "required": [
    "name",
    "grants",
    "walletScope"
  ],
  "additionalProperties": false,
  "description": "Create API key request body.",
  "example": {
    "name": "Primary Key",
    "grants": [
      "transfers.execute",
      "counterparties.read",
      "wallets.read"
    ],
    "walletScope": "selected",
    "walletIds": [
      "cwlt_0f2c8c1e"
    ]
  }
}
```


### `#/components/schemas/ReviewSchema009`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "apiKey": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1,
              "description": "API key identifier.",
              "example": "key_example"
            },
            "name": {
              "type": "string",
              "description": "API key name.",
              "example": "Primary Key"
            },
            "key": {
              "type": "string",
              "description": "Full API key. Only returned once.",
              "example": "sf_0018a3cae6a0a034_sc7Mv6ineTCew5AEgraQLmN8OgapWiFzDF9DUPEXDUI3NoYh3"
            },
            "keyPrefix": {
              "type": "string",
              "description": "API key prefix for display: `sf_` and the key ID.",
              "example": "sf_0018a3cae6a0a034"
            },
            "grants": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "transfers.read",
                  "transfers.execute",
                  "transfer_batches.read",
                  "transfer_batches.execute",
                  "payment_requests.read",
                  "payment_requests.manage",
                  "counterparties.read",
                  "counterparties.manage",
                  "counterparties.execute",
                  "transactions.read",
                  "recurring.read",
                  "recurring.manage",
                  "recurring.execute",
                  "wallets.read",
                  "wallets.manage",
                  "wallets.execute",
                  "compliance.execute",
                  "projects.read",
                  "organizations.read",
                  "onramp.read",
                  "onramp.execute",
                  "offramp.read",
                  "offramp.execute",
                  "ramp_transfers.manage",
                  "issuance.read",
                  "issuance.manage",
                  "issuance.execute",
                  "issuance.enforce",
                  "issuance.authority",
                  "dvp.read",
                  "dvp.manage",
                  "dvp.execute",
                  "earn.read",
                  "earn.manage",
                  "earn.execute",
                  "private_channels.read",
                  "private_channels.manage",
                  "private_channels.execute",
                  "helius_rings.read",
                  "helius_rings.manage",
                  "helius_rings.execute"
                ],
                "description": "An action the key may perform, `module.verb`. `manage` and `execute` each imply the same module's `read`; nothing else implies another action.",
                "example": "transfers.execute"
              },
              "description": "The actions this key holds. An explicit list: there is no role and no wildcard, and an action added to SDP later is granted to no existing key.",
              "example": [
                "transfers.execute",
                "counterparties.read",
                "wallets.read"
              ]
            },
            "environment": {
              "type": "string",
              "enum": [
                "sandbox",
                "production"
              ],
              "description": "API key environment.",
              "example": "sandbox"
            },
            "expiresAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "Expiration timestamp, if set.",
              "example": "2025-12-31T00:00:00.000Z"
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "Creation timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "name",
            "key",
            "keyPrefix",
            "grants",
            "environment",
            "expiresAt",
            "createdAt"
          ],
          "description": "API key details."
        }
      },
      "required": [
        "apiKey"
      ],
      "description": "API key create response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema010`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "members": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "description": "Project member identifier.",
                "example": "pm_example"
              },
              "projectId": {
                "type": "string",
                "minLength": 1,
                "description": "Project identifier.",
                "example": "prj_example"
              },
              "userId": {
                "type": "string",
                "minLength": 1,
                "description": "User identifier.",
                "example": "usr_example"
              },
              "createdAt": {
                "type": "string",
                "format": "date-time",
                "description": "Membership creation timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "user": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "minLength": 1,
                    "description": "User identifier.",
                    "example": "usr_example"
                  },
                  "email": {
                    "type": "string",
                    "format": "email",
                    "description": "User email.",
                    "example": "user@example.com"
                  },
                  "name": {
                    "type": "string",
                    "nullable": true,
                    "description": "User name.",
                    "example": "Example User"
                  }
                },
                "required": [
                  "id",
                  "email",
                  "name"
                ],
                "description": "User details for the project member."
              }
            },
            "required": [
              "id",
              "projectId",
              "userId",
              "createdAt",
              "user"
            ],
            "description": "Project member record with user details."
          },
          "description": "Project members."
        }
      },
      "required": [
        "members"
      ],
      "description": "List of project members."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema011`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "projectId": {
          "type": "string"
        },
        "environment": {
          "type": "string",
          "enum": [
            "sandbox",
            "production"
          ]
        },
        "providers": {
          "type": "array",
          "items": {
            "oneOf": [
              {
                "type": "object",
                "properties": {
                  "family": {
                    "type": "string",
                    "enum": [
                      "custody"
                    ]
                  },
                  "provider": {
                    "type": "string",
                    "enum": [
                      "local",
                      "fireblocks",
                      "privy",
                      "coinbase_cdp",
                      "para",
                      "turnkey",
                      "dfns",
                      "ibm_haven",
                      "anchorage",
                      "utila"
                    ]
                  },
                  "modes": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "enum": [
                        "managed",
                        "byok"
                      ]
                    }
                  },
                  "unavailableModes": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "mode": {
                          "type": "string",
                          "enum": [
                            "managed",
                            "byok"
                          ]
                        },
                        "reason": {
                          "type": "string",
                          "enum": [
                            "custody_provider_not_in_release_channel",
                            "custody_mode_not_allowed",
                            "provider_not_entitled",
                            "provider_not_in_release_channel",
                            "provider_not_offered",
                            "provider_not_configured"
                          ]
                        }
                      },
                      "required": [
                        "mode",
                        "reason"
                      ]
                    }
                  }
                },
                "required": [
                  "family",
                  "provider",
                  "modes",
                  "unavailableModes"
                ]
              },
              {
                "oneOf": [
                  {
                    "type": "object",
                    "properties": {
                      "family": {
                        "type": "string",
                        "enum": [
                          "compliance"
                        ]
                      },
                      "provider": {
                        "type": "string",
                        "enum": [
                          "range",
                          "elliptic",
                          "trm",
                          "chainalysis"
                        ]
                      },
                      "available": {
                        "type": "boolean",
                        "enum": [
                          true
                        ]
                      }
                    },
                    "required": [
                      "family",
                      "provider",
                      "available"
                    ]
                  },
                  {
                    "type": "object",
                    "properties": {
                      "family": {
                        "type": "string",
                        "enum": [
                          "compliance"
                        ]
                      },
                      "provider": {
                        "type": "string",
                        "enum": [
                          "range",
                          "elliptic",
                          "trm",
                          "chainalysis"
                        ]
                      },
                      "available": {
                        "type": "boolean",
                        "enum": [
                          false
                        ]
                      },
                      "reason": {
                        "type": "string",
                        "enum": [
                          "custody_provider_not_in_release_channel",
                          "custody_mode_not_allowed",
                          "provider_not_entitled",
                          "provider_not_in_release_channel",
                          "provider_not_offered",
                          "provider_not_configured"
                        ]
                      }
                    },
                    "required": [
                      "family",
                      "provider",
                      "available",
                      "reason"
                    ]
                  }
                ]
              },
              {
                "oneOf": [
                  {
                    "type": "object",
                    "properties": {
                      "family": {
                        "type": "string",
                        "enum": [
                          "ramps"
                        ]
                      },
                      "provider": {
                        "type": "string",
                        "enum": [
                          "moonpay",
                          "stripe"
                        ]
                      },
                      "available": {
                        "type": "boolean",
                        "enum": [
                          true
                        ]
                      }
                    },
                    "required": [
                      "family",
                      "provider",
                      "available"
                    ]
                  },
                  {
                    "type": "object",
                    "properties": {
                      "family": {
                        "type": "string",
                        "enum": [
                          "ramps"
                        ]
                      },
                      "provider": {
                        "type": "string",
                        "enum": [
                          "moonpay",
                          "stripe"
                        ]
                      },
                      "available": {
                        "type": "boolean",
                        "enum": [
                          false
                        ]
                      },
                      "reason": {
                        "type": "string",
                        "enum": [
                          "custody_provider_not_in_release_channel",
                          "custody_mode_not_allowed",
                          "provider_not_entitled",
                          "provider_not_in_release_channel",
                          "provider_not_offered",
                          "provider_not_configured"
                        ]
                      }
                    },
                    "required": [
                      "family",
                      "provider",
                      "available",
                      "reason"
                    ]
                  }
                ]
              },
              {
                "oneOf": [
                  {
                    "type": "object",
                    "properties": {
                      "family": {
                        "type": "string",
                        "enum": [
                          "earn"
                        ]
                      },
                      "provider": {
                        "type": "string",
                        "enum": [
                          "veda",
                          "upshift",
                          "perena",
                          "kamino",
                          "jupiter_lend",
                          "ondo",
                          "hastra",
                          "wisdomtree"
                        ]
                      },
                      "available": {
                        "type": "boolean",
                        "enum": [
                          true
                        ]
                      }
                    },
                    "required": [
                      "family",
                      "provider",
                      "available"
                    ]
                  },
                  {
                    "type": "object",
                    "properties": {
                      "family": {
                        "type": "string",
                        "enum": [
                          "earn"
                        ]
                      },
                      "provider": {
                        "type": "string",
                        "enum": [
                          "veda",
                          "upshift",
                          "perena",
                          "kamino",
                          "jupiter_lend",
                          "ondo",
                          "hastra",
                          "wisdomtree"
                        ]
                      },
                      "available": {
                        "type": "boolean",
                        "enum": [
                          false
                        ]
                      },
                      "reason": {
                        "type": "string",
                        "enum": [
                          "custody_provider_not_in_release_channel",
                          "custody_mode_not_allowed",
                          "provider_not_entitled",
                          "provider_not_in_release_channel",
                          "provider_not_offered",
                          "provider_not_configured"
                        ]
                      }
                    },
                    "required": [
                      "family",
                      "provider",
                      "available",
                      "reason"
                    ]
                  }
                ]
              }
            ]
          }
        }
      },
      "required": [
        "projectId",
        "environment",
        "providers"
      ],
      "description": "Every provider this deployment's release channel publishes, with whether this project can use it; a provider the channel leaves out is omitted, matching this document. Custody entries list the custody modes the project can set the provider up in (empty when none) in `modes`, and each refused mode with the first failed check in `unavailableModes`; every other entry carries `available`, plus `reason` naming the first failed check when unavailable. A provider is available only when the deployment's release channel includes it, SDP currently offers it, the organization is entitled to it, and the deployment holds its credentials for the project's environment; the release channel offers the same providers to Sandbox and Production projects. Custody `modes` include `managed` only in a Sandbox project whose deployment holds the provider's credentials; `byok` runs on the organization's own credentials and is the only mode a Production project can use.",
      "example": {
        "projectId": "prj_example",
        "environment": "production",
        "providers": [
          {
            "family": "custody",
            "provider": "privy",
            "modes": [
              "byok"
            ],
            "unavailableModes": [
              {
                "mode": "managed",
                "reason": "custody_mode_not_allowed"
              }
            ]
          },
          {
            "family": "custody",
            "provider": "fireblocks",
            "modes": [],
            "unavailableModes": [
              {
                "mode": "managed",
                "reason": "custody_mode_not_allowed"
              },
              {
                "mode": "byok",
                "reason": "custody_provider_not_in_release_channel"
              }
            ]
          },
          {
            "family": "compliance",
            "provider": "range",
            "available": true
          },
          {
            "family": "ramps",
            "provider": "moonpay",
            "available": false,
            "reason": "provider_not_entitled"
          },
          {
            "family": "earn",
            "provider": "kamino",
            "available": false,
            "reason": "provider_not_entitled"
          }
        ]
      }
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema012`

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100,
      "description": "The new organization's name.",
      "example": "Example Org"
    }
  },
  "required": [
    "name"
  ],
  "description": "Create organization request body."
}
```


### `#/components/schemas/ReviewSchema013`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "organization": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1,
              "description": "Organization identifier.",
              "example": "org_example"
            },
            "name": {
              "type": "string",
              "description": "Organization name.",
              "example": "Example Org"
            },
            "slug": {
              "type": "string",
              "description": "URL-friendly slug.",
              "example": "example-org"
            },
            "tier": {
              "type": "string",
              "enum": [
                "individual",
                "enterprise"
              ],
              "description": "Organization tier.",
              "example": "enterprise"
            },
            "status": {
              "type": "string",
              "enum": [
                "provisioning",
                "active",
                "suspended",
                "deleted"
              ],
              "description": "Organization status.",
              "example": "active"
            },
            "settings": {
              "type": "object",
              "nullable": true,
              "properties": {
                "defaultEnvironment": {
                  "type": "string",
                  "enum": [
                    "sandbox",
                    "production"
                  ],
                  "description": "Default environment for new resources.",
                  "example": "production"
                },
                "allowedIpAddresses": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  },
                  "description": "IPv4/IPv6 addresses and CIDR ranges the organization's API keys may be used from. It applies to every API-key request, intersected with each key's own `allowedIps`, and never to signed-in members. An empty or absent list places no restriction. Entries are stored in canonical form, so a range with host bits set is returned as the network it selects.",
                  "example": [
                    "203.0.113.0/24"
                  ]
                },
                "legacyAllowedIpAddresses": {
                  "nullable": true,
                  "description": "Read-only. An allowlist recorded before this setting was enforced, retained for reference and never applied. Send it back as `allowedIpAddresses` to put it into effect, which validates it first.",
                  "example": [
                    "203.0.113.0/24"
                  ]
                },
                "customRateLimits": {
                  "type": "object",
                  "properties": {
                    "requestsPerMinute": {
                      "type": "integer",
                      "minimum": 0,
                      "exclusiveMinimum": true,
                      "description": "Maximum requests allowed per minute.",
                      "example": 60
                    },
                    "requestsPerDay": {
                      "type": "integer",
                      "minimum": 0,
                      "exclusiveMinimum": true,
                      "description": "Maximum requests allowed per day.",
                      "example": 10000
                    }
                  },
                  "description": "Custom rate limit overrides."
                },
                "alertEmails": {
                  "type": "boolean",
                  "description": "Whether organization admins are emailed when money moves in a mainnet project or the organization's members, API keys, custody or mainnet access change. Unset means true. Turning it off is itself emailed to the admins.",
                  "example": true
                }
              },
              "additionalProperties": false,
              "description": "Organization settings (nullable when unset)."
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "Creation timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "updatedAt": {
              "type": "string",
              "format": "date-time",
              "description": "Last update timestamp.",
              "example": "2025-01-02T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "name",
            "slug",
            "tier",
            "status",
            "settings",
            "createdAt",
            "updatedAt"
          ],
          "description": "Organization record."
        },
        "clerkOrganizationId": {
          "type": "string",
          "description": "The Clerk organization the dashboard makes active for the session.",
          "example": "org_2example"
        }
      },
      "required": [
        "organization",
        "clerkOrganizationId"
      ],
      "description": "The created organization."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema014`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Organization identifier.",
  "example": "org_example"
}
```


### `#/components/schemas/ReviewSchema015`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "description": "Organization identifier.",
          "example": "org_example"
        },
        "name": {
          "type": "string",
          "description": "Organization name.",
          "example": "Example Org"
        },
        "slug": {
          "type": "string",
          "description": "URL-friendly slug.",
          "example": "example-org"
        },
        "tier": {
          "type": "string",
          "enum": [
            "individual",
            "enterprise"
          ],
          "description": "Organization tier.",
          "example": "enterprise"
        },
        "status": {
          "type": "string",
          "enum": [
            "provisioning",
            "active",
            "suspended",
            "deleted"
          ],
          "description": "Organization status.",
          "example": "active"
        },
        "settings": {
          "type": "object",
          "nullable": true,
          "properties": {
            "defaultEnvironment": {
              "type": "string",
              "enum": [
                "sandbox",
                "production"
              ],
              "description": "Default environment for new resources.",
              "example": "production"
            },
            "allowedIpAddresses": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "IPv4/IPv6 addresses and CIDR ranges the organization's API keys may be used from. It applies to every API-key request, intersected with each key's own `allowedIps`, and never to signed-in members. An empty or absent list places no restriction. Entries are stored in canonical form, so a range with host bits set is returned as the network it selects.",
              "example": [
                "203.0.113.0/24"
              ]
            },
            "legacyAllowedIpAddresses": {
              "nullable": true,
              "description": "Read-only. An allowlist recorded before this setting was enforced, retained for reference and never applied. Send it back as `allowedIpAddresses` to put it into effect, which validates it first.",
              "example": [
                "203.0.113.0/24"
              ]
            },
            "customRateLimits": {
              "type": "object",
              "properties": {
                "requestsPerMinute": {
                  "type": "integer",
                  "minimum": 0,
                  "exclusiveMinimum": true,
                  "description": "Maximum requests allowed per minute.",
                  "example": 60
                },
                "requestsPerDay": {
                  "type": "integer",
                  "minimum": 0,
                  "exclusiveMinimum": true,
                  "description": "Maximum requests allowed per day.",
                  "example": 10000
                }
              },
              "description": "Custom rate limit overrides."
            },
            "alertEmails": {
              "type": "boolean",
              "description": "Whether organization admins are emailed when money moves in a mainnet project or the organization's members, API keys, custody or mainnet access change. Unset means true. Turning it off is itself emailed to the admins.",
              "example": true
            }
          },
          "additionalProperties": false,
          "description": "Organization settings (nullable when unset)."
        },
        "createdAt": {
          "type": "string",
          "format": "date-time",
          "description": "Creation timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        },
        "updatedAt": {
          "type": "string",
          "format": "date-time",
          "description": "Last update timestamp.",
          "example": "2025-01-02T00:00:00.000Z"
        }
      },
      "required": [
        "id",
        "name",
        "slug",
        "tier",
        "status",
        "settings",
        "createdAt",
        "updatedAt"
      ],
      "description": "Organization record."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema016`

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100,
      "description": "Updated organization name.",
      "example": "Example Org Updated"
    },
    "settings": {
      "type": "object",
      "properties": {
        "defaultEnvironment": {
          "type": "string",
          "enum": [
            "sandbox",
            "production"
          ]
        },
        "allowedIpAddresses": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "maxItems": 100
        },
        "alertEmails": {
          "type": "boolean"
        }
      },
      "additionalProperties": false,
      "description": "Organization settings to update.",
      "example": {
        "defaultEnvironment": "production",
        "allowedIpAddresses": [
          "203.0.113.0/24"
        ]
      }
    }
  },
  "description": "Update organization request body."
}
```


### `#/components/schemas/ReviewSchema017`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "$ref": "#/components/schemas/MainnetAccess"
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema018`

```json
{
  "type": "integer",
  "minimum": 0,
  "exclusiveMinimum": true,
  "description": "Page number (1-based).",
  "example": 1
}
```


### `#/components/schemas/ReviewSchema019`

```json
{
  "type": "integer",
  "minimum": 0,
  "exclusiveMinimum": true,
  "maximum": 100,
  "description": "Records per page. Values above 100 are clamped to 100.",
  "example": 25
}
```


### `#/components/schemas/ReviewSchema020`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "members": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "description": "Member identifier.",
                "example": "mem_example"
              },
              "role": {
                "type": "string",
                "enum": [
                  "admin",
                  "member",
                  "viewer"
                ],
                "description": "Organization member role.",
                "example": "member"
              },
              "status": {
                "type": "string",
                "enum": [
                  "active",
                  "suspended",
                  "removed"
                ],
                "description": "Membership status.",
                "example": "active"
              },
              "createdAt": {
                "type": "string",
                "format": "date-time",
                "description": "Membership creation timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "isSelf": {
                "type": "boolean",
                "description": "Whether this membership belongs to the authenticated caller. Absent for API key callers, which have no user of their own.",
                "example": false
              },
              "user": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "minLength": 1,
                    "description": "User identifier.",
                    "example": "usr_example"
                  },
                  "email": {
                    "type": "string",
                    "format": "email",
                    "description": "User email.",
                    "example": "user@example.com"
                  },
                  "name": {
                    "type": "string",
                    "nullable": true,
                    "description": "User name.",
                    "example": "Example User"
                  }
                },
                "required": [
                  "id",
                  "email",
                  "name"
                ],
                "description": "User associated with the membership."
              }
            },
            "required": [
              "id",
              "role",
              "status",
              "createdAt",
              "user"
            ],
            "description": "Organization member record."
          },
          "description": "Organization members."
        },
        "invitations": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "description": "Invitation identifier.",
                "example": "inv_example"
              },
              "email": {
                "type": "string",
                "format": "email",
                "description": "Invitee email.",
                "example": "dev@example.com"
              },
              "role": {
                "type": "string",
                "enum": [
                  "admin",
                  "member",
                  "viewer"
                ],
                "description": "Role offered to the invitee.",
                "example": "member"
              },
              "status": {
                "type": "string",
                "enum": [
                  "pending"
                ],
                "description": "Invitation status.",
                "example": "pending"
              },
              "createdAt": {
                "type": "string",
                "format": "date-time",
                "description": "Invitation creation timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "expiresAt": {
                "type": "string",
                "format": "date-time",
                "description": "Invitation expiration timestamp.",
                "example": "2025-02-01T00:00:00.000Z"
              }
            },
            "required": [
              "id",
              "email",
              "role",
              "status",
              "createdAt",
              "expiresAt"
            ],
            "description": "Pending invitation, returned only to callers holding `members.manage`."
          },
          "description": "Pending invitations, paged as a continuation of the member list. Always empty for callers without `members.manage`, since the acceptance link is a shareable credential."
        },
        "meta": {
          "type": "object",
          "properties": {
            "total": {
              "type": "integer",
              "minimum": 0,
              "description": "Size of the directory visible to this caller: active members plus any pending invitations they are permitted to see.",
              "example": 42
            },
            "page": {
              "type": "integer",
              "minimum": 0,
              "exclusiveMinimum": true,
              "description": "Current page.",
              "example": 1
            },
            "pageSize": {
              "type": "integer",
              "minimum": 0,
              "exclusiveMinimum": true,
              "description": "Records per page (max 100).",
              "example": 25
            },
            "hasMore": {
              "type": "boolean",
              "description": "Whether a further page exists.",
              "example": true
            },
            "activeAdminCount": {
              "type": "integer",
              "minimum": 0,
              "description": "Active administrators across the whole organization, not just this page, so the last-admin rule holds on any page.",
              "example": 2
            }
          },
          "required": [
            "total",
            "page",
            "pageSize",
            "hasMore",
            "activeAdminCount"
          ],
          "description": "Pagination metadata for the member directory."
        }
      },
      "required": [
        "members",
        "invitations",
        "meta"
      ],
      "description": "List of organization members."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema021`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Invitation identifier.",
  "example": "inv_example"
}
```


### `#/components/schemas/ReviewSchema022`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Required for dashboard sessions. API keys use their assigned project.",
  "example": "prj_example"
}
```


### `#/components/schemas/ReviewSchema023`

```json
{
  "type": "string",
  "pattern": "^[\\x20-\\x7e]{1,255}$",
  "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` with no `Retry-After`, as does every later retry with that key: read the resource with GET to see whether it ran, then send again with a new key. After a 5xx, a retry with the same key runs again and answers from the original record instead of acting twice; that answer also carries `Idempotent-Replayed: true`.",
  "example": "idempotency_example_12345"
}
```


### `#/components/schemas/ReviewSchema024`

```json
{
  "type": "string",
  "pattern": "^[\\x20-\\x7e]{1,255}$",
  "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` with no `Retry-After`, as does every later retry with that key: read the resource with GET to see whether it ran, then send again with a new key. A 5xx is stored and replayed like any other answer; retry it with a new key.",
  "example": "idempotency_example_12345"
}
```


### `#/components/schemas/ReviewSchema025`

```json
{
  "type": "object",
  "properties": {
    "email": {
      "type": "string",
      "format": "email",
      "description": "Invitee email address.",
      "example": "dev@example.com"
    },
    "role": {
      "type": "string",
      "enum": [
        "admin",
        "member",
        "viewer"
      ],
      "description": "Role assigned to the invited member.",
      "example": "member"
    }
  },
  "required": [
    "email",
    "role"
  ],
  "description": "Invite member request body."
}
```


### `#/components/schemas/ReviewSchema026`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "invitation": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1,
              "description": "Invitation identifier.",
              "example": "inv_example"
            },
            "email": {
              "type": "string",
              "format": "email",
              "description": "Invitee email.",
              "example": "dev@example.com"
            },
            "role": {
              "type": "string",
              "enum": [
                "admin",
                "member",
                "viewer"
              ],
              "description": "Role offered to the invitee.",
              "example": "member"
            },
            "expiresAt": {
              "type": "string",
              "format": "date-time",
              "description": "Invitation expiration timestamp.",
              "example": "2025-02-01T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "email",
            "role",
            "expiresAt"
          ],
          "description": "Invitation details."
        }
      },
      "required": [
        "invitation"
      ],
      "description": "Invitation details."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema027`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "memberId": {
          "type": "string",
          "minLength": 1,
          "description": "Member identifier.",
          "example": "mem_example"
        },
        "userId": {
          "type": "string",
          "minLength": 1,
          "description": "User identifier.",
          "example": "usr_example"
        },
        "organizationId": {
          "type": "string",
          "minLength": 1,
          "description": "Organization identifier.",
          "example": "org_example"
        },
        "role": {
          "type": "string",
          "enum": [
            "admin",
            "member",
            "viewer"
          ],
          "description": "The Organization Role, held only by SDP and read on every request.",
          "example": "member"
        }
      },
      "required": [
        "memberId",
        "userId",
        "organizationId",
        "role"
      ],
      "description": "A membership in the authenticated organization and its role."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema028`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Member identifier.",
  "example": "mem_example"
}
```


### `#/components/schemas/ReviewSchema029`

```json
{
  "type": "object",
  "properties": {
    "role": {
      "type": "string",
      "enum": [
        "admin",
        "member",
        "viewer"
      ],
      "description": "The member's new Organization Role.",
      "example": "admin"
    }
  },
  "required": [
    "role"
  ],
  "description": "Update member role request body."
}
```


### `#/components/schemas/ReviewSchema030`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "apiKeys": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "description": "API key identifier.",
                "example": "key_example"
              },
              "name": {
                "type": "string",
                "description": "API key name.",
                "example": "Primary Key"
              },
              "keyPrefix": {
                "type": "string",
                "description": "API key prefix for display: `sf_` and the key ID.",
                "example": "sf_0018a3cae6a0a034"
              },
              "environment": {
                "type": "string",
                "enum": [
                  "sandbox",
                  "production"
                ],
                "description": "API key environment.",
                "example": "sandbox"
              },
              "createdAt": {
                "type": "string",
                "format": "date-time",
                "description": "Creation timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "projectId": {
                "type": "string",
                "minLength": 1,
                "description": "Project identifier.",
                "example": "prj_example"
              },
              "projectName": {
                "type": "string",
                "description": "Project name.",
                "example": "Payments"
              }
            },
            "required": [
              "id",
              "name",
              "keyPrefix",
              "environment",
              "createdAt",
              "projectId",
              "projectName"
            ]
          }
        }
      },
      "required": [
        "apiKeys"
      ],
      "description": "The active API keys a member created, newest first."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema031`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "apiKeys": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "description": "API key identifier.",
                "example": "key_example"
              },
              "name": {
                "type": "string",
                "description": "API key name.",
                "example": "Primary Key"
              },
              "keyPrefix": {
                "type": "string",
                "description": "API key prefix for display: `sf_` and the key ID.",
                "example": "sf_0018a3cae6a0a034"
              },
              "grants": {
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": [
                    "transfers.read",
                    "transfers.execute",
                    "transfer_batches.read",
                    "transfer_batches.execute",
                    "payment_requests.read",
                    "payment_requests.manage",
                    "counterparties.read",
                    "counterparties.manage",
                    "counterparties.execute",
                    "transactions.read",
                    "recurring.read",
                    "recurring.manage",
                    "recurring.execute",
                    "wallets.read",
                    "wallets.manage",
                    "wallets.execute",
                    "compliance.execute",
                    "projects.read",
                    "organizations.read",
                    "onramp.read",
                    "onramp.execute",
                    "offramp.read",
                    "offramp.execute",
                    "ramp_transfers.manage",
                    "issuance.read",
                    "issuance.manage",
                    "issuance.execute",
                    "issuance.enforce",
                    "issuance.authority",
                    "dvp.read",
                    "dvp.manage",
                    "dvp.execute",
                    "earn.read",
                    "earn.manage",
                    "earn.execute",
                    "private_channels.read",
                    "private_channels.manage",
                    "private_channels.execute",
                    "helius_rings.read",
                    "helius_rings.manage",
                    "helius_rings.execute"
                  ],
                  "description": "An action the key may perform, `module.verb`. `manage` and `execute` each imply the same module's `read`; nothing else implies another action.",
                  "example": "transfers.execute"
                },
                "description": "The actions this key holds. An explicit list: there is no role and no wildcard, and an action added to SDP later is granted to no existing key.",
                "example": [
                  "transfers.execute",
                  "counterparties.read",
                  "wallets.read"
                ]
              },
              "environment": {
                "type": "string",
                "enum": [
                  "sandbox",
                  "production"
                ],
                "description": "API key environment.",
                "example": "sandbox"
              },
              "status": {
                "type": "string",
                "enum": [
                  "active",
                  "revoked",
                  "expired",
                  "deactivated"
                ],
                "description": "API key status.",
                "example": "active"
              },
              "walletScope": {
                "type": "string",
                "enum": [
                  "all",
                  "selected"
                ],
                "description": "Which connected wallets the key may sign with: `all` wallets in its project, or only the `selected` ones in `walletIds`. A `selected` key with no wallets signs with no connected wallet (the fee sponsor is outside wallet scope). The scope applies when SDP requests a provider signature; it also narrows the key's wallet list and wallet detail reads, while every other read covers the whole project.",
                "example": "selected"
              },
              "walletIds": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "The connected wallets (`id` from `GET /v1/wallets`, `cwlt_...`) a `selected` key may sign with. Empty for `all`.",
                "example": [
                  "cwlt_0f2c8c1e"
                ]
              },
              "lastUsedAt": {
                "type": "string",
                "nullable": true,
                "format": "date-time",
                "description": "Timestamp of the last key usage.",
                "example": "2025-01-10T12:00:00.000Z"
              },
              "expiresAt": {
                "type": "string",
                "nullable": true,
                "format": "date-time",
                "description": "Expiration timestamp, if set.",
                "example": "2025-12-31T00:00:00.000Z"
              },
              "rotationDeadline": {
                "type": "string",
                "nullable": true,
                "format": "date-time",
                "description": "When this key stops working because it was rotated; null unless it is in its rotation grace period.",
                "example": null
              },
              "createdAt": {
                "type": "string",
                "format": "date-time",
                "description": "Creation timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              }
            },
            "required": [
              "id",
              "name",
              "keyPrefix",
              "grants",
              "environment",
              "status",
              "walletScope",
              "walletIds",
              "lastUsedAt",
              "expiresAt",
              "rotationDeadline",
              "createdAt"
            ],
            "description": "API key list item."
          },
          "description": "API keys."
        }
      },
      "required": [
        "apiKeys"
      ],
      "description": "List of API keys."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema032`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "API key identifier.",
  "example": "key_example"
}
```


### `#/components/schemas/ReviewSchema033`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "description": "API key identifier.",
          "example": "key_example"
        },
        "name": {
          "type": "string",
          "description": "API key name.",
          "example": "Primary Key"
        },
        "description": {
          "type": "string",
          "nullable": true,
          "description": "Optional API key description.",
          "example": "Used by backend service."
        },
        "keyPrefix": {
          "type": "string",
          "description": "API key prefix for display: `sf_` and the key ID.",
          "example": "sf_0018a3cae6a0a034"
        },
        "grants": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "transfers.read",
              "transfers.execute",
              "transfer_batches.read",
              "transfer_batches.execute",
              "payment_requests.read",
              "payment_requests.manage",
              "counterparties.read",
              "counterparties.manage",
              "counterparties.execute",
              "transactions.read",
              "recurring.read",
              "recurring.manage",
              "recurring.execute",
              "wallets.read",
              "wallets.manage",
              "wallets.execute",
              "compliance.execute",
              "projects.read",
              "organizations.read",
              "onramp.read",
              "onramp.execute",
              "offramp.read",
              "offramp.execute",
              "ramp_transfers.manage",
              "issuance.read",
              "issuance.manage",
              "issuance.execute",
              "issuance.enforce",
              "issuance.authority",
              "dvp.read",
              "dvp.manage",
              "dvp.execute",
              "earn.read",
              "earn.manage",
              "earn.execute",
              "private_channels.read",
              "private_channels.manage",
              "private_channels.execute",
              "helius_rings.read",
              "helius_rings.manage",
              "helius_rings.execute"
            ],
            "description": "An action the key may perform, `module.verb`. `manage` and `execute` each imply the same module's `read`; nothing else implies another action.",
            "example": "transfers.execute"
          },
          "description": "The actions this key holds. An explicit list: there is no role and no wildcard, and an action added to SDP later is granted to no existing key.",
          "example": [
            "transfers.execute",
            "counterparties.read",
            "wallets.read"
          ]
        },
        "environment": {
          "type": "string",
          "enum": [
            "sandbox",
            "production"
          ],
          "description": "API key environment.",
          "example": "sandbox"
        },
        "status": {
          "type": "string",
          "enum": [
            "active",
            "revoked",
            "expired",
            "deactivated"
          ],
          "description": "API key status.",
          "example": "active"
        },
        "projectId": {
          "type": "string",
          "minLength": 1,
          "description": "Associated project identifier.",
          "example": "prj_example"
        },
        "allowedIps": {
          "type": "array",
          "nullable": true,
          "items": {
            "type": "string"
          },
          "description": "IPv4/IPv6 addresses or CIDR ranges permitted to use the key.",
          "example": [
            "203.0.113.0/24"
          ]
        },
        "walletScope": {
          "type": "string",
          "enum": [
            "all",
            "selected"
          ],
          "description": "Which connected wallets the key may sign with: `all` wallets in its project, or only the `selected` ones in `walletIds`. A `selected` key with no wallets signs with no connected wallet (the fee sponsor is outside wallet scope). The scope applies when SDP requests a provider signature; it also narrows the key's wallet list and wallet detail reads, while every other read covers the whole project.",
          "example": "selected"
        },
        "walletIds": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "The connected wallets (`id` from `GET /v1/wallets`, `cwlt_...`) a `selected` key may sign with. Empty for `all`.",
          "example": [
            "cwlt_0f2c8c1e"
          ]
        },
        "lastUsedAt": {
          "type": "string",
          "nullable": true,
          "format": "date-time",
          "description": "Timestamp of the last key usage.",
          "example": "2025-01-10T12:00:00.000Z"
        },
        "expiresAt": {
          "type": "string",
          "nullable": true,
          "format": "date-time",
          "description": "Expiration timestamp, if set.",
          "example": "2025-12-31T00:00:00.000Z"
        },
        "rotatedFrom": {
          "type": "string",
          "nullable": true,
          "minLength": 1,
          "description": "Previous key identifier if rotated.",
          "example": "key_example"
        },
        "rotationDeadline": {
          "type": "string",
          "nullable": true,
          "format": "date-time",
          "description": "Deadline before the previous key is revoked.",
          "example": "2025-02-01T00:00:00.000Z"
        },
        "createdAt": {
          "type": "string",
          "format": "date-time",
          "description": "Creation timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "id",
        "name",
        "description",
        "keyPrefix",
        "grants",
        "environment",
        "status",
        "projectId",
        "allowedIps",
        "walletScope",
        "walletIds",
        "lastUsedAt",
        "expiresAt",
        "rotatedFrom",
        "rotationDeadline",
        "createdAt"
      ],
      "description": "Detailed API key view."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema034`

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100,
      "description": "Updated key name.",
      "example": "Primary Key Updated"
    },
    "description": {
      "type": "string",
      "nullable": true,
      "maxLength": 500,
      "description": "Updated description. Use null to clear.",
      "example": "Rotated key for new service."
    },
    "grants": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "transfers.read",
          "transfers.execute",
          "transfer_batches.read",
          "transfer_batches.execute",
          "payment_requests.read",
          "payment_requests.manage",
          "counterparties.read",
          "counterparties.manage",
          "counterparties.execute",
          "transactions.read",
          "recurring.read",
          "recurring.manage",
          "recurring.execute",
          "wallets.read",
          "wallets.manage",
          "wallets.execute",
          "compliance.execute",
          "projects.read",
          "organizations.read",
          "onramp.read",
          "onramp.execute",
          "offramp.read",
          "offramp.execute",
          "ramp_transfers.manage",
          "issuance.read",
          "issuance.manage",
          "issuance.execute",
          "issuance.enforce",
          "issuance.authority",
          "dvp.read",
          "dvp.manage",
          "dvp.execute",
          "earn.read",
          "earn.manage",
          "earn.execute",
          "private_channels.read",
          "private_channels.manage",
          "private_channels.execute",
          "helius_rings.read",
          "helius_rings.manage",
          "helius_rings.execute"
        ],
        "description": "An action the key may perform, `module.verb`. `manage` and `execute` each imply the same module's `read`; nothing else implies another action.",
        "example": "transfers.execute"
      },
      "description": "Replaces the key's grants. Omit to keep them. The same rules as on create apply, except that an action the key already holds may be sent back even when this deployment's release channel no longer runs its module.",
      "example": [
        "transfers.read",
        "transfers.execute"
      ]
    },
    "walletScope": {
      "type": "string",
      "enum": [
        "all",
        "selected"
      ],
      "description": "Replaces the key's wallet scope. With `selected`, `walletIds` replaces its wallets (omitted: none). Omit both to keep the current scope.",
      "example": "selected"
    },
    "walletIds": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      },
      "maxItems": 100,
      "description": "Connected wallet ids for a `selected` key. Requires `walletScope: \"selected\"`.",
      "example": [
        "cwlt_0f2c8c1e"
      ]
    },
    "allowedIps": {
      "type": "array",
      "nullable": true,
      "items": {
        "type": "string"
      },
      "description": "Updated IPv4/IPv6 address or CIDR allowlist. Use null to clear.",
      "example": [
        "203.0.113.0/24"
      ]
    },
    "expiresAt": {
      "type": "string",
      "nullable": true,
      "format": "date-time",
      "description": "Updated expiration. Use null to clear.",
      "example": "2026-01-01T00:00:00.000Z"
    }
  },
  "additionalProperties": false,
  "description": "Update API key request body."
}
```


### `#/components/schemas/ReviewSchema035`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "success": {
          "type": "boolean",
          "description": "Operation success flag.",
          "example": true
        }
      },
      "required": [
        "success"
      ],
      "description": "Generic success response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema036`

```json
{
  "type": "object",
  "properties": {
    "confirmation": {
      "type": "string",
      "minLength": 1,
      "description": "Type the exact API key name to confirm deletion.",
      "example": "Primary Key"
    },
    "cancelRecurringPayments": {
      "type": "boolean",
      "description": "Also cancel every active or paused recurring payment this key activated, last resumed, or last changed the source wallet, recipient, token, amount or period of. Use it for a compromised key.",
      "example": true
    }
  },
  "required": [
    "confirmation"
  ]
}
```


### `#/components/schemas/ReviewSchema037`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "success": {
          "type": "boolean",
          "enum": [
            true
          ],
          "description": "Revocation result."
        },
        "revokedAt": {
          "type": "string",
          "format": "date-time",
          "description": "Revocation timestamp.",
          "example": "2025-01-10T12:00:00.000Z"
        },
        "recurringPayments": {
          "type": "object",
          "nullable": true,
          "properties": {
            "canceled": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Recurring payments this key activated that are now canceled."
            },
            "failed": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Recurring payments that could not be canceled; cancel them individually."
            }
          },
          "required": [
            "canceled",
            "failed"
          ],
          "description": "Null unless the request set `cancelRecurringPayments`. The key is revoked either way."
        }
      },
      "required": [
        "success",
        "revokedAt",
        "recurringPayments"
      ],
      "description": "API key revocation response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema038`

```json
{
  "type": "object",
  "properties": {
    "gracePeriodHours": {
      "type": "number",
      "minimum": 0,
      "maximum": 168,
      "description": "Grace period for the old key before revocation.",
      "example": 24
    }
  },
  "description": "Rotate API key request body."
}
```


### `#/components/schemas/ReviewSchema039`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "apiKey": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1,
              "description": "API key identifier.",
              "example": "key_example"
            },
            "name": {
              "type": "string",
              "description": "API key name.",
              "example": "Primary Key"
            },
            "key": {
              "type": "string",
              "description": "Full API key. Only returned once.",
              "example": "sf_0018a3cae6a0a034_sc7Mv6ineTCew5AEgraQLmN8OgapWiFzDF9DUPEXDUI3NoYh3"
            },
            "keyPrefix": {
              "type": "string",
              "description": "API key prefix for display: `sf_` and the key ID.",
              "example": "sf_0018a3cae6a0a034"
            },
            "grants": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "transfers.read",
                  "transfers.execute",
                  "transfer_batches.read",
                  "transfer_batches.execute",
                  "payment_requests.read",
                  "payment_requests.manage",
                  "counterparties.read",
                  "counterparties.manage",
                  "counterparties.execute",
                  "transactions.read",
                  "recurring.read",
                  "recurring.manage",
                  "recurring.execute",
                  "wallets.read",
                  "wallets.manage",
                  "wallets.execute",
                  "compliance.execute",
                  "projects.read",
                  "organizations.read",
                  "onramp.read",
                  "onramp.execute",
                  "offramp.read",
                  "offramp.execute",
                  "ramp_transfers.manage",
                  "issuance.read",
                  "issuance.manage",
                  "issuance.execute",
                  "issuance.enforce",
                  "issuance.authority",
                  "dvp.read",
                  "dvp.manage",
                  "dvp.execute",
                  "earn.read",
                  "earn.manage",
                  "earn.execute",
                  "private_channels.read",
                  "private_channels.manage",
                  "private_channels.execute",
                  "helius_rings.read",
                  "helius_rings.manage",
                  "helius_rings.execute"
                ],
                "description": "An action the key may perform, `module.verb`. `manage` and `execute` each imply the same module's `read`; nothing else implies another action.",
                "example": "transfers.execute"
              },
              "description": "The actions this key holds. An explicit list: there is no role and no wildcard, and an action added to SDP later is granted to no existing key.",
              "example": [
                "transfers.execute",
                "counterparties.read",
                "wallets.read"
              ]
            },
            "environment": {
              "type": "string",
              "enum": [
                "sandbox",
                "production"
              ],
              "description": "API key environment.",
              "example": "sandbox"
            },
            "expiresAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "Expiration timestamp, if set.",
              "example": "2025-12-31T00:00:00.000Z"
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "Creation timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "name",
            "key",
            "keyPrefix",
            "grants",
            "environment",
            "expiresAt",
            "createdAt"
          ],
          "description": "New API key details."
        },
        "previousKey": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1,
              "description": "API key identifier.",
              "example": "key_example"
            },
            "rotationDeadline": {
              "type": "string",
              "format": "date-time",
              "description": "Deadline for revoking the previous key.",
              "example": "2025-02-01T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "rotationDeadline"
          ],
          "description": "Previous API key rotation metadata."
        }
      },
      "required": [
        "apiKey",
        "previousKey"
      ],
      "description": "API key rotation response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema040`

```json
{
  "type": "string",
  "enum": [
    "local",
    "fireblocks",
    "privy",
    "coinbase_cdp",
    "para",
    "turnkey",
    "dfns",
    "ibm_haven",
    "anchorage",
    "utila"
  ],
  "description": "Wallet signing provider.",
  "example": "privy"
}
```


### `#/components/schemas/ReviewSchema041`

```json
{
  "type": "boolean"
}
```


### `#/components/schemas/ReviewSchema042`

```json
{
  "type": "string",
  "enum": [
    "summary"
  ]
}
```


### `#/components/schemas/ReviewSchema043`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "wallets": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "description": "Wallet record ID.",
                "example": "cw_example"
              },
              "custodyConfigId": {
                "type": "string",
                "description": "Owning custody configuration ID.",
                "example": "cfg_example"
              },
              "custodyConnectionId": {
                "type": "string",
                "description": "Owning Custody Connection ID.",
                "example": "cconn_example"
              },
              "provider": {
                "type": "string",
                "enum": [
                  "local",
                  "fireblocks",
                  "privy",
                  "coinbase_cdp",
                  "para",
                  "turnkey",
                  "dfns",
                  "ibm_haven",
                  "anchorage",
                  "utila"
                ],
                "description": "Wallet signing provider.",
                "example": "privy"
              },
              "isRuntimeExecutionAllowed": {
                "type": "boolean",
                "description": "Whether SDP currently permits attempting runtime execution through this wallet's owner. This is request-time admission, not Provider health or a success guarantee.",
                "example": true
              },
              "walletId": {
                "type": "string",
                "minLength": 1,
                "description": "Provider wallet ID.",
                "example": "privy_wallet_123"
              },
              "publicKey": {
                "type": "string",
                "minLength": 32,
                "maxLength": 44,
                "description": "Base58-encoded Solana address.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "label": {
                "type": "string",
                "nullable": true,
                "description": "Optional wallet label.",
                "example": "Root Signing Wallet"
              },
              "purpose": {
                "type": "string",
                "nullable": true,
                "enum": [
                  "root",
                  "mint_authority",
                  "freeze_authority",
                  "fee_payer",
                  "transfer",
                  "dvp_settlement_authority",
                  null
                ],
                "description": "Optional wallet purpose.",
                "example": "root"
              },
              "status": {
                "type": "string",
                "enum": [
                  "active",
                  "inactive"
                ],
                "description": "Wallet status.",
                "example": "active"
              },
              "createdAt": {
                "type": "string",
                "format": "date-time",
                "description": "ISO 8601 timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "balances": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "token": {
                      "type": "string",
                      "description": "Tracked token symbol.",
                      "example": "USDC"
                    },
                    "mint": {
                      "type": "string",
                      "minLength": 32,
                      "maxLength": 44,
                      "description": "Tracked token mint address.",
                      "example": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
                    },
                    "amount": {
                      "type": "string",
                      "description": "Raw token amount as a string.",
                      "example": "1250000"
                    },
                    "uiAmount": {
                      "type": "string",
                      "description": "Human-readable token balance.",
                      "example": "1.25"
                    },
                    "decimals": {
                      "type": "integer",
                      "minimum": 0,
                      "description": "Token decimals.",
                      "example": 6
                    },
                    "usdPrice": {
                      "type": "number",
                      "description": "Resolved USD price per token when available.",
                      "example": 1
                    },
                    "usdValue": {
                      "type": "number",
                      "description": "Resolved USD value of this balance when pricing is available.",
                      "example": 125.5
                    }
                  },
                  "required": [
                    "token",
                    "mint",
                    "amount",
                    "uiAmount",
                    "decimals"
                  ],
                  "description": "Tracked fungible token balance."
                },
                "description": "Tracked token balances when requested and successfully observed. Omitted when the balance lookup is unavailable; an empty array is a successful zero-token result."
              }
            },
            "required": [
              "id",
              "isRuntimeExecutionAllowed",
              "walletId",
              "publicKey",
              "label",
              "purpose",
              "status",
              "createdAt"
            ],
            "oneOf": [
              {
                "description": "Owned by a Managed config.",
                "required": [
                  "custodyConfigId"
                ],
                "not": {
                  "required": [
                    "custodyConnectionId"
                  ]
                }
              },
              {
                "description": "Owned by a Custody Connection.",
                "required": [
                  "custodyConnectionId"
                ],
                "not": {
                  "required": [
                    "custodyConfigId"
                  ]
                }
              }
            ],
            "description": "Wallet details.",
            "example": {
              "id": "cw_example",
              "custodyConfigId": "cfg_example",
              "provider": "privy",
              "isRuntimeExecutionAllowed": true,
              "walletId": "privy_wallet_123",
              "publicKey": "So11111111111111111111111111111111111111112",
              "label": "Root Signing Wallet",
              "purpose": "root",
              "status": "active",
              "createdAt": "2025-01-01T00:00:00.000Z"
            }
          },
          "description": "Wallets."
        }
      },
      "required": [
        "wallets"
      ],
      "description": "Wallets list response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema044`

```json
{
  "type": "string",
  "pattern": "^[\\x20-\\x7e]{1,255}$",
  "description": "Optional, and honored when sent. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then takes over and is answered from the record it wrote. A 5xx is stored and replayed like any other answer; retry it with a new key.",
  "example": "idempotency_example_12345"
}
```


### `#/components/schemas/ReviewSchema045`

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string",
          "enum": [
            "local",
            "fireblocks",
            "privy",
            "coinbase_cdp",
            "para",
            "turnkey",
            "dfns",
            "ibm_haven",
            "anchorage",
            "utila"
          ],
          "description": "Provider whose Managed config owns the new wallet. A project holds one active config per provider.",
          "example": "privy"
        },
        "label": {
          "type": "string",
          "maxLength": 100,
          "description": "Optional label for the new wallet.",
          "example": "Mint authority wallet"
        },
        "purpose": {
          "type": "string",
          "enum": [
            "transfer",
            "mint_authority",
            "freeze_authority",
            "fee_payer"
          ],
          "default": "transfer",
          "description": "What the wallet is for. Defaults to `transfer`, the only purpose a payment, transfer batch or recurring payment can send from.",
          "example": "mint_authority"
        }
      },
      "required": [
        "provider"
      ],
      "not": {
        "required": [
          "connectionId"
        ]
      },
      "description": "Create a wallet under the project's Managed config for provider."
    },
    {
      "type": "object",
      "properties": {
        "connectionId": {
          "type": "string",
          "minLength": 1,
          "description": "Custody Connection (BYOK) that owns the new wallet.",
          "example": "cconn_123"
        },
        "label": {
          "type": "string",
          "maxLength": 100,
          "description": "Optional label for the new wallet.",
          "example": "Mint authority wallet"
        },
        "purpose": {
          "type": "string",
          "enum": [
            "transfer",
            "mint_authority",
            "freeze_authority",
            "fee_payer"
          ],
          "default": "transfer",
          "description": "What the wallet is for. Defaults to `transfer`, the only purpose a payment, transfer batch or recurring payment can send from.",
          "example": "mint_authority"
        }
      },
      "required": [
        "connectionId"
      ],
      "not": {
        "required": [
          "provider"
        ]
      },
      "description": "Create a wallet under a Custody Connection."
    }
  ],
  "description": "Create wallet request body. Names exactly one owner: provider (Managed config) or connectionId (Custody Connection); a body naming both, or neither, is rejected with 400.",
  "example": {
    "provider": "privy",
    "label": "Treasury wallet",
    "purpose": "transfer"
  }
}
```


### `#/components/schemas/ReviewSchema046`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "wallet": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "Wallet record ID.",
              "example": "cw_example"
            },
            "custodyConfigId": {
              "type": "string",
              "description": "Owning custody configuration ID.",
              "example": "cfg_example"
            },
            "custodyConnectionId": {
              "type": "string",
              "description": "Owning Custody Connection ID.",
              "example": "cconn_example"
            },
            "provider": {
              "type": "string",
              "enum": [
                "local",
                "fireblocks",
                "privy",
                "coinbase_cdp",
                "para",
                "turnkey",
                "dfns",
                "ibm_haven",
                "anchorage",
                "utila"
              ],
              "description": "Wallet signing provider.",
              "example": "privy"
            },
            "isRuntimeExecutionAllowed": {
              "type": "boolean",
              "description": "Whether SDP currently permits attempting runtime execution through this wallet's owner. This is request-time admission, not Provider health or a success guarantee.",
              "example": true
            },
            "walletId": {
              "type": "string",
              "minLength": 1,
              "description": "Provider wallet ID.",
              "example": "privy_wallet_123"
            },
            "publicKey": {
              "type": "string",
              "minLength": 32,
              "maxLength": 44,
              "description": "Base58-encoded Solana address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "label": {
              "type": "string",
              "nullable": true,
              "description": "Optional wallet label.",
              "example": "Root Signing Wallet"
            },
            "purpose": {
              "type": "string",
              "nullable": true,
              "enum": [
                "root",
                "mint_authority",
                "freeze_authority",
                "fee_payer",
                "transfer",
                "dvp_settlement_authority",
                null
              ],
              "description": "Optional wallet purpose.",
              "example": "root"
            },
            "status": {
              "type": "string",
              "enum": [
                "active",
                "inactive"
              ],
              "description": "Wallet status.",
              "example": "active"
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "balances": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "token": {
                    "type": "string",
                    "description": "Tracked token symbol.",
                    "example": "USDC"
                  },
                  "mint": {
                    "type": "string",
                    "minLength": 32,
                    "maxLength": 44,
                    "description": "Tracked token mint address.",
                    "example": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
                  },
                  "amount": {
                    "type": "string",
                    "description": "Raw token amount as a string.",
                    "example": "1250000"
                  },
                  "uiAmount": {
                    "type": "string",
                    "description": "Human-readable token balance.",
                    "example": "1.25"
                  },
                  "decimals": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Token decimals.",
                    "example": 6
                  },
                  "usdPrice": {
                    "type": "number",
                    "description": "Resolved USD price per token when available.",
                    "example": 1
                  },
                  "usdValue": {
                    "type": "number",
                    "description": "Resolved USD value of this balance when pricing is available.",
                    "example": 125.5
                  }
                },
                "required": [
                  "token",
                  "mint",
                  "amount",
                  "uiAmount",
                  "decimals"
                ],
                "description": "Tracked fungible token balance."
              },
              "description": "Tracked token balances when requested and successfully observed. Omitted when the balance lookup is unavailable; an empty array is a successful zero-token result."
            }
          },
          "required": [
            "id",
            "isRuntimeExecutionAllowed",
            "walletId",
            "publicKey",
            "label",
            "purpose",
            "status",
            "createdAt"
          ],
          "oneOf": [
            {
              "description": "Owned by a Managed config.",
              "required": [
                "custodyConfigId"
              ],
              "not": {
                "required": [
                  "custodyConnectionId"
                ]
              }
            },
            {
              "description": "Owned by a Custody Connection.",
              "required": [
                "custodyConnectionId"
              ],
              "not": {
                "required": [
                  "custodyConfigId"
                ]
              }
            }
          ],
          "description": "Wallet details.",
          "example": {
            "id": "cw_example",
            "custodyConfigId": "cfg_example",
            "provider": "privy",
            "isRuntimeExecutionAllowed": true,
            "walletId": "privy_wallet_123",
            "publicKey": "So11111111111111111111111111111111111111112",
            "label": "Root Signing Wallet",
            "purpose": "root",
            "status": "active",
            "createdAt": "2025-01-01T00:00:00.000Z"
          }
        }
      },
      "required": [
        "wallet"
      ],
      "description": "Created wallet response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema047`

```json
{
  "type": "object",
  "properties": {
    "provider": {
      "type": "string",
      "enum": [
        "local",
        "fireblocks",
        "privy",
        "coinbase_cdp",
        "para",
        "turnkey",
        "dfns",
        "ibm_haven",
        "anchorage",
        "utila"
      ],
      "description": "Optional consistency assertion for the Provider of the wallet being deleted.",
      "example": "anchorage"
    },
    "walletId": {
      "type": "string",
      "minLength": 1,
      "description": "Provider wallet ID to delete from its exact owning target.",
      "example": "anchorage_wallet_123"
    }
  },
  "required": [
    "walletId"
  ],
  "description": "Delete wallet request body."
}
```


### `#/components/schemas/ReviewSchema048`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "walletId": {
          "type": "string",
          "minLength": 1,
          "description": "Wallet ID that was deleted.",
          "example": "anchorage_wallet_123"
        },
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ],
          "description": "Deletion confirmation flag.",
          "example": true
        }
      },
      "required": [
        "walletId",
        "deleted"
      ],
      "description": "Delete wallet response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema049`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "aggregate": {
          "type": "object",
          "properties": {
            "walletCount": {
              "type": "integer",
              "minimum": 0,
              "description": "Number of wallets included in the aggregate.",
              "example": 3
            },
            "balances": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "token": {
                    "type": "string",
                    "description": "Tracked token symbol.",
                    "example": "USDC"
                  },
                  "mint": {
                    "type": "string",
                    "minLength": 32,
                    "maxLength": 44,
                    "description": "Tracked token mint address.",
                    "example": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
                  },
                  "amount": {
                    "type": "string",
                    "description": "Raw token amount as a string.",
                    "example": "1250000"
                  },
                  "uiAmount": {
                    "type": "string",
                    "description": "Human-readable token balance.",
                    "example": "1.25"
                  },
                  "decimals": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Token decimals.",
                    "example": 6
                  },
                  "usdPrice": {
                    "type": "number",
                    "description": "Resolved USD price per token when available.",
                    "example": 1
                  },
                  "usdValue": {
                    "type": "number",
                    "description": "Resolved USD value of this balance when pricing is available.",
                    "example": 125.5
                  }
                },
                "required": [
                  "token",
                  "mint",
                  "amount",
                  "uiAmount",
                  "decimals"
                ],
                "description": "Tracked fungible token balance."
              },
              "description": "Aggregated tracked token balances across the included wallets."
            }
          },
          "required": [
            "walletCount",
            "balances"
          ],
          "description": "Aggregated wallet balance summary."
        }
      },
      "required": [
        "aggregate"
      ],
      "description": "Aggregated wallet balance response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema050`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "configs": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "description": "Wallet signing config ID.",
                "example": "cfg_example"
              },
              "organizationId": {
                "type": "string",
                "description": "Organization ID that owns this wallet signing config.",
                "example": "org_example"
              },
              "projectId": {
                "type": "string",
                "nullable": true,
                "minLength": 1,
                "description": "Optional project scope for this config.",
                "example": "prj_example"
              },
              "provider": {
                "type": "string",
                "enum": [
                  "local",
                  "fireblocks",
                  "privy",
                  "coinbase_cdp",
                  "para",
                  "turnkey",
                  "dfns",
                  "ibm_haven",
                  "anchorage",
                  "utila"
                ],
                "description": "Wallet signing provider.",
                "example": "privy"
              },
              "status": {
                "type": "string",
                "enum": [
                  "active",
                  "inactive"
                ],
                "description": "Config status.",
                "example": "active"
              },
              "createdAt": {
                "type": "string",
                "format": "date-time",
                "description": "ISO 8601 timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              }
            },
            "required": [
              "id",
              "organizationId",
              "projectId",
              "provider",
              "status",
              "createdAt"
            ]
          },
          "description": "Active wallet signing configurations for the requested scope."
        }
      },
      "required": [
        "configs"
      ],
      "description": "Wallet signing configurations response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema051`

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string",
          "enum": [
            "local"
          ]
        },
        "walletLabel": {
          "type": "string",
          "maxLength": 100
        }
      },
      "required": [
        "provider"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string",
          "enum": [
            "fireblocks"
          ]
        },
        "walletLabel": {
          "type": "string",
          "maxLength": 100
        }
      },
      "required": [
        "provider"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string",
          "enum": [
            "privy"
          ]
        },
        "requestDelayMs": {
          "type": "integer",
          "minimum": 0,
          "maximum": 3000
        },
        "walletLabel": {
          "type": "string",
          "maxLength": 100
        }
      },
      "required": [
        "provider"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string",
          "enum": [
            "coinbase_cdp"
          ]
        },
        "network": {
          "type": "string",
          "enum": [
            "solana",
            "solana-devnet"
          ]
        },
        "accountPolicy": {
          "type": "string",
          "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
        },
        "walletLabel": {
          "type": "string",
          "maxLength": 100
        }
      },
      "required": [
        "provider"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string",
          "enum": [
            "para"
          ]
        },
        "requestDelayMs": {
          "type": "integer",
          "minimum": 0,
          "maximum": 3000
        },
        "walletLabel": {
          "type": "string",
          "maxLength": 100
        }
      },
      "required": [
        "provider"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string",
          "enum": [
            "turnkey"
          ]
        },
        "requestDelayMs": {
          "type": "integer",
          "minimum": 0,
          "maximum": 3000
        },
        "walletLabel": {
          "type": "string",
          "maxLength": 100
        }
      },
      "required": [
        "provider"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string",
          "enum": [
            "dfns"
          ]
        },
        "network": {
          "type": "string",
          "enum": [
            "Solana",
            "SolanaDevnet"
          ]
        },
        "walletLabel": {
          "type": "string",
          "maxLength": 100
        }
      },
      "required": [
        "provider"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string",
          "enum": [
            "ibm_haven"
          ]
        },
        "network": {
          "type": "string",
          "enum": [
            "Solana",
            "SolanaDevnet"
          ]
        },
        "walletLabel": {
          "type": "string",
          "maxLength": 100
        }
      },
      "required": [
        "provider"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string",
          "enum": [
            "anchorage"
          ]
        },
        "walletLabel": {
          "type": "string",
          "maxLength": 100
        },
        "network": {
          "type": "string",
          "enum": [
            "solana",
            "solana-devnet"
          ]
        }
      },
      "required": [
        "provider"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string",
          "enum": [
            "utila"
          ]
        },
        "walletLabel": {
          "type": "string",
          "maxLength": 100
        }
      },
      "required": [
        "provider"
      ],
      "additionalProperties": false
    }
  ],
  "description": "Initialize wallet signing provider for the project resolved from the request context."
}
```


### `#/components/schemas/ReviewSchema052`

```json
{
  "type": "object",
  "properties": {
    "configId": {
      "type": "string",
      "description": "Created wallet signing config ID.",
      "example": "cfg_example"
    },
    "publicKey": {
      "type": "string",
      "minLength": 32,
      "maxLength": 44,
      "description": "Public key of the provisioned root wallet.",
      "example": "So11111111111111111111111111111111111111112"
    },
    "walletId": {
      "type": "string",
      "minLength": 1,
      "description": "Provider wallet ID of the provisioned root wallet.",
      "example": "privy_wallet_123"
    }
  },
  "required": [
    "configId",
    "publicKey",
    "walletId"
  ],
  "description": "Wallet signing initialization result."
}
```


### `#/components/schemas/ReviewSchema053`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Provider wallet ID — the `walletId` field returned by GET /v1/wallets.",
  "example": "privy_wallet_123"
}
```


### `#/components/schemas/ReviewSchema054`

```json
{
  "type": "object",
  "properties": {
    "publicKey": {
      "type": "string",
      "minLength": 32,
      "maxLength": 44,
      "description": "Base58-encoded Solana address.",
      "example": "So11111111111111111111111111111111111111112"
    }
  },
  "required": [
    "publicKey"
  ],
  "description": "Wallet public key response payload."
}
```


### `#/components/schemas/ReviewSchema055`

```json
{
  "type": "object",
  "properties": {
    "walletId": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "walletId"
  ],
  "description": "walletId is the Provider wallet ID to check, required. Ambiguous Provider IDs are rejected; the check uses the resolved exact connected wallet record, and an API key may check only a wallet within its wallet scope.",
  "example": {
    "walletId": "privy_wallet_123"
  }
}
```


### `#/components/schemas/ReviewSchema056`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "walletId": {
          "type": "string",
          "minLength": 1,
          "description": "Resolved signing wallet ID.",
          "example": "privy_wallet_123"
        },
        "walletAddress": {
          "type": "string",
          "minLength": 32,
          "maxLength": 44,
          "description": "Resolved signer address used for the check message.",
          "example": "So11111111111111111111111111111111111111112"
        },
        "feePayer": {
          "type": "string",
          "minLength": 32,
          "maxLength": 44,
          "description": "Funded fee payer address used in the simulated message; nothing is spent from it.",
          "example": "So11111111111111111111111111111111111111112"
        },
        "memo": {
          "type": "string",
          "description": "Server-generated memo text in the simulated check message.",
          "example": "SDP signer check 123e4567-e89b-42d3-a456-426614174000"
        },
        "signature": {
          "type": "string",
          "description": "The connected wallet's Ed25519 signature over the check message, base58. Verified server-side and exercised in RPC simulation only — the check never broadcasts, so this signature does not exist on chain.",
          "example": "sig_example"
        },
        "simulated": {
          "type": "boolean",
          "enum": [
            true
          ],
          "description": "Always true: signer checks run in simulation and cannot spend sponsorship."
        },
        "checkedAt": {
          "type": "string",
          "format": "date-time",
          "description": "Timestamp recorded after the simulation succeeded.",
          "example": "2026-02-20T00:00:00.000Z"
        }
      },
      "required": [
        "walletId",
        "walletAddress",
        "feePayer",
        "memo",
        "signature",
        "simulated",
        "checkedAt"
      ],
      "description": "Signer check response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema057`

```json
{
  "type": "string",
  "enum": [
    "true",
    "false"
  ],
  "description": "Whether to resolve the current SOL balance. Defaults to true; false returns metadata without balance RPC or pricing calls.",
  "example": "false"
}
```


### `#/components/schemas/ReviewSchema058`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "wallet": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "Wallet record ID.",
              "example": "cw_example"
            },
            "custodyConfigId": {
              "type": "string",
              "description": "Owning custody configuration ID.",
              "example": "cfg_example"
            },
            "custodyConnectionId": {
              "type": "string",
              "description": "Owning Custody Connection ID.",
              "example": "cconn_example"
            },
            "provider": {
              "type": "string",
              "enum": [
                "local",
                "fireblocks",
                "privy",
                "coinbase_cdp",
                "para",
                "turnkey",
                "dfns",
                "ibm_haven",
                "anchorage",
                "utila"
              ],
              "description": "Wallet signing provider.",
              "example": "privy"
            },
            "isRuntimeExecutionAllowed": {
              "type": "boolean",
              "description": "Whether SDP currently permits attempting runtime execution through this wallet's owner. This is request-time admission, not Provider health or a success guarantee.",
              "example": true
            },
            "walletId": {
              "type": "string",
              "minLength": 1,
              "description": "Provider wallet ID.",
              "example": "privy_wallet_123"
            },
            "publicKey": {
              "type": "string",
              "minLength": 32,
              "maxLength": 44,
              "description": "Base58-encoded Solana address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "label": {
              "type": "string",
              "nullable": true,
              "description": "Optional wallet label.",
              "example": "Root Signing Wallet"
            },
            "purpose": {
              "type": "string",
              "nullable": true,
              "enum": [
                "root",
                "mint_authority",
                "freeze_authority",
                "fee_payer",
                "transfer",
                "dvp_settlement_authority",
                null
              ],
              "description": "Optional wallet purpose.",
              "example": "root"
            },
            "status": {
              "type": "string",
              "enum": [
                "active",
                "inactive"
              ],
              "description": "Wallet status.",
              "example": "active"
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "balance": {
              "type": "object",
              "properties": {
                "token": {
                  "type": "string",
                  "enum": [
                    "SOL"
                  ],
                  "description": "Balance token symbol.",
                  "example": "SOL"
                },
                "mint": {
                  "type": "string",
                  "description": "Native SOL mint address.",
                  "example": "So11111111111111111111111111111111111111112"
                },
                "amount": {
                  "type": "string",
                  "description": "Raw lamports balance as a string.",
                  "example": "123456789"
                },
                "uiAmount": {
                  "type": "string",
                  "description": "Human-readable SOL balance.",
                  "example": "0.123456789"
                },
                "decimals": {
                  "type": "number",
                  "enum": [
                    9
                  ],
                  "description": "Token decimals for SOL.",
                  "example": 9
                }
              },
              "required": [
                "token",
                "mint",
                "amount",
                "uiAmount",
                "decimals"
              ],
              "description": "Current SOL balance for the wallet public key. Omitted when includeBalance=false."
            }
          },
          "required": [
            "id",
            "provider",
            "isRuntimeExecutionAllowed",
            "walletId",
            "publicKey",
            "label",
            "purpose",
            "status",
            "createdAt"
          ],
          "oneOf": [
            {
              "description": "Owned by a Managed config.",
              "required": [
                "custodyConfigId"
              ],
              "not": {
                "required": [
                  "custodyConnectionId"
                ]
              }
            },
            {
              "description": "Owned by a Custody Connection.",
              "required": [
                "custodyConnectionId"
              ],
              "not": {
                "required": [
                  "custodyConfigId"
                ]
              }
            }
          ],
          "description": "Wallet details with provider and optional SOL balance.",
          "example": {
            "id": "cw_example",
            "custodyConfigId": "cfg_example",
            "provider": "privy",
            "isRuntimeExecutionAllowed": true,
            "walletId": "privy_wallet_123",
            "publicKey": "So11111111111111111111111111111111111111112",
            "label": "Root Signing Wallet",
            "purpose": "root",
            "status": "active",
            "createdAt": "2025-01-01T00:00:00.000Z"
          }
        }
      },
      "required": [
        "wallet"
      ],
      "description": "Wallet details by ID response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema059`

```json
{
  "type": "object",
  "properties": {
    "label": {
      "type": "string",
      "nullable": true,
      "maxLength": 100,
      "description": "Optional wallet label. Set to null to clear the label.",
      "example": "Treasury signer"
    }
  },
  "description": "Update wallet request body."
}
```


### `#/components/schemas/ReviewSchema060`

```json
{
  "type": "integer",
  "minimum": 0,
  "exclusiveMinimum": true,
  "default": 1,
  "description": "Page number (1-based).",
  "example": 1
}
```


### `#/components/schemas/ReviewSchema061`

```json
{
  "type": "integer",
  "minimum": 1,
  "maximum": 100,
  "default": 20,
  "description": "Items per page (max 100).",
  "example": 20
}
```


### `#/components/schemas/ReviewSchema062`

```json
{
  "type": "boolean",
  "description": "Include archived counterparties in results.",
  "example": false
}
```


### `#/components/schemas/ReviewSchema063`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "counterparties": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "description": "Counterparty identifier.",
                "example": "cpty_example"
              },
              "organizationId": {
                "type": "string",
                "minLength": 1,
                "description": "Organization identifier.",
                "example": "org_example"
              },
              "projectId": {
                "type": "string",
                "nullable": true,
                "minLength": 1,
                "description": "Project scope when the counterparty is project-scoped.",
                "example": "prj_example"
              },
              "externalId": {
                "type": "string",
                "nullable": true,
                "description": "Caller-supplied opaque identifier for cross-system reference. Do not place personal data in this indexed field.",
                "example": "customer_42"
              },
              "entityType": {
                "type": "string",
                "enum": [
                  "individual",
                  "business"
                ],
                "description": "Counterparty entity type.",
                "example": "individual"
              },
              "displayName": {
                "type": "string",
                "description": "Human-readable, searchable display name. Keep it minimal because this indexed field is not application-encrypted.",
                "example": "Jane Doe"
              },
              "status": {
                "type": "string",
                "enum": [
                  "active",
                  "archived"
                ],
                "description": "Counterparty status.",
                "example": "active"
              },
              "createdBy": {
                "type": "string",
                "nullable": true,
                "minLength": 1,
                "description": "User who created the counterparty. Null when created via API key.",
                "example": "usr_example"
              },
              "createdAt": {
                "type": "string",
                "format": "date-time",
                "description": "Creation timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "updatedAt": {
                "type": "string",
                "format": "date-time",
                "description": "Last update timestamp.",
                "example": "2025-01-02T00:00:00.000Z"
              }
            },
            "required": [
              "id",
              "organizationId",
              "projectId",
              "externalId",
              "entityType",
              "displayName",
              "status",
              "createdBy",
              "createdAt",
              "updatedAt"
            ],
            "description": "Counterparty record."
          },
          "description": "Counterparties."
        },
        "total": {
          "type": "integer",
          "minimum": 0,
          "description": "Total counterparties matching the query.",
          "example": 42
        },
        "page": {
          "type": "integer",
          "minimum": 0,
          "exclusiveMinimum": true,
          "description": "Current page number.",
          "example": 1
        },
        "pageSize": {
          "type": "integer",
          "minimum": 0,
          "exclusiveMinimum": true,
          "description": "Items per page.",
          "example": 20
        }
      },
      "required": [
        "counterparties",
        "total",
        "page",
        "pageSize"
      ],
      "description": "Paginated list of counterparties."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema064`

```json
{
  "type": "object",
  "properties": {
    "externalId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 256,
      "description": "Caller-supplied opaque identifier for cross-system reference. Do not place personal data in this indexed field.",
      "example": "customer_42"
    },
    "entityType": {
      "type": "string",
      "enum": [
        "individual",
        "business"
      ],
      "description": "Counterparty entity type.",
      "example": "individual"
    },
    "displayName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512,
      "description": "Human-readable, searchable display name. Keep it minimal because this indexed field is not application-encrypted.",
      "example": "Jane Doe"
    }
  },
  "required": [
    "entityType",
    "displayName"
  ],
  "description": "Create counterparty request body."
}
```


### `#/components/schemas/ReviewSchema065`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "counterparty": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1,
              "description": "Counterparty identifier.",
              "example": "cpty_example"
            },
            "organizationId": {
              "type": "string",
              "minLength": 1,
              "description": "Organization identifier.",
              "example": "org_example"
            },
            "projectId": {
              "type": "string",
              "nullable": true,
              "minLength": 1,
              "description": "Project scope when the counterparty is project-scoped.",
              "example": "prj_example"
            },
            "externalId": {
              "type": "string",
              "nullable": true,
              "description": "Caller-supplied opaque identifier for cross-system reference. Do not place personal data in this indexed field.",
              "example": "customer_42"
            },
            "entityType": {
              "type": "string",
              "enum": [
                "individual",
                "business"
              ],
              "description": "Counterparty entity type.",
              "example": "individual"
            },
            "displayName": {
              "type": "string",
              "description": "Human-readable, searchable display name. Keep it minimal because this indexed field is not application-encrypted.",
              "example": "Jane Doe"
            },
            "status": {
              "type": "string",
              "enum": [
                "active",
                "archived"
              ],
              "description": "Counterparty status.",
              "example": "active"
            },
            "createdBy": {
              "type": "string",
              "nullable": true,
              "minLength": 1,
              "description": "User who created the counterparty. Null when created via API key.",
              "example": "usr_example"
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "Creation timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "updatedAt": {
              "type": "string",
              "format": "date-time",
              "description": "Last update timestamp.",
              "example": "2025-01-02T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "organizationId",
            "projectId",
            "externalId",
            "entityType",
            "displayName",
            "status",
            "createdBy",
            "createdAt",
            "updatedAt"
          ],
          "description": "Counterparty record."
        }
      },
      "required": [
        "counterparty"
      ],
      "description": "Counterparty response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema066`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "fields": {
          "type": "object",
          "properties": {
            "entityTypes": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "individual",
                  "business"
                ]
              }
            },
            "countries": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "code": {
                    "type": "string",
                    "description": "ISO 3166-1 alpha-2 code.",
                    "example": "US"
                  },
                  "name": {
                    "type": "string",
                    "description": "English display name.",
                    "example": "United States"
                  }
                },
                "required": [
                  "code",
                  "name"
                ],
                "description": "Country option."
              }
            }
          },
          "required": [
            "entityTypes",
            "countries"
          ]
        }
      },
      "required": [
        "fields"
      ],
      "description": "Field option sets for building a counterparty form: closed enums plus the country list."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema067`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Counterparty identifier.",
  "example": "cpty_example"
}
```


### `#/components/schemas/ReviewSchema068`

```json
{
  "type": "object",
  "properties": {
    "externalId": {
      "type": "string",
      "nullable": true,
      "minLength": 1,
      "maxLength": 256,
      "description": "Updated opaque external ID. Do not include personal data. Use null to clear.",
      "example": "customer_42"
    },
    "entityType": {
      "type": "string",
      "enum": [
        "individual",
        "business"
      ],
      "description": "Updated counterparty entity type.",
      "example": "business"
    },
    "displayName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512,
      "description": "Updated searchable display name. Keep it minimal.",
      "example": "Jane Q. Doe"
    }
  },
  "description": "Update counterparty request body. At least one field must be provided.",
  "minProperties": 1
}
```


### `#/components/schemas/ReviewSchema069`

```json
{
  "type": "boolean",
  "description": "Include archived counterparty accounts in results.",
  "example": false
}
```


### `#/components/schemas/ReviewSchema070`

```json
{
  "type": "string",
  "enum": [
    "crypto_wallet"
  ],
  "description": "Filter accounts by account kind.",
  "example": "crypto_wallet"
}
```


### `#/components/schemas/ReviewSchema071`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "accounts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "description": "Counterparty account identifier.",
                "example": "cpacct_example"
              },
              "organizationId": {
                "type": "string",
                "minLength": 1,
                "description": "Organization identifier.",
                "example": "org_example"
              },
              "projectId": {
                "type": "string",
                "minLength": 1,
                "description": "Project identifier.",
                "example": "prj_example"
              },
              "counterpartyId": {
                "type": "string",
                "minLength": 1,
                "description": "Counterparty identifier.",
                "example": "cpty_example"
              },
              "accountKind": {
                "type": "string",
                "enum": [
                  "crypto_wallet"
                ],
                "description": "Counterparty account kind.",
                "example": "crypto_wallet"
              },
              "label": {
                "type": "string",
                "nullable": true,
                "description": "Optional human-readable account label.",
                "example": "USDC wallet"
              },
              "details": {
                "type": "object",
                "additionalProperties": {
                  "nullable": true
                },
                "description": "Account details. For crypto_wallet accounts, include network: \"solana\" and address as a Solana wallet address.",
                "example": {
                  "network": "solana",
                  "address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
                }
              },
              "providerAccountData": {
                "type": "object",
                "additionalProperties": {
                  "nullable": true
                },
                "description": "Provider-specific account metadata preserved by SDP.",
                "example": {}
              },
              "status": {
                "type": "string",
                "enum": [
                  "active",
                  "archived"
                ],
                "description": "Counterparty account status.",
                "example": "active"
              },
              "createdAt": {
                "type": "string",
                "format": "date-time",
                "description": "Creation timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "updatedAt": {
                "type": "string",
                "format": "date-time",
                "description": "Last update timestamp.",
                "example": "2025-01-02T00:00:00.000Z"
              }
            },
            "required": [
              "id",
              "organizationId",
              "projectId",
              "counterpartyId",
              "accountKind",
              "label",
              "details",
              "providerAccountData",
              "status",
              "createdAt",
              "updatedAt"
            ],
            "description": "Counterparty payment account record."
          },
          "description": "Counterparty accounts."
        },
        "total": {
          "type": "integer",
          "minimum": 0,
          "description": "Total counterparty accounts matching the query.",
          "example": 2
        },
        "page": {
          "type": "integer",
          "minimum": 0,
          "exclusiveMinimum": true,
          "description": "Current page number.",
          "example": 1
        },
        "pageSize": {
          "type": "integer",
          "minimum": 0,
          "exclusiveMinimum": true,
          "description": "Items per page.",
          "example": 20
        }
      },
      "required": [
        "accounts",
        "total",
        "page",
        "pageSize"
      ],
      "description": "Paginated list of counterparty accounts."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema072`

```json
{
  "type": "object",
  "properties": {
    "accountKind": {
      "type": "string",
      "enum": [
        "crypto_wallet"
      ],
      "description": "Counterparty account kind.",
      "example": "crypto_wallet"
    },
    "label": {
      "type": "string",
      "minLength": 1,
      "maxLength": 256,
      "description": "Optional account label.",
      "example": "USDC wallet"
    },
    "details": {
      "type": "object",
      "additionalProperties": {
        "nullable": true
      },
      "description": "For crypto_wallet accounts, must include network: \"solana\" and address as a Solana wallet address.",
      "example": {
        "network": "solana",
        "address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
      }
    },
    "providerAccountData": {
      "type": "object",
      "additionalProperties": {
        "nullable": true
      },
      "description": "Provider-specific metadata to preserve with the account.",
      "example": {}
    }
  },
  "required": [
    "accountKind"
  ],
  "description": "Create counterparty account request body."
}
```


### `#/components/schemas/ReviewSchema073`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "account": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "Counterparty account identifier.",
              "example": "cpacct_example"
            },
            "organizationId": {
              "type": "string",
              "minLength": 1,
              "description": "Organization identifier.",
              "example": "org_example"
            },
            "projectId": {
              "type": "string",
              "minLength": 1,
              "description": "Project identifier.",
              "example": "prj_example"
            },
            "counterpartyId": {
              "type": "string",
              "minLength": 1,
              "description": "Counterparty identifier.",
              "example": "cpty_example"
            },
            "accountKind": {
              "type": "string",
              "enum": [
                "crypto_wallet"
              ],
              "description": "Counterparty account kind.",
              "example": "crypto_wallet"
            },
            "label": {
              "type": "string",
              "nullable": true,
              "description": "Optional human-readable account label.",
              "example": "USDC wallet"
            },
            "details": {
              "type": "object",
              "additionalProperties": {
                "nullable": true
              },
              "description": "Account details. For crypto_wallet accounts, include network: \"solana\" and address as a Solana wallet address.",
              "example": {
                "network": "solana",
                "address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
              }
            },
            "providerAccountData": {
              "type": "object",
              "additionalProperties": {
                "nullable": true
              },
              "description": "Provider-specific account metadata preserved by SDP.",
              "example": {}
            },
            "status": {
              "type": "string",
              "enum": [
                "active",
                "archived"
              ],
              "description": "Counterparty account status.",
              "example": "active"
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "Creation timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "updatedAt": {
              "type": "string",
              "format": "date-time",
              "description": "Last update timestamp.",
              "example": "2025-01-02T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "organizationId",
            "projectId",
            "counterpartyId",
            "accountKind",
            "label",
            "details",
            "providerAccountData",
            "status",
            "createdAt",
            "updatedAt"
          ],
          "description": "Counterparty payment account record."
        }
      },
      "required": [
        "account"
      ],
      "description": "Counterparty account response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema074`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Counterparty account identifier.",
  "example": "cpacct_example"
}
```


### `#/components/schemas/ReviewSchema075`

```json
{
  "type": "object",
  "properties": {
    "label": {
      "type": "string",
      "nullable": true,
      "minLength": 1,
      "maxLength": 256,
      "description": "Updated account label. Use null to clear.",
      "example": "Primary USDC wallet"
    },
    "details": {
      "type": "object",
      "additionalProperties": {
        "nullable": true
      },
      "description": "Updated account details. Crypto-wallet accounts must retain network: \"solana\" and a valid Solana wallet address.",
      "example": {
        "network": "solana",
        "address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
      }
    },
    "providerAccountData": {
      "type": "object",
      "additionalProperties": {
        "nullable": true
      },
      "description": "Updated provider-specific metadata.",
      "example": {}
    }
  },
  "description": "Update counterparty account request body. At least one field must be provided.",
  "minProperties": 1
}
```


### `#/components/schemas/ReviewSchema076`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Filter by exact source SDP Wallet ID.",
  "example": "cwlt_example"
}
```


### `#/components/schemas/ReviewSchema077`

```json
{
  "type": "string",
  "description": "Filter by token symbol or mint.",
  "example": "SOL"
}
```


### `#/components/schemas/ReviewSchema078`

```json
{
  "type": "string",
  "enum": [
    "pending",
    "processing",
    "confirmed",
    "failed",
    "partially_failed",
    "archived"
  ],
  "description": "Filter by transfer batch status.",
  "example": "processing"
}
```


### `#/components/schemas/ReviewSchema079`

```json
{
  "type": "string",
  "minLength": 1,
  "maxLength": 256,
  "description": "Filter by caller-provided batch correlation ID.",
  "example": "payroll_2026_06_30"
}
```


### `#/components/schemas/ReviewSchema080`

```json
{
  "type": "integer",
  "minimum": 1,
  "maximum": 100,
  "default": 20,
  "description": "Number of batches per page.",
  "example": 20
}
```


### `#/components/schemas/ReviewSchema081`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "description": "Transfer batch identifier.",
            "example": "xbatch_example"
          },
          "organizationId": {
            "type": "string",
            "minLength": 1,
            "description": "Organization identifier.",
            "example": "org_example"
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "description": "Project identifier for the transfer batch.",
            "example": "prj_example"
          },
          "externalId": {
            "type": "string",
            "nullable": true,
            "description": "Caller-provided batch correlation ID.",
            "example": "payroll_2026_06_30"
          },
          "sourceCustodyWalletId": {
            "type": "string",
            "nullable": true,
            "description": "Exact source SDP Wallet ID, or null for unresolved legacy batches.",
            "example": "cwlt_example"
          },
          "sourceProviderWalletId": {
            "type": "string",
            "minLength": 1,
            "description": "Source Provider wallet ID retained as evidence.",
            "example": "privy_wallet_123"
          },
          "sourceAddress": {
            "type": "string",
            "minLength": 32,
            "maxLength": 44,
            "description": "Source connected wallet address.",
            "example": "So11111111111111111111111111111111111111112"
          },
          "token": {
            "type": "string",
            "description": "Token symbol or mint address.",
            "example": "SOL"
          },
          "status": {
            "type": "string",
            "enum": [
              "pending",
              "processing",
              "confirmed",
              "failed",
              "partially_failed",
              "archived"
            ],
            "description": "Transfer batch status.",
            "example": "processing"
          },
          "totalAmount": {
            "type": "string",
            "nullable": true,
            "description": "Total requested batch amount in UI units, when computed.",
            "example": "1000.00"
          },
          "recipientCount": {
            "type": "integer",
            "description": "Number of recipient rows in the batch.",
            "example": 20
          },
          "transactionCount": {
            "type": "integer",
            "description": "Number of Solana transaction chunks for the batch.",
            "example": 1
          },
          "createdAt": {
            "type": "string",
            "format": "date-time",
            "description": "ISO 8601 timestamp.",
            "example": "2025-01-01T00:00:00.000Z"
          },
          "updatedAt": {
            "type": "string",
            "format": "date-time",
            "description": "ISO 8601 timestamp.",
            "example": "2025-01-01T00:00:00.000Z"
          }
        },
        "required": [
          "id",
          "organizationId",
          "projectId",
          "externalId",
          "sourceCustodyWalletId",
          "sourceProviderWalletId",
          "sourceAddress",
          "token",
          "status",
          "totalAmount",
          "recipientCount",
          "transactionCount",
          "createdAt",
          "updatedAt"
        ],
        "description": "Transfer batch summary."
      }
    },
    "meta": {
      "type": "object",
      "properties": {
        "total": {
          "type": "integer",
          "minimum": 0,
          "description": "Total items."
        },
        "page": {
          "type": "integer",
          "minimum": 0,
          "exclusiveMinimum": true,
          "description": "Current page number."
        },
        "pageSize": {
          "type": "integer",
          "minimum": 0,
          "exclusiveMinimum": true,
          "description": "Items per page."
        },
        "hasMore": {
          "type": "boolean",
          "description": "Whether more pages exist."
        },
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        }
      },
      "required": [
        "total",
        "page",
        "pageSize",
        "hasMore",
        "requestId"
      ],
      "description": "Pagination metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard paginated response envelope."
}
```


### `#/components/schemas/ReviewSchema082`

```json
{
  "type": "string",
  "pattern": "^[\\x20-\\x7e]{1,255}$",
  "description": "Required: a request without one returns 400 `IDEMPOTENCY_KEY_REQUIRED`. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then takes over and is answered from the record it wrote. Once the request has written its record, any answer below 500 is stored: a transfer that fails after that (such as 400 `TRANSACTION_FAILED` or a 409 signer mismatch) answers a same-key retry with the same error and `Idempotent-Replayed: true`, and after 24 hours the record answers with the same status and code. A 5xx is not stored: a same-key retry runs again and is answered from the record. To try again after a failure, send the request with a new key. After a 5xx, a retry with the same key runs again and answers from the original record instead of acting twice; that answer also carries `Idempotent-Replayed: true`.",
  "example": "idempotency_example_12345"
}
```


### `#/components/schemas/ReviewSchema083`

```json
{
  "type": "object",
  "properties": {
    "projectId": {
      "type": "string",
      "minLength": 1,
      "description": "Project identifier for the transfer batch context.",
      "example": "prj_example"
    },
    "sourceCustodyWalletId": {
      "type": "string",
      "minLength": 1,
      "description": "Exact SDP Wallet ID (`id` from `GET /v1/wallets`).",
      "example": "cwlt_example"
    },
    "token": {
      "type": "string",
      "description": "Token to transfer. Pass `SOL` for the native token, a well-known token symbol (e.g. `USDC`) resolved to the configured cluster's mint, or a base58 SPL mint address. Custom tokens must be specified by their on-chain mint.",
      "example": "SOL"
    },
    "recipients": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "externalId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          },
          "counterpartyId": {
            "type": "string",
            "minLength": 1
          },
          "counterpartyAccountId": {
            "type": "string",
            "minLength": 1
          },
          "amount": {
            "type": "string"
          }
        },
        "required": [
          "counterpartyAccountId",
          "amount"
        ]
      },
      "minItems": 1,
      "maxItems": 500,
      "description": "Counterparty-account recipients to pay in this batch.",
      "example": [
        {
          "externalId": "payroll_row_001",
          "counterpartyId": "cpty_example",
          "counterpartyAccountId": "cpacct_example",
          "amount": "25.00"
        }
      ]
    },
    "options": {
      "type": "object",
      "properties": {
        "maxRecipientsPerTransaction": {
          "type": "integer",
          "minimum": 1,
          "maximum": 64
        },
        "priorityFee": {
          "type": "string",
          "enum": [
            "none",
            "low",
            "medium",
            "high",
            "auto"
          ]
        },
        "preflight": {
          "type": "boolean"
        }
      },
      "description": "Execution options for transaction chunking, priority fees, and preflight validation.",
      "example": {
        "maxRecipientsPerTransaction": 20,
        "priorityFee": "auto",
        "preflight": true
      }
    },
    "externalId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 256,
      "description": "Your ID for this payout run, unique per project and source wallet. Derive it from your own data so a restarted worker computes the same value (for example `payroll-2026-05`); never generate it at random, which gives no protection. Sending the same request again with this `externalId`, from the same credential, under any Idempotency-Key returns the existing batch; a different request with it returns `409 TRANSFER_BATCH_RUN_EXISTS` with the existing batch's `batchId` in `error.details`. Neither pays anyone again. New recipients go in a new run with a new `externalId`. Required: it is what stops a resend under a new Idempotency-Key from paying the same recipients twice.",
      "example": "payroll_2026_06_30"
    }
  },
  "required": [
    "sourceCustodyWalletId",
    "token",
    "recipients",
    "externalId"
  ],
  "additionalProperties": false,
  "description": "Create an outbound transfer batch."
}
```


### `#/components/schemas/ReviewSchema084`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "batch": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "Transfer batch identifier.",
              "example": "xbatch_example"
            },
            "organizationId": {
              "type": "string",
              "minLength": 1,
              "description": "Organization identifier.",
              "example": "org_example"
            },
            "projectId": {
              "type": "string",
              "minLength": 1,
              "description": "Project identifier for the transfer batch.",
              "example": "prj_example"
            },
            "externalId": {
              "type": "string",
              "nullable": true,
              "description": "Caller-provided batch correlation ID.",
              "example": "payroll_2026_06_30"
            },
            "sourceCustodyWalletId": {
              "type": "string",
              "nullable": true,
              "description": "Exact source SDP Wallet ID, or null for unresolved legacy batches.",
              "example": "cwlt_example"
            },
            "sourceProviderWalletId": {
              "type": "string",
              "minLength": 1,
              "description": "Source Provider wallet ID retained as evidence.",
              "example": "privy_wallet_123"
            },
            "sourceAddress": {
              "type": "string",
              "minLength": 32,
              "maxLength": 44,
              "description": "Source connected wallet address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "token": {
              "type": "string",
              "description": "Token symbol or mint address.",
              "example": "SOL"
            },
            "status": {
              "type": "string",
              "enum": [
                "pending",
                "processing",
                "confirmed",
                "failed",
                "partially_failed",
                "archived"
              ],
              "description": "Transfer batch status.",
              "example": "processing"
            },
            "totalAmount": {
              "type": "string",
              "nullable": true,
              "description": "Total requested batch amount in UI units, when computed.",
              "example": "1000.00"
            },
            "recipientCount": {
              "type": "integer",
              "description": "Number of recipient rows in the batch.",
              "example": 20
            },
            "transactionCount": {
              "type": "integer",
              "description": "Number of Solana transaction chunks for the batch.",
              "example": 1
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "updatedAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "organizationId",
            "projectId",
            "externalId",
            "sourceCustodyWalletId",
            "sourceProviderWalletId",
            "sourceAddress",
            "token",
            "status",
            "totalAmount",
            "recipientCount",
            "transactionCount",
            "createdAt",
            "updatedAt"
          ],
          "description": "Transfer batch details."
        },
        "recipients": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "description": "Transfer batch recipient identifier."
              },
              "batchId": {
                "type": "string",
                "description": "Parent transfer batch identifier."
              },
              "transferId": {
                "type": "string",
                "nullable": true,
                "minLength": 1,
                "description": "Payment transfer chunk that settled this recipient, once assigned.",
                "example": "xfr_example"
              },
              "externalId": {
                "type": "string",
                "nullable": true,
                "description": "Caller-provided recipient correlation ID.",
                "example": "payroll_row_001"
              },
              "counterpartyId": {
                "type": "string",
                "description": "Counterparty identifier for the recipient.",
                "example": "cpty_example"
              },
              "counterpartyAccountId": {
                "type": "string",
                "description": "Counterparty account identifier for the recipient.",
                "example": "cpacct_example"
              },
              "destination": {
                "type": "string",
                "minLength": 32,
                "maxLength": 44,
                "description": "Resolved Solana destination address.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "amount": {
                "type": "string",
                "description": "Token amount in UI units (decimal string).",
                "example": "100.00"
              },
              "status": {
                "type": "string",
                "enum": [
                  "pending",
                  "processing",
                  "confirmed",
                  "failed",
                  "archived"
                ],
                "description": "Transfer batch recipient status.",
                "example": "pending"
              },
              "error": {
                "type": "string",
                "nullable": true,
                "description": "Recipient-level failure reason, when available."
              },
              "createdAt": {
                "type": "string",
                "format": "date-time",
                "description": "ISO 8601 timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "updatedAt": {
                "type": "string",
                "format": "date-time",
                "description": "ISO 8601 timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              }
            },
            "required": [
              "id",
              "batchId",
              "transferId",
              "externalId",
              "counterpartyId",
              "counterpartyAccountId",
              "destination",
              "amount",
              "status",
              "error",
              "createdAt",
              "updatedAt"
            ],
            "description": "Recipient-level line within a transfer batch."
          },
          "description": "Recipient rows for the batch, included on detail responses."
        },
        "transfers": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "fireblocks": {
                "type": "object",
                "properties": {
                  "transactionId": {
                    "type": "string",
                    "nullable": true
                  },
                  "status": {
                    "type": "string"
                  },
                  "subStatus": {
                    "type": "string",
                    "nullable": true
                  }
                },
                "required": [
                  "transactionId",
                  "status",
                  "subStatus"
                ],
                "description": "Native Fireblocks transfer tracking. A processing payment may await approval in Fireblocks; network fees are paid by its source vault. A missing transaction ID means submission is still being reconciled. Do not create a replacement payment while its outcome is unknown."
              },
              "id": {
                "type": "string",
                "minLength": 1,
                "description": "Transfer identifier (SDP record ID, not the on-chain signature).",
                "example": "xfr_example"
              },
              "organizationId": {
                "type": "string",
                "minLength": 1,
                "description": "Organization identifier.",
                "example": "org_example"
              },
              "custodyWalletId": {
                "type": "string",
                "nullable": true,
                "description": "Exact SDP Wallet ID associated with the persisted transfer, or null for unresolved legacy and observed rows.",
                "example": "cwlt_example"
              },
              "providerWalletId": {
                "type": "string",
                "minLength": 1,
                "description": "Provider wallet ID retained as evidence; not an execution selector.",
                "example": "privy_wallet_123"
              },
              "projectId": {
                "type": "string",
                "minLength": 1,
                "description": "Project identifier for the transfer.",
                "example": "prj_example"
              },
              "type": {
                "type": "string",
                "enum": [
                  "transfer",
                  "transfer_batch",
                  "onramp",
                  "offramp"
                ],
                "description": "Transfer type.",
                "example": "transfer"
              },
              "kind": {
                "type": "string",
                "enum": [
                  "pay",
                  "confidential_pay",
                  "batch_pay",
                  "recurring_pay",
                  "deposit",
                  "request_deposit",
                  "onramp",
                  "offramp"
                ],
                "description": "Dashboard transaction kind derived from the transfer type and originating Payments resource."
              },
              "direction": {
                "type": "string",
                "enum": [
                  "inbound",
                  "outbound"
                ],
                "description": "Transfer direction.",
                "example": "outbound"
              },
              "status": {
                "type": "string",
                "enum": [
                  "pending",
                  "processing",
                  "confirmed",
                  "finalized",
                  "failed",
                  "awaiting_payment",
                  "settling",
                  "completed",
                  "canceled",
                  "expired"
                ],
                "description": "Transfer status.",
                "example": "confirmed"
              },
              "signature": {
                "type": "string",
                "nullable": true,
                "description": "Solana transaction signature (tx id/hash).",
                "example": "sig_example"
              },
              "serializedTx": {
                "type": "string",
                "nullable": true,
                "minLength": 1,
                "description": "Base64-encoded transaction payload, if available. Always null for transfer batch chunks, whose signed bytes stay server-side.",
                "example": "base64_tx_example"
              },
              "slot": {
                "type": "integer",
                "nullable": true,
                "description": "Slot number, if confirmed.",
                "example": 123456
              },
              "blockTime": {
                "type": "string",
                "nullable": true,
                "format": "date-time",
                "description": "Block time, if confirmed.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "confirmedAt": {
                "type": "string",
                "format": "date-time",
                "description": "When SDP confirmed the transfer. A ramp is confirmed once its delivery is verified onchain.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "fee": {
                "type": "integer",
                "nullable": true,
                "description": "Transaction fee in lamports.",
                "example": 5000
              },
              "error": {
                "type": "string",
                "nullable": true,
                "description": "Error message if the transaction failed.",
                "example": "Signature failed"
              },
              "initiatedBy": {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "enum": [
                      "api_key",
                      "user",
                      "system"
                    ],
                    "description": "Initiator type.",
                    "example": "api_key"
                  },
                  "id": {
                    "type": "string",
                    "description": "Initiator identifier if applicable."
                  },
                  "display": {
                    "type": "string",
                    "description": "Human-friendly label for the initiator."
                  }
                },
                "required": [
                  "type"
                ],
                "description": "Initiator that triggered the transfer."
              },
              "source": {
                "type": "string",
                "minLength": 32,
                "maxLength": 44,
                "description": "Source wallet address.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "destination": {
                "type": "string",
                "minLength": 32,
                "maxLength": 44,
                "description": "Destination wallet address.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "memo": {
                "type": "string",
                "maxLength": 256,
                "description": "Optional memo for the transfer."
              },
              "rampsMemo": {
                "type": "object",
                "additionalProperties": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 256
                },
                "description": "Free-form key-value memo for offchain reconciliation of ramp transfers. At most 20 entries.",
                "example": {
                  "invoice": "INV-123",
                  "po": "PO-9"
                }
              },
              "token": {
                "type": "string",
                "description": "Token symbol or mint address."
              },
              "amount": {
                "type": "string",
                "description": "Token amount in UI units (decimal string).",
                "example": "100.00"
              },
              "provider": {
                "type": "string",
                "enum": [
                  "moonpay",
                  "stripe",
                  "hercle",
                  "mural",
                  "moneygram",
                  "lightspark",
                  "coinbase",
                  "bvnk"
                ],
                "description": "Ramp provider for on-ramp and off-ramp transfer records. A retired provider's records keep its id.",
                "example": "moonpay"
              },
              "counterpartyId": {
                "type": "string",
                "description": "Counterparty tied to the transfer record, when available.",
                "example": "cpty_example"
              },
              "counterpartyDisplayName": {
                "type": "string",
                "description": "Current display name of the counterparty tied to the transfer.",
                "example": "Acme Studio"
              },
              "providerReference": {
                "type": "string",
                "description": "Provider quote or transaction reference used for ramp correlation.",
                "example": "ramp_quote_example"
              },
              "deliveryMode": {
                "type": "string",
                "enum": [
                  "hosted",
                  "manual_instructions",
                  "session_widget"
                ],
                "description": "Ramp delivery mode. Hosted flows require the customer to complete a provider-hosted UI; manual instructions require the customer to fund displayed instructions; session widgets use a provider SDK session.",
                "example": "session_widget"
              },
              "fiatCurrency": {
                "type": "string",
                "description": "Fiat currency for the ramp leg.",
                "example": "USD"
              },
              "fiatAmount": {
                "type": "string",
                "description": "Quoted fiat amount for the ramp leg: what the customer pays on an on-ramp, the payout quoted on an off-ramp. It never changes after the quote; an off-ramp's final payout is `fiatPayout`.",
                "example": "100.00"
              },
              "settlement": {
                "type": "object",
                "properties": {
                  "provider": {
                    "type": "string",
                    "enum": [
                      "moonpay"
                    ]
                  },
                  "status": {
                    "type": "string",
                    "enum": [
                      "completed",
                      "failed"
                    ]
                  },
                  "transactionId": {
                    "type": "string",
                    "description": "MoonPay transaction id."
                  },
                  "baseCurrencyCode": {
                    "type": "string",
                    "description": "Fiat currency paid."
                  },
                  "baseCurrencyAmount": {
                    "type": "number",
                    "description": "Fiat amount paid."
                  },
                  "quoteCurrencyCode": {
                    "type": "string",
                    "description": "Crypto currency purchased."
                  },
                  "quoteCurrencyAmount": {
                    "type": "number",
                    "description": "Crypto amount purchased."
                  },
                  "feeAmount": {
                    "type": "number",
                    "description": "Provider fee."
                  },
                  "extraFeeAmount": {
                    "type": "number",
                    "description": "Extra provider fee."
                  },
                  "networkFeeAmount": {
                    "type": "number",
                    "description": "Network fee."
                  },
                  "areFeesIncluded": {
                    "type": "boolean",
                    "description": "Whether the fees are included in the paid amount."
                  },
                  "usdRate": {
                    "type": "number",
                    "description": "USD exchange rate."
                  },
                  "cryptoTransactionId": {
                    "type": "string",
                    "description": "On-chain transaction id."
                  },
                  "failureReason": {
                    "type": "string",
                    "description": "Provider failure reason."
                  }
                },
                "required": [
                  "provider",
                  "status",
                  "transactionId",
                  "baseCurrencyCode",
                  "baseCurrencyAmount",
                  "quoteCurrencyCode",
                  "quoteCurrencyAmount",
                  "feeAmount",
                  "extraFeeAmount",
                  "networkFeeAmount",
                  "areFeesIncluded",
                  "usdRate"
                ],
                "description": "Provider-reported ramp settlement economics for live providers."
              },
              "fiatPayout": {
                "type": "object",
                "properties": {
                  "amount": {
                    "type": "string",
                    "description": "Fiat paid out, in display units. Differs from the quoted `fiatAmount` when the provider re-prices the sale at receipt.",
                    "example": "20.82"
                  },
                  "currency": {
                    "type": "string",
                    "description": "ISO currency of the payout, as the provider reports it.",
                    "example": "USD"
                  },
                  "reportedAt": {
                    "type": "string",
                    "format": "date-time",
                    "description": "When the provider reported the payout.",
                    "example": "2025-01-02T00:00:00.000Z"
                  }
                },
                "required": [
                  "amount",
                  "currency"
                ],
                "description": "What the provider reports paying out once it settles an off-ramp sale. Provider-reported: SDP cannot verify a bank payout."
              },
              "deliveryMismatch": {
                "type": "object",
                "properties": {
                  "reason": {
                    "type": "string",
                    "enum": [
                      "provider_report_mismatch",
                      "transaction_failed",
                      "predates_transfer",
                      "not_delivered",
                      "amount_mismatch",
                      "transaction_not_found"
                    ],
                    "description": "Why the chain contradicts the provider: `provider_report_mismatch` (its report contradicts SDP's record), `transaction_failed`, `predates_transfer` (the transaction landed before the transfer), `not_delivered` (nothing of the quoted asset reached the quoted wallet), `amount_mismatch`, or `transaction_not_found` (no finalized transaction an hour after the report; SDP keeps checking, and a later delivery completes the transfer).",
                    "example": "amount_mismatch"
                  },
                  "checkedAt": {
                    "type": "string",
                    "format": "date-time",
                    "description": "When SDP's delivery check reached this verdict.",
                    "example": "2025-01-02T00:00:00.000Z"
                  },
                  "reportedAmount": {
                    "type": "string",
                    "description": "What the provider reported delivering, in display units.",
                    "example": "20"
                  },
                  "observedAmount": {
                    "type": "string",
                    "description": "What the chain shows the quoted wallet received, in display units.",
                    "example": "0.5"
                  }
                },
                "required": [
                  "reason",
                  "checkedAt"
                ],
                "description": "Present while SDP holds a provider-settled ramp in `settling` because the chain contradicts the provider's delivery. A new provider report clears it."
              },
              "risk": {
                "type": "object",
                "properties": {
                  "provider": {
                    "type": "string",
                    "description": "Risk scoring provider.",
                    "example": "trm"
                  },
                  "score": {
                    "type": "string",
                    "description": "Provider-specific risk score.",
                    "example": "0.12"
                  },
                  "level": {
                    "type": "string",
                    "enum": [
                      "low",
                      "medium",
                      "high",
                      "unknown"
                    ],
                    "description": "Risk level classification.",
                    "example": "low"
                  },
                  "evaluatedAt": {
                    "type": "string",
                    "format": "date-time",
                    "description": "Timestamp when risk was evaluated.",
                    "example": "2025-01-01T00:00:00.000Z"
                  }
                },
                "required": [
                  "provider",
                  "score",
                  "level",
                  "evaluatedAt"
                ],
                "description": "Optional risk evaluation for the transfer."
              },
              "createdAt": {
                "type": "string",
                "format": "date-time",
                "description": "Creation timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "updatedAt": {
                "type": "string",
                "format": "date-time",
                "description": "Last update timestamp.",
                "example": "2025-01-02T00:00:00.000Z"
              }
            },
            "required": [
              "id",
              "organizationId",
              "custodyWalletId",
              "providerWalletId",
              "type",
              "kind",
              "direction",
              "status",
              "signature",
              "serializedTx",
              "slot",
              "blockTime",
              "fee",
              "error",
              "rampsMemo",
              "createdAt",
              "updatedAt"
            ],
            "description": "Transfer transaction record."
          },
          "description": "Payment transfer chunk records associated with this batch."
        }
      },
      "required": [
        "batch"
      ],
      "description": "Transfer batch response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema085`

```json
{
  "type": "object",
  "properties": {
    "projectId": {
      "type": "string",
      "minLength": 1,
      "description": "Project identifier for the transfer batch context.",
      "example": "prj_example"
    },
    "sourceCustodyWalletId": {
      "type": "string",
      "minLength": 1,
      "description": "Exact SDP Wallet ID (`id` from `GET /v1/wallets`).",
      "example": "cwlt_example"
    },
    "token": {
      "type": "string",
      "description": "Token to transfer. Pass `SOL` for the native token, a well-known token symbol (e.g. `USDC`) resolved to the configured cluster's mint, or a base58 SPL mint address. Custom tokens must be specified by their on-chain mint.",
      "example": "SOL"
    },
    "recipients": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "externalId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          },
          "counterpartyId": {
            "type": "string",
            "minLength": 1
          },
          "counterpartyAccountId": {
            "type": "string",
            "minLength": 1
          },
          "amount": {
            "type": "string"
          }
        },
        "required": [
          "counterpartyAccountId",
          "amount"
        ]
      },
      "minItems": 1,
      "maxItems": 500,
      "description": "Counterparty-account recipients to pay in this batch.",
      "example": [
        {
          "externalId": "payroll_row_001",
          "counterpartyId": "cpty_example",
          "counterpartyAccountId": "cpacct_example",
          "amount": "25.00"
        }
      ]
    },
    "options": {
      "type": "object",
      "properties": {
        "maxRecipientsPerTransaction": {
          "type": "integer",
          "minimum": 1,
          "maximum": 64
        },
        "priorityFee": {
          "type": "string",
          "enum": [
            "none",
            "low",
            "medium",
            "high",
            "auto"
          ]
        },
        "preflight": {
          "type": "boolean"
        }
      },
      "description": "Execution options for transaction chunking, priority fees, and preflight validation.",
      "example": {
        "maxRecipientsPerTransaction": 20,
        "priorityFee": "auto",
        "preflight": true
      }
    },
    "externalId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 256,
      "description": "Optional: an estimate moves nothing, so it names no payout run. Pass the run's `externalId` to estimate the batch you will create with it.",
      "example": "payroll_2026_06_30"
    }
  },
  "required": [
    "sourceCustodyWalletId",
    "token",
    "recipients"
  ],
  "additionalProperties": false,
  "description": "Estimate transaction chunking and fees for a transfer batch."
}
```


### `#/components/schemas/ReviewSchema086`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "estimate": {
          "type": "object",
          "properties": {
            "recipientCount": {
              "type": "integer",
              "description": "Requested recipient count."
            },
            "transactionCount": {
              "type": "integer",
              "description": "Estimated number of Solana transaction chunks."
            },
            "estimatedFees": {
              "type": "object",
              "properties": {
                "networkFeeLamports": {
                  "type": "string",
                  "description": "Estimated base network fee in lamports.",
                  "example": "5000"
                },
                "priorityFeeLamports": {
                  "type": "string",
                  "description": "Estimated priority fee in lamports.",
                  "example": "0"
                },
                "tokenAccountRentLamports": {
                  "type": "string",
                  "description": "Estimated rent needed for newly-created recipient token accounts.",
                  "example": "0"
                },
                "sponsored": {
                  "type": "boolean",
                  "description": "Whether SDP sponsors transaction fees for this batch.",
                  "example": true
                }
              },
              "required": [
                "networkFeeLamports",
                "priorityFeeLamports",
                "tokenAccountRentLamports",
                "sponsored"
              ],
              "description": "Estimated fee components."
            },
            "warnings": {
              "type": "array",
              "items": {
                "oneOf": [
                  {
                    "type": "object",
                    "properties": {
                      "code": {
                        "type": "string",
                        "enum": [
                          "AMOUNT_BELOW_RENT_MINIMUM"
                        ],
                        "description": "A native SOL recipient's address holds no account and its amount is below the rent-exempt minimum."
                      },
                      "recipientIndex": {
                        "type": "integer",
                        "description": "Zero-based index of the recipient in the request."
                      },
                      "minimumAmount": {
                        "type": "string",
                        "description": "The smallest SOL amount the address can receive while it has no account."
                      },
                      "message": {
                        "type": "string",
                        "description": "Human-readable warning."
                      }
                    },
                    "required": [
                      "code",
                      "recipientIndex",
                      "minimumAmount",
                      "message"
                    ],
                    "description": "A recipient the batch could not pay as requested."
                  },
                  {
                    "type": "object",
                    "properties": {
                      "code": {
                        "type": "string",
                        "enum": [
                          "SOURCE_BELOW_RENT_MINIMUM"
                        ],
                        "description": "The source wallet would be left holding more than nothing but less than the rent-exempt minimum, at the end or after some order of the batch's concurrent transactions."
                      },
                      "sourceRemainder": {
                        "type": "string",
                        "description": "The SOL the source wallet would be left with."
                      },
                      "minimumAmount": {
                        "type": "string",
                        "description": "The rent-exempt minimum for a SOL wallet."
                      },
                      "message": {
                        "type": "string",
                        "description": "Human-readable warning."
                      }
                    },
                    "required": [
                      "code",
                      "sourceRemainder",
                      "minimumAmount",
                      "message"
                    ],
                    "description": "The source wallet would fall below the rent minimum."
                  }
                ],
                "description": "Something create would refuse with 409 AMOUNT_BELOW_RENT_MINIMUM until it is fixed."
              },
              "description": "What would make the batch fail. Empty when the batch can be sent as estimated."
            }
          },
          "required": [
            "recipientCount",
            "transactionCount",
            "estimatedFees",
            "warnings"
          ],
          "description": "Transfer batch estimate."
        }
      },
      "required": [
        "estimate"
      ],
      "description": "Transfer batch estimate response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema087`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Transfer batch identifier.",
  "example": "xbatch_example"
}
```


### `#/components/schemas/ReviewSchema088`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Filter persisted transfers by exact SDP Wallet ID.",
  "example": "cwlt_example"
}
```


### `#/components/schemas/ReviewSchema089`

```json
{
  "type": "string",
  "maxLength": 200,
  "description": "Search transfer ID, signature, provider reference, source or destination address, memo, counterparty ID, or counterparty display name. Use at least 3 non-whitespace characters; a blank value is treated as no search filter.",
  "example": "xfr_example"
}
```


### `#/components/schemas/ReviewSchema090`

```json
{
  "type": "string",
  "description": "Filter by token symbol or mint.",
  "example": "USDC"
}
```


### `#/components/schemas/ReviewSchema091`

```json
{
  "type": "string",
  "enum": [
    "inbound",
    "outbound"
  ],
  "description": "Filter by transfer direction.",
  "example": "outbound"
}
```


### `#/components/schemas/ReviewSchema092`

```json
{
  "type": "string",
  "description": "Filter by transfer status. Accepts a comma-separated list of statuses.",
  "example": "completed,confirmed,finalized"
}
```


### `#/components/schemas/ReviewSchema093`

```json
{
  "type": "string",
  "enum": [
    "wallet",
    "ramp"
  ],
  "description": "Filter by wallet transfers or ramp transfers.",
  "example": "ramp"
}
```


### `#/components/schemas/ReviewSchema094`

```json
{
  "type": "string",
  "description": "Filter by one or more comma-separated transfer types.",
  "example": "transfer,transfer_batch"
}
```


### `#/components/schemas/ReviewSchema095`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Filter transfers tied to a specific counterparty.",
  "example": "cpty_example"
}
```


### `#/components/schemas/ReviewSchema096`

```json
{
  "type": "string",
  "enum": [
    "moonpay",
    "stripe"
  ],
  "description": "Filter ramp transfers by provider.",
  "example": "moonpay"
}
```


### `#/components/schemas/ReviewSchema097`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Provider quote or transaction reference. Must be supplied with provider for exact ramp transfer lookup.",
  "example": "Quote:019e979c-f660-5246-0000-c0588496b9ce"
}
```


### `#/components/schemas/ReviewSchema098`

```json
{
  "type": "string",
  "format": "date-time",
  "description": "Filter from timestamp.",
  "example": "2025-01-01T00:00:00.000Z"
}
```


### `#/components/schemas/ReviewSchema099`

```json
{
  "type": "string",
  "format": "date-time",
  "description": "Filter to timestamp.",
  "example": "2025-01-02T00:00:00.000Z"
}
```


### `#/components/schemas/ReviewSchema100`

```json
{
  "type": "string",
  "enum": [
    "true",
    "false"
  ],
  "default": false,
  "description": "When custodyWalletId is supplied, also include RPC-observed activity for that exact wallet row's address. Observed rows have custodyWalletId null.",
  "example": false
}
```


### `#/components/schemas/ReviewSchema101`

```json
{
  "type": "string",
  "enum": [
    "createdAt",
    "updatedAt",
    "amount",
    "status"
  ],
  "default": "createdAt",
  "description": "Field used to sort the transfer list.",
  "example": "createdAt"
}
```


### `#/components/schemas/ReviewSchema102`

```json
{
  "type": "string",
  "enum": [
    "asc",
    "desc"
  ],
  "default": "desc",
  "description": "Sort direction.",
  "example": "desc"
}
```


### `#/components/schemas/ReviewSchema103`

```json
{
  "type": "integer",
  "minimum": 1,
  "maximum": 100,
  "default": 20,
  "description": "Items per page.",
  "example": 20
}
```


### `#/components/schemas/ReviewSchema104`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "fireblocks": {
            "type": "object",
            "properties": {
              "transactionId": {
                "type": "string",
                "nullable": true
              },
              "status": {
                "type": "string"
              },
              "subStatus": {
                "type": "string",
                "nullable": true
              }
            },
            "required": [
              "transactionId",
              "status",
              "subStatus"
            ],
            "description": "Native Fireblocks transfer tracking. A processing payment may await approval in Fireblocks; network fees are paid by its source vault. A missing transaction ID means submission is still being reconciled. Do not create a replacement payment while its outcome is unknown."
          },
          "id": {
            "type": "string",
            "minLength": 1,
            "description": "Transfer identifier (SDP record ID, not the on-chain signature).",
            "example": "xfr_example"
          },
          "organizationId": {
            "type": "string",
            "minLength": 1,
            "description": "Organization identifier.",
            "example": "org_example"
          },
          "custodyWalletId": {
            "type": "string",
            "nullable": true,
            "description": "Exact SDP Wallet ID associated with the persisted transfer, or null for unresolved legacy and observed rows.",
            "example": "cwlt_example"
          },
          "providerWalletId": {
            "type": "string",
            "minLength": 1,
            "description": "Provider wallet ID retained as evidence; not an execution selector.",
            "example": "privy_wallet_123"
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "description": "Project identifier for the transfer.",
            "example": "prj_example"
          },
          "type": {
            "type": "string",
            "enum": [
              "transfer",
              "transfer_batch",
              "onramp",
              "offramp"
            ],
            "description": "Transfer type.",
            "example": "transfer"
          },
          "kind": {
            "type": "string",
            "enum": [
              "pay",
              "confidential_pay",
              "batch_pay",
              "recurring_pay",
              "deposit",
              "request_deposit",
              "onramp",
              "offramp"
            ],
            "description": "Dashboard transaction kind derived from the transfer type and originating Payments resource."
          },
          "direction": {
            "type": "string",
            "enum": [
              "inbound",
              "outbound"
            ],
            "description": "Transfer direction.",
            "example": "outbound"
          },
          "status": {
            "type": "string",
            "enum": [
              "pending",
              "processing",
              "confirmed",
              "finalized",
              "failed",
              "awaiting_payment",
              "settling",
              "completed",
              "canceled",
              "expired"
            ],
            "description": "Transfer status.",
            "example": "confirmed"
          },
          "signature": {
            "type": "string",
            "nullable": true,
            "description": "Solana transaction signature (tx id/hash).",
            "example": "sig_example"
          },
          "serializedTx": {
            "type": "string",
            "nullable": true,
            "minLength": 1,
            "description": "Base64-encoded transaction payload, if available. Always null for transfer batch chunks, whose signed bytes stay server-side.",
            "example": "base64_tx_example"
          },
          "slot": {
            "type": "integer",
            "nullable": true,
            "description": "Slot number, if confirmed.",
            "example": 123456
          },
          "blockTime": {
            "type": "string",
            "nullable": true,
            "format": "date-time",
            "description": "Block time, if confirmed.",
            "example": "2025-01-01T00:00:00.000Z"
          },
          "confirmedAt": {
            "type": "string",
            "format": "date-time",
            "description": "When SDP confirmed the transfer. A ramp is confirmed once its delivery is verified onchain.",
            "example": "2025-01-01T00:00:00.000Z"
          },
          "fee": {
            "type": "integer",
            "nullable": true,
            "description": "Transaction fee in lamports.",
            "example": 5000
          },
          "error": {
            "type": "string",
            "nullable": true,
            "description": "Error message if the transaction failed.",
            "example": "Signature failed"
          },
          "initiatedBy": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "enum": [
                  "api_key",
                  "user",
                  "system"
                ],
                "description": "Initiator type.",
                "example": "api_key"
              },
              "id": {
                "type": "string",
                "description": "Initiator identifier if applicable."
              },
              "display": {
                "type": "string",
                "description": "Human-friendly label for the initiator."
              }
            },
            "required": [
              "type"
            ],
            "description": "Initiator that triggered the transfer."
          },
          "source": {
            "type": "string",
            "minLength": 32,
            "maxLength": 44,
            "description": "Source wallet address.",
            "example": "So11111111111111111111111111111111111111112"
          },
          "destination": {
            "type": "string",
            "minLength": 32,
            "maxLength": 44,
            "description": "Destination wallet address.",
            "example": "So11111111111111111111111111111111111111112"
          },
          "memo": {
            "type": "string",
            "maxLength": 256,
            "description": "Optional memo for the transfer."
          },
          "rampsMemo": {
            "type": "object",
            "additionalProperties": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            "description": "Free-form key-value memo for offchain reconciliation of ramp transfers. At most 20 entries.",
            "example": {
              "invoice": "INV-123",
              "po": "PO-9"
            }
          },
          "token": {
            "type": "string",
            "description": "Token symbol or mint address."
          },
          "amount": {
            "type": "string",
            "description": "Token amount in UI units (decimal string).",
            "example": "100.00"
          },
          "provider": {
            "type": "string",
            "enum": [
              "moonpay",
              "stripe",
              "hercle",
              "mural",
              "moneygram",
              "lightspark",
              "coinbase",
              "bvnk"
            ],
            "description": "Ramp provider for on-ramp and off-ramp transfer records. A retired provider's records keep its id.",
            "example": "moonpay"
          },
          "counterpartyId": {
            "type": "string",
            "description": "Counterparty tied to the transfer record, when available.",
            "example": "cpty_example"
          },
          "counterpartyDisplayName": {
            "type": "string",
            "description": "Current display name of the counterparty tied to the transfer.",
            "example": "Acme Studio"
          },
          "providerReference": {
            "type": "string",
            "description": "Provider quote or transaction reference used for ramp correlation.",
            "example": "ramp_quote_example"
          },
          "deliveryMode": {
            "type": "string",
            "enum": [
              "hosted",
              "manual_instructions",
              "session_widget"
            ],
            "description": "Ramp delivery mode. Hosted flows require the customer to complete a provider-hosted UI; manual instructions require the customer to fund displayed instructions; session widgets use a provider SDK session.",
            "example": "session_widget"
          },
          "fiatCurrency": {
            "type": "string",
            "description": "Fiat currency for the ramp leg.",
            "example": "USD"
          },
          "fiatAmount": {
            "type": "string",
            "description": "Quoted fiat amount for the ramp leg: what the customer pays on an on-ramp, the payout quoted on an off-ramp. It never changes after the quote; an off-ramp's final payout is `fiatPayout`.",
            "example": "100.00"
          },
          "settlement": {
            "type": "object",
            "properties": {
              "provider": {
                "type": "string",
                "enum": [
                  "moonpay"
                ]
              },
              "status": {
                "type": "string",
                "enum": [
                  "completed",
                  "failed"
                ]
              },
              "transactionId": {
                "type": "string",
                "description": "MoonPay transaction id."
              },
              "baseCurrencyCode": {
                "type": "string",
                "description": "Fiat currency paid."
              },
              "baseCurrencyAmount": {
                "type": "number",
                "description": "Fiat amount paid."
              },
              "quoteCurrencyCode": {
                "type": "string",
                "description": "Crypto currency purchased."
              },
              "quoteCurrencyAmount": {
                "type": "number",
                "description": "Crypto amount purchased."
              },
              "feeAmount": {
                "type": "number",
                "description": "Provider fee."
              },
              "extraFeeAmount": {
                "type": "number",
                "description": "Extra provider fee."
              },
              "networkFeeAmount": {
                "type": "number",
                "description": "Network fee."
              },
              "areFeesIncluded": {
                "type": "boolean",
                "description": "Whether the fees are included in the paid amount."
              },
              "usdRate": {
                "type": "number",
                "description": "USD exchange rate."
              },
              "cryptoTransactionId": {
                "type": "string",
                "description": "On-chain transaction id."
              },
              "failureReason": {
                "type": "string",
                "description": "Provider failure reason."
              }
            },
            "required": [
              "provider",
              "status",
              "transactionId",
              "baseCurrencyCode",
              "baseCurrencyAmount",
              "quoteCurrencyCode",
              "quoteCurrencyAmount",
              "feeAmount",
              "extraFeeAmount",
              "networkFeeAmount",
              "areFeesIncluded",
              "usdRate"
            ],
            "description": "Provider-reported ramp settlement economics for live providers."
          },
          "fiatPayout": {
            "type": "object",
            "properties": {
              "amount": {
                "type": "string",
                "description": "Fiat paid out, in display units. Differs from the quoted `fiatAmount` when the provider re-prices the sale at receipt.",
                "example": "20.82"
              },
              "currency": {
                "type": "string",
                "description": "ISO currency of the payout, as the provider reports it.",
                "example": "USD"
              },
              "reportedAt": {
                "type": "string",
                "format": "date-time",
                "description": "When the provider reported the payout.",
                "example": "2025-01-02T00:00:00.000Z"
              }
            },
            "required": [
              "amount",
              "currency"
            ],
            "description": "What the provider reports paying out once it settles an off-ramp sale. Provider-reported: SDP cannot verify a bank payout."
          },
          "deliveryMismatch": {
            "type": "object",
            "properties": {
              "reason": {
                "type": "string",
                "enum": [
                  "provider_report_mismatch",
                  "transaction_failed",
                  "predates_transfer",
                  "not_delivered",
                  "amount_mismatch",
                  "transaction_not_found"
                ],
                "description": "Why the chain contradicts the provider: `provider_report_mismatch` (its report contradicts SDP's record), `transaction_failed`, `predates_transfer` (the transaction landed before the transfer), `not_delivered` (nothing of the quoted asset reached the quoted wallet), `amount_mismatch`, or `transaction_not_found` (no finalized transaction an hour after the report; SDP keeps checking, and a later delivery completes the transfer).",
                "example": "amount_mismatch"
              },
              "checkedAt": {
                "type": "string",
                "format": "date-time",
                "description": "When SDP's delivery check reached this verdict.",
                "example": "2025-01-02T00:00:00.000Z"
              },
              "reportedAmount": {
                "type": "string",
                "description": "What the provider reported delivering, in display units.",
                "example": "20"
              },
              "observedAmount": {
                "type": "string",
                "description": "What the chain shows the quoted wallet received, in display units.",
                "example": "0.5"
              }
            },
            "required": [
              "reason",
              "checkedAt"
            ],
            "description": "Present while SDP holds a provider-settled ramp in `settling` because the chain contradicts the provider's delivery. A new provider report clears it."
          },
          "risk": {
            "type": "object",
            "properties": {
              "provider": {
                "type": "string",
                "description": "Risk scoring provider.",
                "example": "trm"
              },
              "score": {
                "type": "string",
                "description": "Provider-specific risk score.",
                "example": "0.12"
              },
              "level": {
                "type": "string",
                "enum": [
                  "low",
                  "medium",
                  "high",
                  "unknown"
                ],
                "description": "Risk level classification.",
                "example": "low"
              },
              "evaluatedAt": {
                "type": "string",
                "format": "date-time",
                "description": "Timestamp when risk was evaluated.",
                "example": "2025-01-01T00:00:00.000Z"
              }
            },
            "required": [
              "provider",
              "score",
              "level",
              "evaluatedAt"
            ],
            "description": "Optional risk evaluation for the transfer."
          },
          "createdAt": {
            "type": "string",
            "format": "date-time",
            "description": "Creation timestamp.",
            "example": "2025-01-01T00:00:00.000Z"
          },
          "updatedAt": {
            "type": "string",
            "format": "date-time",
            "description": "Last update timestamp.",
            "example": "2025-01-02T00:00:00.000Z"
          }
        },
        "required": [
          "id",
          "organizationId",
          "custodyWalletId",
          "providerWalletId",
          "type",
          "kind",
          "direction",
          "status",
          "signature",
          "serializedTx",
          "slot",
          "blockTime",
          "fee",
          "error",
          "rampsMemo",
          "createdAt",
          "updatedAt"
        ],
        "description": "Transfer transaction record."
      }
    },
    "meta": {
      "type": "object",
      "properties": {
        "total": {
          "type": "integer",
          "minimum": 0,
          "description": "Total items."
        },
        "page": {
          "type": "integer",
          "minimum": 0,
          "exclusiveMinimum": true,
          "description": "Current page number."
        },
        "pageSize": {
          "type": "integer",
          "minimum": 0,
          "exclusiveMinimum": true,
          "description": "Items per page."
        },
        "hasMore": {
          "type": "boolean",
          "description": "Whether more pages exist."
        },
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        }
      },
      "required": [
        "total",
        "page",
        "pageSize",
        "hasMore",
        "requestId"
      ],
      "description": "Pagination metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard paginated response envelope."
}
```


### `#/components/schemas/ReviewSchema105`

```json
{
  "type": "object",
  "properties": {
    "projectId": {
      "type": "string",
      "minLength": 1,
      "description": "Project identifier for the transfer context.",
      "example": "prj_example"
    },
    "transferId": {
      "type": "string",
      "minLength": 1,
      "description": "Existing off-ramp transfer to use for the on-chain crypto deposit. The transfer must still be awaiting payment and must not already contain on-chain submission data."
    },
    "sourceCustodyWalletId": {
      "type": "string",
      "minLength": 1,
      "description": "Exact SDP Wallet ID (`id` from `GET /v1/wallets`).",
      "example": "cwlt_example"
    },
    "destination": {
      "type": "string",
      "description": "Destination wallet address.",
      "example": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    },
    "token": {
      "type": "string",
      "description": "Token to transfer. Pass `SOL` for the native token, a well-known token symbol (e.g. `USDC`) resolved to the configured cluster's mint, or a base58 SPL mint address. Custom tokens must be specified by their on-chain mint.",
      "example": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    },
    "amount": {
      "type": "string",
      "description": "Token amount in UI units (decimal string).",
      "example": "100.00"
    },
    "memo": {
      "type": "string",
      "maxLength": 256,
      "description": "Optional memo for the transfer."
    }
  },
  "required": [
    "sourceCustodyWalletId",
    "destination",
    "token",
    "amount"
  ],
  "additionalProperties": false,
  "description": "Create transfer request payload for a provider-connected source wallet. This endpoint does not provision wallets.",
  "example": {
    "projectId": "prj_example",
    "sourceCustodyWalletId": "cwlt_example",
    "destination": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    "token": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "amount": "100.00"
  }
}
```


### `#/components/schemas/ReviewSchema106`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "transfer": {
          "type": "object",
          "properties": {
            "fireblocks": {
              "type": "object",
              "properties": {
                "transactionId": {
                  "type": "string",
                  "nullable": true
                },
                "status": {
                  "type": "string"
                },
                "subStatus": {
                  "type": "string",
                  "nullable": true
                }
              },
              "required": [
                "transactionId",
                "status",
                "subStatus"
              ],
              "description": "Native Fireblocks transfer tracking. A processing payment may await approval in Fireblocks; network fees are paid by its source vault. A missing transaction ID means submission is still being reconciled. Do not create a replacement payment while its outcome is unknown."
            },
            "id": {
              "type": "string",
              "minLength": 1,
              "description": "Transfer identifier (SDP record ID, not the on-chain signature).",
              "example": "xfr_example"
            },
            "organizationId": {
              "type": "string",
              "minLength": 1,
              "description": "Organization identifier.",
              "example": "org_example"
            },
            "custodyWalletId": {
              "type": "string",
              "nullable": true,
              "description": "Exact SDP Wallet ID associated with the persisted transfer, or null for unresolved legacy and observed rows.",
              "example": "cwlt_example"
            },
            "providerWalletId": {
              "type": "string",
              "minLength": 1,
              "description": "Provider wallet ID retained as evidence; not an execution selector.",
              "example": "privy_wallet_123"
            },
            "projectId": {
              "type": "string",
              "minLength": 1,
              "description": "Project identifier for the transfer.",
              "example": "prj_example"
            },
            "type": {
              "type": "string",
              "enum": [
                "transfer",
                "transfer_batch",
                "onramp",
                "offramp"
              ],
              "description": "Transfer type.",
              "example": "transfer"
            },
            "kind": {
              "type": "string",
              "enum": [
                "pay",
                "confidential_pay",
                "batch_pay",
                "recurring_pay",
                "deposit",
                "request_deposit",
                "onramp",
                "offramp"
              ],
              "description": "Dashboard transaction kind derived from the transfer type and originating Payments resource."
            },
            "direction": {
              "type": "string",
              "enum": [
                "inbound",
                "outbound"
              ],
              "description": "Transfer direction.",
              "example": "outbound"
            },
            "status": {
              "type": "string",
              "enum": [
                "pending",
                "processing",
                "confirmed",
                "finalized",
                "failed",
                "awaiting_payment",
                "settling",
                "completed",
                "canceled",
                "expired"
              ],
              "description": "Transfer status.",
              "example": "confirmed"
            },
            "signature": {
              "type": "string",
              "nullable": true,
              "description": "Solana transaction signature (tx id/hash).",
              "example": "sig_example"
            },
            "serializedTx": {
              "type": "string",
              "nullable": true,
              "minLength": 1,
              "description": "Base64-encoded transaction payload, if available. Always null for transfer batch chunks, whose signed bytes stay server-side.",
              "example": "base64_tx_example"
            },
            "slot": {
              "type": "integer",
              "nullable": true,
              "description": "Slot number, if confirmed.",
              "example": 123456
            },
            "blockTime": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "Block time, if confirmed.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "confirmedAt": {
              "type": "string",
              "format": "date-time",
              "description": "When SDP confirmed the transfer. A ramp is confirmed once its delivery is verified onchain.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "fee": {
              "type": "integer",
              "nullable": true,
              "description": "Transaction fee in lamports.",
              "example": 5000
            },
            "error": {
              "type": "string",
              "nullable": true,
              "description": "Error message if the transaction failed.",
              "example": "Signature failed"
            },
            "initiatedBy": {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "enum": [
                    "api_key",
                    "user",
                    "system"
                  ],
                  "description": "Initiator type.",
                  "example": "api_key"
                },
                "id": {
                  "type": "string",
                  "description": "Initiator identifier if applicable."
                },
                "display": {
                  "type": "string",
                  "description": "Human-friendly label for the initiator."
                }
              },
              "required": [
                "type"
              ],
              "description": "Initiator that triggered the transfer."
            },
            "source": {
              "type": "string",
              "minLength": 32,
              "maxLength": 44,
              "description": "Source wallet address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "destination": {
              "type": "string",
              "minLength": 32,
              "maxLength": 44,
              "description": "Destination wallet address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "memo": {
              "type": "string",
              "maxLength": 256,
              "description": "Optional memo for the transfer."
            },
            "rampsMemo": {
              "type": "object",
              "additionalProperties": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              },
              "description": "Free-form key-value memo for offchain reconciliation of ramp transfers. At most 20 entries.",
              "example": {
                "invoice": "INV-123",
                "po": "PO-9"
              }
            },
            "token": {
              "type": "string",
              "description": "Token symbol or mint address."
            },
            "amount": {
              "type": "string",
              "description": "Token amount in UI units (decimal string).",
              "example": "100.00"
            },
            "provider": {
              "type": "string",
              "enum": [
                "moonpay",
                "stripe",
                "hercle",
                "mural",
                "moneygram",
                "lightspark",
                "coinbase",
                "bvnk"
              ],
              "description": "Ramp provider for on-ramp and off-ramp transfer records. A retired provider's records keep its id.",
              "example": "moonpay"
            },
            "counterpartyId": {
              "type": "string",
              "description": "Counterparty tied to the transfer record, when available.",
              "example": "cpty_example"
            },
            "counterpartyDisplayName": {
              "type": "string",
              "description": "Current display name of the counterparty tied to the transfer.",
              "example": "Acme Studio"
            },
            "providerReference": {
              "type": "string",
              "description": "Provider quote or transaction reference used for ramp correlation.",
              "example": "ramp_quote_example"
            },
            "deliveryMode": {
              "type": "string",
              "enum": [
                "hosted",
                "manual_instructions",
                "session_widget"
              ],
              "description": "Ramp delivery mode. Hosted flows require the customer to complete a provider-hosted UI; manual instructions require the customer to fund displayed instructions; session widgets use a provider SDK session.",
              "example": "session_widget"
            },
            "fiatCurrency": {
              "type": "string",
              "description": "Fiat currency for the ramp leg.",
              "example": "USD"
            },
            "fiatAmount": {
              "type": "string",
              "description": "Quoted fiat amount for the ramp leg: what the customer pays on an on-ramp, the payout quoted on an off-ramp. It never changes after the quote; an off-ramp's final payout is `fiatPayout`.",
              "example": "100.00"
            },
            "settlement": {
              "type": "object",
              "properties": {
                "provider": {
                  "type": "string",
                  "enum": [
                    "moonpay"
                  ]
                },
                "status": {
                  "type": "string",
                  "enum": [
                    "completed",
                    "failed"
                  ]
                },
                "transactionId": {
                  "type": "string",
                  "description": "MoonPay transaction id."
                },
                "baseCurrencyCode": {
                  "type": "string",
                  "description": "Fiat currency paid."
                },
                "baseCurrencyAmount": {
                  "type": "number",
                  "description": "Fiat amount paid."
                },
                "quoteCurrencyCode": {
                  "type": "string",
                  "description": "Crypto currency purchased."
                },
                "quoteCurrencyAmount": {
                  "type": "number",
                  "description": "Crypto amount purchased."
                },
                "feeAmount": {
                  "type": "number",
                  "description": "Provider fee."
                },
                "extraFeeAmount": {
                  "type": "number",
                  "description": "Extra provider fee."
                },
                "networkFeeAmount": {
                  "type": "number",
                  "description": "Network fee."
                },
                "areFeesIncluded": {
                  "type": "boolean",
                  "description": "Whether the fees are included in the paid amount."
                },
                "usdRate": {
                  "type": "number",
                  "description": "USD exchange rate."
                },
                "cryptoTransactionId": {
                  "type": "string",
                  "description": "On-chain transaction id."
                },
                "failureReason": {
                  "type": "string",
                  "description": "Provider failure reason."
                }
              },
              "required": [
                "provider",
                "status",
                "transactionId",
                "baseCurrencyCode",
                "baseCurrencyAmount",
                "quoteCurrencyCode",
                "quoteCurrencyAmount",
                "feeAmount",
                "extraFeeAmount",
                "networkFeeAmount",
                "areFeesIncluded",
                "usdRate"
              ],
              "description": "Provider-reported ramp settlement economics for live providers."
            },
            "fiatPayout": {
              "type": "object",
              "properties": {
                "amount": {
                  "type": "string",
                  "description": "Fiat paid out, in display units. Differs from the quoted `fiatAmount` when the provider re-prices the sale at receipt.",
                  "example": "20.82"
                },
                "currency": {
                  "type": "string",
                  "description": "ISO currency of the payout, as the provider reports it.",
                  "example": "USD"
                },
                "reportedAt": {
                  "type": "string",
                  "format": "date-time",
                  "description": "When the provider reported the payout.",
                  "example": "2025-01-02T00:00:00.000Z"
                }
              },
              "required": [
                "amount",
                "currency"
              ],
              "description": "What the provider reports paying out once it settles an off-ramp sale. Provider-reported: SDP cannot verify a bank payout."
            },
            "deliveryMismatch": {
              "type": "object",
              "properties": {
                "reason": {
                  "type": "string",
                  "enum": [
                    "provider_report_mismatch",
                    "transaction_failed",
                    "predates_transfer",
                    "not_delivered",
                    "amount_mismatch",
                    "transaction_not_found"
                  ],
                  "description": "Why the chain contradicts the provider: `provider_report_mismatch` (its report contradicts SDP's record), `transaction_failed`, `predates_transfer` (the transaction landed before the transfer), `not_delivered` (nothing of the quoted asset reached the quoted wallet), `amount_mismatch`, or `transaction_not_found` (no finalized transaction an hour after the report; SDP keeps checking, and a later delivery completes the transfer).",
                  "example": "amount_mismatch"
                },
                "checkedAt": {
                  "type": "string",
                  "format": "date-time",
                  "description": "When SDP's delivery check reached this verdict.",
                  "example": "2025-01-02T00:00:00.000Z"
                },
                "reportedAmount": {
                  "type": "string",
                  "description": "What the provider reported delivering, in display units.",
                  "example": "20"
                },
                "observedAmount": {
                  "type": "string",
                  "description": "What the chain shows the quoted wallet received, in display units.",
                  "example": "0.5"
                }
              },
              "required": [
                "reason",
                "checkedAt"
              ],
              "description": "Present while SDP holds a provider-settled ramp in `settling` because the chain contradicts the provider's delivery. A new provider report clears it."
            },
            "risk": {
              "type": "object",
              "properties": {
                "provider": {
                  "type": "string",
                  "description": "Risk scoring provider.",
                  "example": "trm"
                },
                "score": {
                  "type": "string",
                  "description": "Provider-specific risk score.",
                  "example": "0.12"
                },
                "level": {
                  "type": "string",
                  "enum": [
                    "low",
                    "medium",
                    "high",
                    "unknown"
                  ],
                  "description": "Risk level classification.",
                  "example": "low"
                },
                "evaluatedAt": {
                  "type": "string",
                  "format": "date-time",
                  "description": "Timestamp when risk was evaluated.",
                  "example": "2025-01-01T00:00:00.000Z"
                }
              },
              "required": [
                "provider",
                "score",
                "level",
                "evaluatedAt"
              ],
              "description": "Optional risk evaluation for the transfer."
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "Creation timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "updatedAt": {
              "type": "string",
              "format": "date-time",
              "description": "Last update timestamp.",
              "example": "2025-01-02T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "organizationId",
            "custodyWalletId",
            "providerWalletId",
            "type",
            "kind",
            "direction",
            "status",
            "signature",
            "serializedTx",
            "slot",
            "blockTime",
            "fee",
            "error",
            "rampsMemo",
            "createdAt",
            "updatedAt"
          ],
          "description": "Transfer details."
        }
      },
      "required": [
        "transfer"
      ],
      "description": "Transfer response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema107`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Transfer identifier (SDP record ID, not the on-chain signature).",
  "example": "xfr_example"
}
```


### `#/components/schemas/ReviewSchema108`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Provider wallet ID — the `walletId` field returned by GET /v1/wallets. The wallet record `id` and the public key are not accepted.",
  "example": "privy_wallet_123"
}
```


### `#/components/schemas/ReviewSchema109`

```json
{
  "type": "string",
  "pattern": "^(0|[1-9]\\d*)$"
}
```


### `#/components/schemas/ReviewSchema110`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "walletBalances": {
          "type": "object",
          "properties": {
            "walletId": {
              "type": "string",
              "minLength": 1,
              "description": "Provider wallet ID — the `walletId` field returned by GET /v1/wallets.",
              "example": "privy_wallet_123"
            },
            "address": {
              "type": "string",
              "minLength": 32,
              "maxLength": 44,
              "description": "Wallet address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "balances": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "token": {
                    "type": "string",
                    "description": "Token symbol or mint address.",
                    "example": "USDC"
                  },
                  "mint": {
                    "type": "string",
                    "minLength": 32,
                    "maxLength": 44,
                    "description": "Token mint address.",
                    "example": "So11111111111111111111111111111111111111112"
                  },
                  "amount": {
                    "type": "string",
                    "description": "Raw amount in smallest units.",
                    "example": "100000000"
                  },
                  "uiAmount": {
                    "type": "string",
                    "description": "Token amount in UI units (decimal string).",
                    "example": "100.00"
                  },
                  "decimals": {
                    "type": "integer",
                    "description": "Token decimals.",
                    "example": 6
                  },
                  "usdPrice": {
                    "type": "number",
                    "description": "Resolved USD price per token when available.",
                    "example": 1
                  },
                  "usdValue": {
                    "type": "number",
                    "description": "Resolved USD value of this balance when pricing is available.",
                    "example": 100
                  },
                  "confidential": {
                    "type": "boolean",
                    "description": "Confidential balance flag (when applicable).",
                    "example": false
                  }
                },
                "required": [
                  "token",
                  "mint",
                  "amount",
                  "uiAmount",
                  "decimals"
                ],
                "description": "Token balance details."
              },
              "description": "Token balances."
            }
          },
          "required": [
            "walletId",
            "address",
            "balances"
          ],
          "description": "Wallet balances details."
        },
        "balanceReadContext": {
          "type": "object",
          "properties": {
            "minimumSlot": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "minimumSlot"
          ]
        }
      },
      "required": [
        "walletBalances"
      ],
      "description": "Wallet balances response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema111`

```json
{
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "ok"
      ],
      "description": "Health status."
    },
    "timestamp": {
      "type": "string",
      "format": "date-time",
      "description": "Health check timestamp.",
      "example": "2025-01-01T00:00:00.000Z"
    },
    "version": {
      "type": "string",
      "description": "Service version.",
      "example": "0.1.0"
    },
    "environment": {
      "type": "string",
      "description": "Runtime environment.",
      "example": "production"
    },
    "releaseChannel": {
      "type": "string",
      "enum": [
        "experimental",
        "beta",
        "stable"
      ],
      "description": "Release channel: which modules this deployment runs.",
      "example": "experimental"
    }
  },
  "required": [
    "status",
    "timestamp",
    "version",
    "environment",
    "releaseChannel"
  ],
  "description": "Health check response payload."
}
```


### `#/components/schemas/ReviewSchema112`

```json
{
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "ready",
        "not_ready"
      ],
      "description": "Readiness status.",
      "example": "ready"
    },
    "timestamp": {
      "type": "string",
      "format": "date-time",
      "description": "Readiness check timestamp.",
      "example": "2025-01-01T00:00:00.000Z"
    },
    "revision": {
      "type": "string",
      "description": "Cloud Run revision serving the request, or `local` outside Cloud Run.",
      "example": "sdp-prod-api-public-00042-abc"
    },
    "commit": {
      "type": "string",
      "description": "Git commit the serving image was built from, or `local` when the image carries none.",
      "example": "0123456789abcdef0123456789abcdef01234567"
    },
    "checks": {
      "type": "object",
      "properties": {
        "database": {
          "type": "string",
          "enum": [
            "ok",
            "error"
          ],
          "description": "Database connectivity status.",
          "example": "ok"
        },
        "redis": {
          "type": "string",
          "enum": [
            "ok",
            "error"
          ],
          "description": "Redis connectivity status.",
          "example": "ok"
        },
        "egress": {
          "type": "string",
          "enum": [
            "pending",
            "ok",
            "unverified"
          ],
          "description": "Outbound internet connectivity of this instance. `pending` (not ready) while a fresh instance waits for working egress, `ok` once an outbound call succeeded, `unverified` when it stopped waiting and serves anyway. Absent where the deployment does not wait for egress.",
          "example": "ok"
        }
      },
      "required": [
        "database",
        "redis"
      ],
      "description": "Dependency health checks."
    }
  },
  "required": [
    "status",
    "timestamp",
    "revision",
    "commit",
    "checks"
  ],
  "description": "Readiness check response payload."
}
```


### `#/components/schemas/ReviewSchema113`

```json
{
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "ready",
        "not_ready"
      ],
      "description": "Readiness status.",
      "example": "ready"
    },
    "timestamp": {
      "type": "string",
      "format": "date-time",
      "description": "Readiness check timestamp.",
      "example": "2025-01-01T00:00:00.000Z"
    },
    "revision": {
      "type": "string",
      "description": "Cloud Run revision serving the request, or `local` outside Cloud Run.",
      "example": "sdp-prod-api-public-00042-abc"
    },
    "commit": {
      "type": "string",
      "description": "Git commit the serving image was built from, or `local` when the image carries none.",
      "example": "0123456789abcdef0123456789abcdef01234567"
    },
    "checks": {
      "type": "object",
      "properties": {
        "database": {
          "type": "string",
          "enum": [
            "ok",
            "error"
          ],
          "description": "Database connectivity status.",
          "example": "ok"
        },
        "redis": {
          "type": "string",
          "enum": [
            "ok",
            "error"
          ],
          "description": "Redis connectivity status.",
          "example": "ok"
        },
        "egress": {
          "type": "string",
          "enum": [
            "pending",
            "ok",
            "unverified"
          ],
          "description": "Outbound internet connectivity of this instance. `pending` (not ready) while a fresh instance waits for working egress, `ok` once an outbound call succeeded, `unverified` when it stopped waiting and serves anyway. Absent where the deployment does not wait for egress.",
          "example": "ok"
        }
      },
      "required": [
        "database",
        "redis"
      ],
      "description": "Dependency health checks."
    }
  },
  "required": [
    "status",
    "timestamp",
    "revision",
    "commit",
    "checks"
  ],
  "description": "Readiness check response payload.",
  "example": {
    "status": "not_ready",
    "timestamp": "2025-01-01T00:00:00.000Z",
    "revision": "sdp-prod-api-public-00042-abc",
    "commit": "0123456789abcdef0123456789abcdef01234567",
    "checks": {
      "database": "ok",
      "redis": "error",
      "egress": "ok"
    }
  }
}
```


### `#/components/schemas/ReviewSchema114`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "SDP payment request ID.",
  "example": "preq_example"
}
```


### `#/components/schemas/ReviewSchema115`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "SDP payment request ID.",
          "example": "preq_example"
        },
        "organizationId": {
          "type": "string",
          "description": "Organization ID."
        },
        "projectId": {
          "type": "string",
          "nullable": true,
          "description": "Project ID."
        },
        "walletId": {
          "type": "string",
          "description": "Receiving custody wallet's provider ID."
        },
        "destinationAddress": {
          "type": "string",
          "minLength": 32,
          "maxLength": 44,
          "description": "Address the payment is sent to.",
          "example": "So11111111111111111111111111111111111111112"
        },
        "token": {
          "type": "string",
          "description": "Token mint address."
        },
        "amount": {
          "type": "string",
          "description": "Token amount in UI units (decimal string).",
          "example": "100.00"
        },
        "reference": {
          "type": "string",
          "minLength": 32,
          "maxLength": 44,
          "description": "Solana Pay reference account that identifies the payment on chain.",
          "example": "So11111111111111111111111111111111111111112"
        },
        "status": {
          "type": "string",
          "enum": [
            "awaiting_payment",
            "paid",
            "canceled",
            "expired"
          ],
          "description": "Payment request status. `awaiting_payment` is open; `paid` was settled by an on-chain payment; `canceled` and `expired` closed without one.",
          "example": "canceled"
        },
        "expiresAt": {
          "type": "string",
          "nullable": true,
          "format": "date-time",
          "description": "Expiry, if any.",
          "example": "2025-01-01T00:00:00.000Z"
        },
        "fulfilledByTransferId": {
          "type": "string",
          "nullable": true,
          "description": "The inbound transfer that paid the request."
        },
        "paidLate": {
          "type": "boolean",
          "description": "Whether the payment landed after the request expired or was canceled. A payer who signed before then can still pay."
        },
        "lastCheckedAt": {
          "type": "string",
          "nullable": true,
          "format": "date-time",
          "description": "When SDP last read the chain for the payment.",
          "example": "2025-01-01T00:00:00.000Z"
        },
        "canceledByApiKeyId": {
          "type": "string",
          "nullable": true,
          "description": "The API key that canceled the request; null when a member did, or it is not canceled."
        },
        "canceledByUserId": {
          "type": "string",
          "nullable": true,
          "description": "User ID of the member who canceled the request; null when an API key did, or it is not canceled."
        },
        "canceledAt": {
          "type": "string",
          "nullable": true,
          "format": "date-time",
          "description": "When it was canceled.",
          "example": "2025-01-01T00:00:00.000Z"
        },
        "lifecycle": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "status": {
                "type": "string",
                "enum": [
                  "awaiting_payment",
                  "paid",
                  "canceled",
                  "expired"
                ],
                "description": "Payment request status. `awaiting_payment` is open; `paid` was settled by an on-chain payment; `canceled` and `expired` closed without one.",
                "example": "canceled"
              },
              "at": {
                "type": "string",
                "format": "date-time",
                "description": "ISO 8601 timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              }
            },
            "required": [
              "status",
              "at"
            ]
          },
          "description": "Every status the request entered, oldest first."
        },
        "createdBy": {
          "type": "string",
          "nullable": true,
          "description": "User ID of the member, or of the API key's creator, who created it."
        },
        "createdAt": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        },
        "updatedAt": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "id",
        "organizationId",
        "projectId",
        "walletId",
        "destinationAddress",
        "token",
        "amount",
        "reference",
        "status",
        "expiresAt",
        "fulfilledByTransferId",
        "paidLate",
        "lastCheckedAt",
        "canceledByApiKeyId",
        "canceledByUserId",
        "canceledAt",
        "lifecycle",
        "createdBy",
        "createdAt",
        "updatedAt"
      ],
      "description": "A payment request. Reads never carry its link token."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema116`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Filter recurring payments by counterparty.",
  "example": "cpty_example"
}
```


### `#/components/schemas/ReviewSchema117`

```json
{
  "type": "string",
  "enum": [
    "pending_activation",
    "activating",
    "active",
    "updating",
    "canceling",
    "resuming",
    "paused",
    "canceled",
    "expired"
  ],
  "description": "Recurring payment status.",
  "example": "active"
}
```


### `#/components/schemas/ReviewSchema118`

```json
{
  "type": "integer",
  "minimum": 0,
  "exclusiveMinimum": true,
  "default": 1
}
```


### `#/components/schemas/ReviewSchema119`

```json
{
  "type": "integer",
  "minimum": 1,
  "maximum": 100,
  "default": 20
}
```


### `#/components/schemas/ReviewSchema120`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "recurringPayments": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "description": "SDP recurring payment ID.",
                "example": "prp_example"
              },
              "organizationId": {
                "type": "string",
                "minLength": 1,
                "description": "Organization identifier.",
                "example": "org_example"
              },
              "projectId": {
                "type": "string",
                "minLength": 1,
                "description": "Project identifier.",
                "example": "prj_example"
              },
              "sourceCustodyWalletId": {
                "type": "string",
                "nullable": true,
                "description": "Exact source SDP Wallet ID, or null for unresolved legacy records.",
                "example": "cwlt_example"
              },
              "sourceProviderWalletId": {
                "type": "string",
                "minLength": 1,
                "description": "Source Provider wallet ID retained as evidence.",
                "example": "privy_wallet_123"
              },
              "sourceAddress": {
                "type": "string",
                "minLength": 32,
                "maxLength": 44,
                "description": "Source wallet address.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "counterpartyId": {
                "type": "string",
                "description": "Counterparty ID.",
                "example": "cpty_example"
              },
              "counterpartyAccountId": {
                "type": "string",
                "description": "Counterparty account ID.",
                "example": "cpacct_example"
              },
              "destinationAddress": {
                "type": "string",
                "minLength": 32,
                "maxLength": 44,
                "description": "Counterparty wallet owner address.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "destinationTokenAccount": {
                "type": "string",
                "nullable": true,
                "minLength": 32,
                "maxLength": 44,
                "description": "Derived counterparty token account used for collection.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "token": {
                "type": "string",
                "description": "SPL token mint address."
              },
              "amount": {
                "type": "string",
                "description": "Token amount in UI units (decimal string).",
                "example": "100.00"
              },
              "periodHours": {
                "type": "integer",
                "minimum": 0,
                "exclusiveMinimum": true,
                "example": 720
              },
              "firstCollectionAt": {
                "type": "string",
                "nullable": true,
                "format": "date-time",
                "description": "Requested first collection timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "nextCollectionDueAt": {
                "type": "string",
                "nullable": true,
                "format": "date-time",
                "description": "Next due collection timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "planId": {
                "type": "string",
                "nullable": true,
                "description": "Linked SDP subscription plan ID."
              },
              "subscriptionId": {
                "type": "string",
                "nullable": true,
                "description": "Linked SDP subscription ID."
              },
              "planPda": {
                "type": "string",
                "nullable": true,
                "minLength": 32,
                "maxLength": 44,
                "description": "On-chain plan PDA.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "planCreatedAt": {
                "type": "string",
                "nullable": true,
                "description": "On-chain plan createdAt value as an unsigned integer string."
              },
              "planCreationSignature": {
                "type": "string",
                "nullable": true,
                "description": "Solana signature for plan creation."
              },
              "subscriptionPda": {
                "type": "string",
                "nullable": true,
                "minLength": 32,
                "maxLength": 44,
                "description": "On-chain subscription PDA.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "subscriptionAuthorityAddress": {
                "type": "string",
                "nullable": true,
                "minLength": 32,
                "maxLength": 44,
                "description": "On-chain subscription authority address.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "authorizationSignature": {
                "type": "string",
                "nullable": true,
                "description": "Solana signature for subscription authorization."
              },
              "status": {
                "type": "string",
                "enum": [
                  "pending_activation",
                  "activating",
                  "active",
                  "updating",
                  "canceling",
                  "resuming",
                  "paused",
                  "canceled",
                  "expired"
                ],
                "description": "Recurring payment status.",
                "example": "active"
              },
              "pausedReason": {
                "type": "string",
                "nullable": true,
                "enum": [
                  "custody_policy_refused",
                  "failed_attempts",
                  null
                ],
                "description": "Why SDP paused the recurring payment, set exactly while `status` is `paused`: `custody_policy_refused` when the custody provider's policy refused to sign a collection, `failed_attempts` when one due period failed 5 times. Resume clears it.",
                "example": null
              },
              "metadataUri": {
                "type": "string",
                "nullable": true,
                "description": "Optional plan metadata URI."
              },
              "createdBy": {
                "type": "string",
                "nullable": true,
                "description": "Creator user ID or API key ID."
              },
              "createdAt": {
                "type": "string",
                "format": "date-time",
                "description": "ISO 8601 timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "updatedAt": {
                "type": "string",
                "format": "date-time",
                "description": "ISO 8601 timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              }
            },
            "required": [
              "id",
              "organizationId",
              "projectId",
              "sourceCustodyWalletId",
              "sourceProviderWalletId",
              "sourceAddress",
              "counterpartyId",
              "counterpartyAccountId",
              "destinationAddress",
              "destinationTokenAccount",
              "token",
              "amount",
              "periodHours",
              "firstCollectionAt",
              "nextCollectionDueAt",
              "planId",
              "subscriptionId",
              "planPda",
              "planCreatedAt",
              "planCreationSignature",
              "subscriptionPda",
              "subscriptionAuthorityAddress",
              "authorizationSignature",
              "status",
              "pausedReason",
              "metadataUri",
              "createdBy",
              "createdAt",
              "updatedAt"
            ],
            "description": "Outbound recurring payment record."
          }
        },
        "total": {
          "type": "integer"
        },
        "page": {
          "type": "integer"
        },
        "pageSize": {
          "type": "integer"
        }
      },
      "required": [
        "recurringPayments",
        "total",
        "page",
        "pageSize"
      ],
      "description": "Recurring payment list response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema121`

```json
{
  "type": "string",
  "pattern": "^[\\x20-\\x7e]{1,255}$",
  "description": "Required: a request without one returns 400 `IDEMPOTENCY_KEY_REQUIRED`. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. A replay is a snapshot of the original response: read the current state with GET instead of sending the request again. If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then takes over and is answered from the record it wrote. After a 5xx, a retry with the same key runs again and answers from the original record instead of acting twice; that answer also carries `Idempotent-Replayed: true`.",
  "example": "idempotency_example_12345"
}
```


### `#/components/schemas/ReviewSchema122`

```json
{
  "type": "object",
  "properties": {
    "sourceCustodyWalletId": {
      "type": "string",
      "minLength": 1,
      "description": "Exact SDP Wallet ID (`id` from `GET /v1/wallets`) that will fund the recurring payment. Provider `walletId`, wallet addresses, and the legacy `sourceWalletId` selector are not accepted.",
      "example": "cwlt_example"
    },
    "counterpartyId": {
      "type": "string",
      "minLength": 1,
      "description": "Counterparty receiving the recurring payment.",
      "example": "cpty_example"
    },
    "counterpartyAccountId": {
      "type": "string",
      "minLength": 1,
      "description": "Counterparty crypto_wallet account. It must contain Solana wallet details.",
      "example": "cpacct_example"
    },
    "token": {
      "type": "string",
      "description": "Token mint address or well-known symbol. Must be a USD stablecoin (e.g. USDC) or a token issued in this project; native SOL is not supported.",
      "example": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    },
    "amount": {
      "type": "string",
      "description": "Recurring payment amount in UI units.",
      "example": "25.00"
    },
    "periodHours": {
      "type": "integer",
      "minimum": 0,
      "exclusiveMinimum": true,
      "maximum": 8760,
      "description": "Billing period length in hours.",
      "example": 720
    },
    "firstCollectionAt": {
      "type": "string",
      "format": "date-time",
      "description": "Optional first collection timestamp. Defaults to activation time when omitted.",
      "example": "2099-01-01T00:00:00.000Z"
    },
    "metadataUri": {
      "type": "string",
      "maxLength": 128,
      "format": "uri",
      "description": "Optional plan metadata URI.",
      "example": "https://example.com/subscriptions/monthly-usdc.json"
    }
  },
  "required": [
    "sourceCustodyWalletId",
    "counterpartyId",
    "counterpartyAccountId",
    "token",
    "amount",
    "periodHours"
  ],
  "additionalProperties": false,
  "description": "Creates an outbound recurring payment intent. Activation and collection are added by follow-up endpoints."
}
```


### `#/components/schemas/ReviewSchema123`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "recurringPayment": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "SDP recurring payment ID.",
              "example": "prp_example"
            },
            "organizationId": {
              "type": "string",
              "minLength": 1,
              "description": "Organization identifier.",
              "example": "org_example"
            },
            "projectId": {
              "type": "string",
              "minLength": 1,
              "description": "Project identifier.",
              "example": "prj_example"
            },
            "sourceCustodyWalletId": {
              "type": "string",
              "nullable": true,
              "description": "Exact source SDP Wallet ID, or null for unresolved legacy records.",
              "example": "cwlt_example"
            },
            "sourceProviderWalletId": {
              "type": "string",
              "minLength": 1,
              "description": "Source Provider wallet ID retained as evidence.",
              "example": "privy_wallet_123"
            },
            "sourceAddress": {
              "type": "string",
              "minLength": 32,
              "maxLength": 44,
              "description": "Source wallet address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "counterpartyId": {
              "type": "string",
              "description": "Counterparty ID.",
              "example": "cpty_example"
            },
            "counterpartyAccountId": {
              "type": "string",
              "description": "Counterparty account ID.",
              "example": "cpacct_example"
            },
            "destinationAddress": {
              "type": "string",
              "minLength": 32,
              "maxLength": 44,
              "description": "Counterparty wallet owner address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "destinationTokenAccount": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "Derived counterparty token account used for collection.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "token": {
              "type": "string",
              "description": "SPL token mint address."
            },
            "amount": {
              "type": "string",
              "description": "Token amount in UI units (decimal string).",
              "example": "100.00"
            },
            "periodHours": {
              "type": "integer",
              "minimum": 0,
              "exclusiveMinimum": true,
              "example": 720
            },
            "firstCollectionAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "Requested first collection timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "nextCollectionDueAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "Next due collection timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "planId": {
              "type": "string",
              "nullable": true,
              "description": "Linked SDP subscription plan ID."
            },
            "subscriptionId": {
              "type": "string",
              "nullable": true,
              "description": "Linked SDP subscription ID."
            },
            "planPda": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "On-chain plan PDA.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "planCreatedAt": {
              "type": "string",
              "nullable": true,
              "description": "On-chain plan createdAt value as an unsigned integer string."
            },
            "planCreationSignature": {
              "type": "string",
              "nullable": true,
              "description": "Solana signature for plan creation."
            },
            "subscriptionPda": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "On-chain subscription PDA.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "subscriptionAuthorityAddress": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "On-chain subscription authority address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "authorizationSignature": {
              "type": "string",
              "nullable": true,
              "description": "Solana signature for subscription authorization."
            },
            "status": {
              "type": "string",
              "enum": [
                "pending_activation",
                "activating",
                "active",
                "updating",
                "canceling",
                "resuming",
                "paused",
                "canceled",
                "expired"
              ],
              "description": "Recurring payment status.",
              "example": "active"
            },
            "pausedReason": {
              "type": "string",
              "nullable": true,
              "enum": [
                "custody_policy_refused",
                "failed_attempts",
                null
              ],
              "description": "Why SDP paused the recurring payment, set exactly while `status` is `paused`: `custody_policy_refused` when the custody provider's policy refused to sign a collection, `failed_attempts` when one due period failed 5 times. Resume clears it.",
              "example": null
            },
            "metadataUri": {
              "type": "string",
              "nullable": true,
              "description": "Optional plan metadata URI."
            },
            "createdBy": {
              "type": "string",
              "nullable": true,
              "description": "Creator user ID or API key ID."
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "updatedAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "organizationId",
            "projectId",
            "sourceCustodyWalletId",
            "sourceProviderWalletId",
            "sourceAddress",
            "counterpartyId",
            "counterpartyAccountId",
            "destinationAddress",
            "destinationTokenAccount",
            "token",
            "amount",
            "periodHours",
            "firstCollectionAt",
            "nextCollectionDueAt",
            "planId",
            "subscriptionId",
            "planPda",
            "planCreatedAt",
            "planCreationSignature",
            "subscriptionPda",
            "subscriptionAuthorityAddress",
            "authorizationSignature",
            "status",
            "pausedReason",
            "metadataUri",
            "createdBy",
            "createdAt",
            "updatedAt"
          ],
          "description": "Outbound recurring payment record."
        },
        "tokenApproval": {
          "type": "object",
          "properties": {
            "status": {
              "type": "string",
              "enum": [
                "revoked",
                "kept",
                "revoking"
              ],
              "description": "`revoked` once the approval has been revoked since the cancel. `kept` while other live recurring payments on the same wallet and token, in this or another project, still use it; `sharedWith` lists the ones in this project. It is revoked once the last of them ends. `revoking` when nothing else uses it but the revoke has not confirmed yet, for example while a collection that was already processing settles; the background sweep finishes it.",
              "example": "kept"
            },
            "delegate": {
              "type": "string",
              "minLength": 32,
              "maxLength": 44,
              "description": "The approval's delegate: the Subscriptions program's authority for this wallet and token.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "sharedWith": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "description": "SDP recurring payment ID.",
                    "example": "prp_example"
                  },
                  "status": {
                    "type": "string",
                    "enum": [
                      "pending_activation",
                      "activating",
                      "active",
                      "updating",
                      "canceling",
                      "resuming",
                      "paused",
                      "canceled",
                      "expired"
                    ],
                    "description": "Recurring payment status.",
                    "example": "active"
                  }
                },
                "required": [
                  "id",
                  "status"
                ]
              },
              "description": "The other live recurring payments in this project on the same wallet and token that keep the approval. Empty unless `status` is `kept`, and empty then when only recurring payments in other projects keep it."
            }
          },
          "required": [
            "status",
            "delegate",
            "sharedWith"
          ],
          "description": "Present when the recurring payment is canceled, on the cancel response and on get: what became of the token approval it relied on."
        }
      },
      "required": [
        "recurringPayment"
      ],
      "description": "Recurring payment response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema124`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "SDP recurring payment record ID.",
  "example": "prp_example"
}
```


### `#/components/schemas/ReviewSchema125`

```json
{
  "type": "object",
  "properties": {
    "sourceCustodyWalletId": {
      "type": "string",
      "minLength": 1,
      "description": "Optional exact replacement SDP Wallet ID (`id` from `GET /v1/wallets`). Provider `walletId`, wallet addresses, and the legacy `sourceWalletId` selector are not accepted. Active replacements require write access to both the old and new source wallets.",
      "example": "cwlt_example"
    },
    "counterpartyId": {
      "type": "string",
      "minLength": 1,
      "description": "Optional replacement counterparty. When provided, counterpartyAccountId is also required.",
      "example": "cpty_example"
    },
    "counterpartyAccountId": {
      "type": "string",
      "minLength": 1,
      "description": "Optional replacement counterparty account. Without counterpartyId, this changes the account for the current counterparty.",
      "example": "cpacct_example"
    },
    "token": {
      "type": "string",
      "description": "Optional replacement token. Must be a USD stablecoin (e.g. USDC) or a token issued in this project; native SOL is not supported.",
      "example": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    },
    "amount": {
      "type": "string",
      "description": "Optional replacement amount in UI units.",
      "example": "25.00"
    },
    "periodHours": {
      "type": "integer",
      "minimum": 0,
      "exclusiveMinimum": true,
      "maximum": 8760,
      "description": "Optional replacement billing period length in hours. Active term changes create a replacement on-chain subscription.",
      "example": 720
    },
    "firstCollectionAt": {
      "type": "string",
      "nullable": true,
      "format": "date-time",
      "description": "Pending-only first collection timestamp. Use null to clear the pending first collection override.",
      "example": "2099-01-01T00:00:00.000Z"
    },
    "nextCollectionDueAt": {
      "type": "string",
      "nullable": true,
      "format": "date-time",
      "description": "Active-only next due timestamp. Use null to reset to the earliest eligible collection time.",
      "example": "2099-02-01T00:00:00.000Z"
    },
    "metadataUri": {
      "type": "string",
      "nullable": true,
      "maxLength": 128,
      "format": "uri",
      "description": "Optional plan metadata URI. Use null to clear it. Active metadata-only edits update the existing on-chain plan in place.",
      "example": "https://example.com/subscriptions/monthly-usdc.json"
    }
  },
  "additionalProperties": false,
  "description": "Updates a recurring payment. Pending payments are edited directly. Active metadata or due-date updates are applied in place, while active term/source/destination/token updates create and authorize a replacement subscription before canceling the old one."
}
```


### `#/components/schemas/ReviewSchema126`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "recurringPayment": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "SDP recurring payment ID.",
              "example": "prp_example"
            },
            "organizationId": {
              "type": "string",
              "minLength": 1,
              "description": "Organization identifier.",
              "example": "org_example"
            },
            "projectId": {
              "type": "string",
              "minLength": 1,
              "description": "Project identifier.",
              "example": "prj_example"
            },
            "sourceCustodyWalletId": {
              "type": "string",
              "nullable": true,
              "description": "Exact source SDP Wallet ID, or null for unresolved legacy records.",
              "example": "cwlt_example"
            },
            "sourceProviderWalletId": {
              "type": "string",
              "minLength": 1,
              "description": "Source Provider wallet ID retained as evidence.",
              "example": "privy_wallet_123"
            },
            "sourceAddress": {
              "type": "string",
              "minLength": 32,
              "maxLength": 44,
              "description": "Source wallet address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "counterpartyId": {
              "type": "string",
              "description": "Counterparty ID.",
              "example": "cpty_example"
            },
            "counterpartyAccountId": {
              "type": "string",
              "description": "Counterparty account ID.",
              "example": "cpacct_example"
            },
            "destinationAddress": {
              "type": "string",
              "minLength": 32,
              "maxLength": 44,
              "description": "Counterparty wallet owner address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "destinationTokenAccount": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "Derived counterparty token account used for collection.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "token": {
              "type": "string",
              "description": "SPL token mint address."
            },
            "amount": {
              "type": "string",
              "description": "Token amount in UI units (decimal string).",
              "example": "100.00"
            },
            "periodHours": {
              "type": "integer",
              "minimum": 0,
              "exclusiveMinimum": true,
              "example": 720
            },
            "firstCollectionAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "Requested first collection timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "nextCollectionDueAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "Next due collection timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "planId": {
              "type": "string",
              "nullable": true,
              "description": "Linked SDP subscription plan ID."
            },
            "subscriptionId": {
              "type": "string",
              "nullable": true,
              "description": "Linked SDP subscription ID."
            },
            "planPda": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "On-chain plan PDA.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "planCreatedAt": {
              "type": "string",
              "nullable": true,
              "description": "On-chain plan createdAt value as an unsigned integer string."
            },
            "planCreationSignature": {
              "type": "string",
              "nullable": true,
              "description": "Solana signature for plan creation."
            },
            "subscriptionPda": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "On-chain subscription PDA.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "subscriptionAuthorityAddress": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "On-chain subscription authority address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "authorizationSignature": {
              "type": "string",
              "nullable": true,
              "description": "Solana signature for subscription authorization."
            },
            "status": {
              "type": "string",
              "enum": [
                "pending_activation",
                "activating",
                "active",
                "updating",
                "canceling",
                "resuming",
                "paused",
                "canceled",
                "expired"
              ],
              "description": "Recurring payment status.",
              "example": "active"
            },
            "pausedReason": {
              "type": "string",
              "nullable": true,
              "enum": [
                "custody_policy_refused",
                "failed_attempts",
                null
              ],
              "description": "Why SDP paused the recurring payment, set exactly while `status` is `paused`: `custody_policy_refused` when the custody provider's policy refused to sign a collection, `failed_attempts` when one due period failed 5 times. Resume clears it.",
              "example": null
            },
            "metadataUri": {
              "type": "string",
              "nullable": true,
              "description": "Optional plan metadata URI."
            },
            "createdBy": {
              "type": "string",
              "nullable": true,
              "description": "Creator user ID or API key ID."
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "updatedAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "organizationId",
            "projectId",
            "sourceCustodyWalletId",
            "sourceProviderWalletId",
            "sourceAddress",
            "counterpartyId",
            "counterpartyAccountId",
            "destinationAddress",
            "destinationTokenAccount",
            "token",
            "amount",
            "periodHours",
            "firstCollectionAt",
            "nextCollectionDueAt",
            "planId",
            "subscriptionId",
            "planPda",
            "planCreatedAt",
            "planCreationSignature",
            "subscriptionPda",
            "subscriptionAuthorityAddress",
            "authorizationSignature",
            "status",
            "pausedReason",
            "metadataUri",
            "createdBy",
            "createdAt",
            "updatedAt"
          ],
          "description": "Outbound recurring payment record."
        },
        "collectionAttempt": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "Collection attempt ID.",
              "example": "psca_example"
            },
            "organizationId": {
              "type": "string",
              "minLength": 1,
              "description": "Organization identifier.",
              "example": "org_example"
            },
            "projectId": {
              "type": "string",
              "minLength": 1,
              "description": "Project identifier.",
              "example": "prj_example"
            },
            "subscriptionId": {
              "type": "string",
              "description": "Subscription ID."
            },
            "transferId": {
              "type": "string",
              "nullable": true,
              "minLength": 1,
              "description": "Payment transfer record ID when linked.",
              "example": "xfr_example"
            },
            "token": {
              "type": "string",
              "description": "Token mint or normalized token identifier."
            },
            "amount": {
              "type": "string",
              "description": "Token amount in UI units (decimal string).",
              "example": "100.00"
            },
            "dueAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "attemptedAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "status": {
              "type": "string",
              "enum": [
                "pending",
                "processing",
                "confirmed",
                "failed",
                "skipped"
              ],
              "description": "Collection attempt status.",
              "example": "pending"
            },
            "signature": {
              "type": "string",
              "nullable": true,
              "description": "Solana transaction signature."
            },
            "error": {
              "type": "string",
              "nullable": true,
              "description": "Collection error, if any."
            },
            "metadata": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "recurringPaymentId": {
                      "type": "string"
                    },
                    "initiatedByKeyId": {
                      "type": "string",
                      "nullable": true
                    },
                    "source": {
                      "type": "string",
                      "enum": [
                        "manual"
                      ]
                    }
                  },
                  "required": [
                    "recurringPaymentId",
                    "initiatedByKeyId",
                    "source"
                  ]
                },
                {
                  "type": "object",
                  "properties": {
                    "recurringPaymentId": {
                      "type": "string"
                    },
                    "initiatedByKeyId": {
                      "type": "string",
                      "nullable": true
                    },
                    "source": {
                      "type": "string",
                      "enum": [
                        "automated"
                      ]
                    }
                  },
                  "required": [
                    "recurringPaymentId",
                    "initiatedByKeyId",
                    "source"
                  ]
                },
                {
                  "type": "object",
                  "properties": {
                    "recurringPaymentId": {
                      "type": "string"
                    },
                    "initiatedByKeyId": {
                      "type": "string",
                      "nullable": true
                    },
                    "source": {
                      "type": "string",
                      "enum": [
                        "retry"
                      ]
                    },
                    "initialSource": {
                      "type": "string",
                      "enum": [
                        "manual",
                        "automated"
                      ]
                    },
                    "transferId": {
                      "type": "string",
                      "nullable": true
                    },
                    "error": {
                      "type": "string"
                    },
                    "retryAfterAt": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "recurringPaymentId",
                    "initiatedByKeyId",
                    "source",
                    "initialSource",
                    "transferId",
                    "error",
                    "retryAfterAt"
                  ]
                },
                {
                  "type": "object",
                  "properties": {
                    "recurringPaymentId": {
                      "type": "string"
                    },
                    "initiatedByKeyId": {
                      "type": "string",
                      "nullable": true
                    },
                    "source": {
                      "type": "string",
                      "enum": [
                        "linked_transfer"
                      ]
                    },
                    "initialSource": {
                      "type": "string",
                      "enum": [
                        "manual",
                        "automated"
                      ]
                    },
                    "transferId": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "recurringPaymentId",
                    "initiatedByKeyId",
                    "source",
                    "initialSource",
                    "transferId"
                  ]
                }
              ],
              "description": "Provider/job metadata for the attempt."
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "updatedAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "organizationId",
            "projectId",
            "subscriptionId",
            "transferId",
            "token",
            "amount",
            "dueAt",
            "attemptedAt",
            "status",
            "signature",
            "error",
            "metadata",
            "createdAt",
            "updatedAt"
          ],
          "description": "Recurring payment collection attempt record."
        },
        "transfer": {
          "type": "object",
          "properties": {
            "fireblocks": {
              "type": "object",
              "properties": {
                "transactionId": {
                  "type": "string",
                  "nullable": true
                },
                "status": {
                  "type": "string"
                },
                "subStatus": {
                  "type": "string",
                  "nullable": true
                }
              },
              "required": [
                "transactionId",
                "status",
                "subStatus"
              ],
              "description": "Native Fireblocks transfer tracking. A processing payment may await approval in Fireblocks; network fees are paid by its source vault. A missing transaction ID means submission is still being reconciled. Do not create a replacement payment while its outcome is unknown."
            },
            "id": {
              "type": "string",
              "minLength": 1,
              "description": "Transfer identifier (SDP record ID, not the on-chain signature).",
              "example": "xfr_example"
            },
            "organizationId": {
              "type": "string",
              "minLength": 1,
              "description": "Organization identifier.",
              "example": "org_example"
            },
            "custodyWalletId": {
              "type": "string",
              "nullable": true,
              "description": "Exact SDP Wallet ID associated with the persisted transfer, or null for unresolved legacy and observed rows.",
              "example": "cwlt_example"
            },
            "providerWalletId": {
              "type": "string",
              "minLength": 1,
              "description": "Provider wallet ID retained as evidence; not an execution selector.",
              "example": "privy_wallet_123"
            },
            "projectId": {
              "type": "string",
              "minLength": 1,
              "description": "Project identifier for the transfer.",
              "example": "prj_example"
            },
            "type": {
              "type": "string",
              "enum": [
                "transfer",
                "transfer_batch",
                "onramp",
                "offramp"
              ],
              "description": "Transfer type.",
              "example": "transfer"
            },
            "kind": {
              "type": "string",
              "enum": [
                "pay",
                "confidential_pay",
                "batch_pay",
                "recurring_pay",
                "deposit",
                "request_deposit",
                "onramp",
                "offramp"
              ],
              "description": "Dashboard transaction kind derived from the transfer type and originating Payments resource."
            },
            "direction": {
              "type": "string",
              "enum": [
                "inbound",
                "outbound"
              ],
              "description": "Transfer direction.",
              "example": "outbound"
            },
            "status": {
              "type": "string",
              "enum": [
                "pending",
                "processing",
                "confirmed",
                "finalized",
                "failed",
                "awaiting_payment",
                "settling",
                "completed",
                "canceled",
                "expired"
              ],
              "description": "Transfer status.",
              "example": "confirmed"
            },
            "signature": {
              "type": "string",
              "nullable": true,
              "description": "Solana transaction signature (tx id/hash).",
              "example": "sig_example"
            },
            "serializedTx": {
              "type": "string",
              "nullable": true,
              "minLength": 1,
              "description": "Base64-encoded transaction payload, if available. Always null for transfer batch chunks, whose signed bytes stay server-side.",
              "example": "base64_tx_example"
            },
            "slot": {
              "type": "integer",
              "nullable": true,
              "description": "Slot number, if confirmed.",
              "example": 123456
            },
            "blockTime": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "Block time, if confirmed.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "confirmedAt": {
              "type": "string",
              "format": "date-time",
              "description": "When SDP confirmed the transfer. A ramp is confirmed once its delivery is verified onchain.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "fee": {
              "type": "integer",
              "nullable": true,
              "description": "Transaction fee in lamports.",
              "example": 5000
            },
            "error": {
              "type": "string",
              "nullable": true,
              "description": "Error message if the transaction failed.",
              "example": "Signature failed"
            },
            "initiatedBy": {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "enum": [
                    "api_key",
                    "user",
                    "system"
                  ],
                  "description": "Initiator type.",
                  "example": "api_key"
                },
                "id": {
                  "type": "string",
                  "description": "Initiator identifier if applicable."
                },
                "display": {
                  "type": "string",
                  "description": "Human-friendly label for the initiator."
                }
              },
              "required": [
                "type"
              ],
              "description": "Initiator that triggered the transfer."
            },
            "source": {
              "type": "string",
              "minLength": 32,
              "maxLength": 44,
              "description": "Source wallet address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "destination": {
              "type": "string",
              "minLength": 32,
              "maxLength": 44,
              "description": "Destination wallet address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "memo": {
              "type": "string",
              "maxLength": 256,
              "description": "Optional memo for the transfer."
            },
            "rampsMemo": {
              "type": "object",
              "additionalProperties": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              },
              "description": "Free-form key-value memo for offchain reconciliation of ramp transfers. At most 20 entries.",
              "example": {
                "invoice": "INV-123",
                "po": "PO-9"
              }
            },
            "token": {
              "type": "string",
              "description": "Token symbol or mint address."
            },
            "amount": {
              "type": "string",
              "description": "Token amount in UI units (decimal string).",
              "example": "100.00"
            },
            "provider": {
              "type": "string",
              "enum": [
                "moonpay",
                "stripe",
                "hercle",
                "mural",
                "moneygram",
                "lightspark",
                "coinbase",
                "bvnk"
              ],
              "description": "Ramp provider for on-ramp and off-ramp transfer records. A retired provider's records keep its id.",
              "example": "moonpay"
            },
            "counterpartyId": {
              "type": "string",
              "description": "Counterparty tied to the transfer record, when available.",
              "example": "cpty_example"
            },
            "counterpartyDisplayName": {
              "type": "string",
              "description": "Current display name of the counterparty tied to the transfer.",
              "example": "Acme Studio"
            },
            "providerReference": {
              "type": "string",
              "description": "Provider quote or transaction reference used for ramp correlation.",
              "example": "ramp_quote_example"
            },
            "deliveryMode": {
              "type": "string",
              "enum": [
                "hosted",
                "manual_instructions",
                "session_widget"
              ],
              "description": "Ramp delivery mode. Hosted flows require the customer to complete a provider-hosted UI; manual instructions require the customer to fund displayed instructions; session widgets use a provider SDK session.",
              "example": "session_widget"
            },
            "fiatCurrency": {
              "type": "string",
              "description": "Fiat currency for the ramp leg.",
              "example": "USD"
            },
            "fiatAmount": {
              "type": "string",
              "description": "Quoted fiat amount for the ramp leg: what the customer pays on an on-ramp, the payout quoted on an off-ramp. It never changes after the quote; an off-ramp's final payout is `fiatPayout`.",
              "example": "100.00"
            },
            "settlement": {
              "type": "object",
              "properties": {
                "provider": {
                  "type": "string",
                  "enum": [
                    "moonpay"
                  ]
                },
                "status": {
                  "type": "string",
                  "enum": [
                    "completed",
                    "failed"
                  ]
                },
                "transactionId": {
                  "type": "string",
                  "description": "MoonPay transaction id."
                },
                "baseCurrencyCode": {
                  "type": "string",
                  "description": "Fiat currency paid."
                },
                "baseCurrencyAmount": {
                  "type": "number",
                  "description": "Fiat amount paid."
                },
                "quoteCurrencyCode": {
                  "type": "string",
                  "description": "Crypto currency purchased."
                },
                "quoteCurrencyAmount": {
                  "type": "number",
                  "description": "Crypto amount purchased."
                },
                "feeAmount": {
                  "type": "number",
                  "description": "Provider fee."
                },
                "extraFeeAmount": {
                  "type": "number",
                  "description": "Extra provider fee."
                },
                "networkFeeAmount": {
                  "type": "number",
                  "description": "Network fee."
                },
                "areFeesIncluded": {
                  "type": "boolean",
                  "description": "Whether the fees are included in the paid amount."
                },
                "usdRate": {
                  "type": "number",
                  "description": "USD exchange rate."
                },
                "cryptoTransactionId": {
                  "type": "string",
                  "description": "On-chain transaction id."
                },
                "failureReason": {
                  "type": "string",
                  "description": "Provider failure reason."
                }
              },
              "required": [
                "provider",
                "status",
                "transactionId",
                "baseCurrencyCode",
                "baseCurrencyAmount",
                "quoteCurrencyCode",
                "quoteCurrencyAmount",
                "feeAmount",
                "extraFeeAmount",
                "networkFeeAmount",
                "areFeesIncluded",
                "usdRate"
              ],
              "description": "Provider-reported ramp settlement economics for live providers."
            },
            "fiatPayout": {
              "type": "object",
              "properties": {
                "amount": {
                  "type": "string",
                  "description": "Fiat paid out, in display units. Differs from the quoted `fiatAmount` when the provider re-prices the sale at receipt.",
                  "example": "20.82"
                },
                "currency": {
                  "type": "string",
                  "description": "ISO currency of the payout, as the provider reports it.",
                  "example": "USD"
                },
                "reportedAt": {
                  "type": "string",
                  "format": "date-time",
                  "description": "When the provider reported the payout.",
                  "example": "2025-01-02T00:00:00.000Z"
                }
              },
              "required": [
                "amount",
                "currency"
              ],
              "description": "What the provider reports paying out once it settles an off-ramp sale. Provider-reported: SDP cannot verify a bank payout."
            },
            "deliveryMismatch": {
              "type": "object",
              "properties": {
                "reason": {
                  "type": "string",
                  "enum": [
                    "provider_report_mismatch",
                    "transaction_failed",
                    "predates_transfer",
                    "not_delivered",
                    "amount_mismatch",
                    "transaction_not_found"
                  ],
                  "description": "Why the chain contradicts the provider: `provider_report_mismatch` (its report contradicts SDP's record), `transaction_failed`, `predates_transfer` (the transaction landed before the transfer), `not_delivered` (nothing of the quoted asset reached the quoted wallet), `amount_mismatch`, or `transaction_not_found` (no finalized transaction an hour after the report; SDP keeps checking, and a later delivery completes the transfer).",
                  "example": "amount_mismatch"
                },
                "checkedAt": {
                  "type": "string",
                  "format": "date-time",
                  "description": "When SDP's delivery check reached this verdict.",
                  "example": "2025-01-02T00:00:00.000Z"
                },
                "reportedAmount": {
                  "type": "string",
                  "description": "What the provider reported delivering, in display units.",
                  "example": "20"
                },
                "observedAmount": {
                  "type": "string",
                  "description": "What the chain shows the quoted wallet received, in display units.",
                  "example": "0.5"
                }
              },
              "required": [
                "reason",
                "checkedAt"
              ],
              "description": "Present while SDP holds a provider-settled ramp in `settling` because the chain contradicts the provider's delivery. A new provider report clears it."
            },
            "risk": {
              "type": "object",
              "properties": {
                "provider": {
                  "type": "string",
                  "description": "Risk scoring provider.",
                  "example": "trm"
                },
                "score": {
                  "type": "string",
                  "description": "Provider-specific risk score.",
                  "example": "0.12"
                },
                "level": {
                  "type": "string",
                  "enum": [
                    "low",
                    "medium",
                    "high",
                    "unknown"
                  ],
                  "description": "Risk level classification.",
                  "example": "low"
                },
                "evaluatedAt": {
                  "type": "string",
                  "format": "date-time",
                  "description": "Timestamp when risk was evaluated.",
                  "example": "2025-01-01T00:00:00.000Z"
                }
              },
              "required": [
                "provider",
                "score",
                "level",
                "evaluatedAt"
              ],
              "description": "Optional risk evaluation for the transfer."
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "Creation timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "updatedAt": {
              "type": "string",
              "format": "date-time",
              "description": "Last update timestamp.",
              "example": "2025-01-02T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "organizationId",
            "custodyWalletId",
            "providerWalletId",
            "type",
            "kind",
            "direction",
            "status",
            "signature",
            "serializedTx",
            "slot",
            "blockTime",
            "fee",
            "error",
            "rampsMemo",
            "createdAt",
            "updatedAt"
          ],
          "description": "Transfer transaction record."
        }
      },
      "required": [
        "recurringPayment",
        "collectionAttempt",
        "transfer"
      ],
      "description": "Recurring payment collection response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema127`

```json
{
  "type": "string",
  "enum": [
    "draft",
    "active",
    "archived"
  ],
  "description": "Subscription plan status.",
  "example": "active"
}
```


### `#/components/schemas/ReviewSchema128`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "subscriptionPlans": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "description": "SDP subscription plan ID.",
                "example": "psp_example"
              },
              "organizationId": {
                "type": "string",
                "minLength": 1,
                "description": "Organization identifier.",
                "example": "org_example"
              },
              "projectId": {
                "type": "string",
                "minLength": 1,
                "description": "Project identifier.",
                "example": "prj_example"
              },
              "ownerWalletId": {
                "type": "string",
                "minLength": 1,
                "description": "Provider wallet ID — the `walletId` field returned by GET /v1/wallets.",
                "example": "privy_wallet_123"
              },
              "ownerAddress": {
                "type": "string",
                "minLength": 32,
                "maxLength": 44,
                "description": "Base58-encoded Solana address.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "token": {
                "type": "string",
                "description": "Token mint or normalized token identifier."
              },
              "amount": {
                "type": "string",
                "description": "Token amount in UI units (decimal string).",
                "example": "100.00"
              },
              "periodHours": {
                "type": "integer",
                "minimum": 0,
                "exclusiveMinimum": true,
                "example": 720
              },
              "programPlanId": {
                "type": "string",
                "description": "Unsigned 64-bit decimal program plan identifier used in PDA derivation.",
                "example": "17014118346046923173"
              },
              "planPda": {
                "type": "string",
                "nullable": true,
                "minLength": 32,
                "maxLength": 44,
                "description": "On-chain plan PDA.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "destinationAddress": {
                "type": "string",
                "nullable": true,
                "minLength": 32,
                "maxLength": 44,
                "description": "Allowed destination owner address.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "pullerWalletId": {
                "type": "string",
                "nullable": true,
                "minLength": 1,
                "description": "Collector wallet ID.",
                "example": "privy_wallet_123"
              },
              "pullerAddress": {
                "type": "string",
                "nullable": true,
                "minLength": 32,
                "maxLength": 44,
                "description": "Collector wallet address.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "metadataUri": {
                "type": "string",
                "nullable": true,
                "description": "Optional plan metadata URI."
              },
              "status": {
                "type": "string",
                "enum": [
                  "draft",
                  "active",
                  "archived"
                ],
                "description": "Subscription plan status.",
                "example": "active"
              },
              "createdBy": {
                "type": "string",
                "nullable": true,
                "description": "Creator user ID or API key ID."
              },
              "createdAt": {
                "type": "string",
                "format": "date-time",
                "description": "ISO 8601 timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "updatedAt": {
                "type": "string",
                "format": "date-time",
                "description": "ISO 8601 timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              }
            },
            "required": [
              "id",
              "organizationId",
              "projectId",
              "ownerWalletId",
              "ownerAddress",
              "token",
              "amount",
              "periodHours",
              "programPlanId",
              "planPda",
              "destinationAddress",
              "pullerWalletId",
              "pullerAddress",
              "metadataUri",
              "status",
              "createdBy",
              "createdAt",
              "updatedAt"
            ],
            "description": "Recurring payment subscription plan record."
          }
        },
        "total": {
          "type": "integer"
        },
        "page": {
          "type": "integer"
        },
        "pageSize": {
          "type": "integer"
        }
      },
      "required": [
        "subscriptionPlans",
        "total",
        "page",
        "pageSize"
      ],
      "description": "Subscription plan list response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema129`

```json
{
  "type": "object",
  "properties": {
    "ownerWalletId": {
      "type": "string",
      "minLength": 1,
      "description": "Connected wallet that owns the Solana subscription plan.",
      "example": "wal_merchant"
    },
    "token": {
      "type": "string",
      "description": "Token mint address. Native SOL is not expected for program-backed subscriptions.",
      "example": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    },
    "amount": {
      "type": "string",
      "description": "Recurring charge amount in UI units.",
      "example": "25.00"
    },
    "periodHours": {
      "type": "integer",
      "minimum": 0,
      "exclusiveMinimum": true,
      "maximum": 8760,
      "description": "Billing period length in hours.",
      "example": 720
    },
    "programPlanId": {
      "type": "string",
      "pattern": "^\\d+$",
      "description": "Unsigned 64-bit decimal program plan identifier used in the Solana subscriptions PDA seed. Defaults to a generated nonzero value.",
      "example": "17014118346046923173"
    },
    "planPda": {
      "type": "string",
      "description": "On-chain plan PDA once created.",
      "example": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    },
    "destinationAddress": {
      "type": "string",
      "description": "Optional destination owner address allowed by the on-chain plan.",
      "example": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    },
    "pullerWalletId": {
      "type": "string",
      "minLength": 1,
      "description": "Optional connected wallet allowed to pull subscription payments.",
      "example": "wal_collector"
    },
    "metadataUri": {
      "type": "string",
      "maxLength": 128,
      "format": "uri",
      "description": "Optional plan metadata URI.",
      "example": "https://example.com/subscriptions/monthly-usdc.json"
    },
    "status": {
      "type": "string",
      "enum": [
        "draft",
        "active",
        "archived"
      ],
      "description": "Subscription plan status.",
      "example": "active"
    }
  },
  "required": [
    "ownerWalletId",
    "token",
    "amount",
    "periodHours"
  ],
  "description": "Creates an SDP subscription plan record. Prepare the on-chain Solana subscriptions program transaction separately with the plan prepare endpoint."
}
```


### `#/components/schemas/ReviewSchema130`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "subscriptionPlan": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "SDP subscription plan ID.",
              "example": "psp_example"
            },
            "organizationId": {
              "type": "string",
              "minLength": 1,
              "description": "Organization identifier.",
              "example": "org_example"
            },
            "projectId": {
              "type": "string",
              "minLength": 1,
              "description": "Project identifier.",
              "example": "prj_example"
            },
            "ownerWalletId": {
              "type": "string",
              "minLength": 1,
              "description": "Provider wallet ID — the `walletId` field returned by GET /v1/wallets.",
              "example": "privy_wallet_123"
            },
            "ownerAddress": {
              "type": "string",
              "minLength": 32,
              "maxLength": 44,
              "description": "Base58-encoded Solana address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "token": {
              "type": "string",
              "description": "Token mint or normalized token identifier."
            },
            "amount": {
              "type": "string",
              "description": "Token amount in UI units (decimal string).",
              "example": "100.00"
            },
            "periodHours": {
              "type": "integer",
              "minimum": 0,
              "exclusiveMinimum": true,
              "example": 720
            },
            "programPlanId": {
              "type": "string",
              "description": "Unsigned 64-bit decimal program plan identifier used in PDA derivation.",
              "example": "17014118346046923173"
            },
            "planPda": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "On-chain plan PDA.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "destinationAddress": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "Allowed destination owner address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "pullerWalletId": {
              "type": "string",
              "nullable": true,
              "minLength": 1,
              "description": "Collector wallet ID.",
              "example": "privy_wallet_123"
            },
            "pullerAddress": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "Collector wallet address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "metadataUri": {
              "type": "string",
              "nullable": true,
              "description": "Optional plan metadata URI."
            },
            "status": {
              "type": "string",
              "enum": [
                "draft",
                "active",
                "archived"
              ],
              "description": "Subscription plan status.",
              "example": "active"
            },
            "createdBy": {
              "type": "string",
              "nullable": true,
              "description": "Creator user ID or API key ID."
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "updatedAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "organizationId",
            "projectId",
            "ownerWalletId",
            "ownerAddress",
            "token",
            "amount",
            "periodHours",
            "programPlanId",
            "planPda",
            "destinationAddress",
            "pullerWalletId",
            "pullerAddress",
            "metadataUri",
            "status",
            "createdBy",
            "createdAt",
            "updatedAt"
          ],
          "description": "Recurring payment subscription plan record."
        }
      },
      "required": [
        "subscriptionPlan"
      ],
      "description": "Subscription plan response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema131`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "SDP subscription plan record ID.",
  "example": "psp_example"
}
```


### `#/components/schemas/ReviewSchema132`

```json
{
  "type": "object",
  "properties": {
    "planPda": {
      "type": "string",
      "nullable": true,
      "description": "On-chain plan PDA, or null to clear it.",
      "example": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    },
    "destinationAddress": {
      "type": "string",
      "nullable": true,
      "description": "Destination owner address, or null to clear it."
    },
    "pullerWalletId": {
      "type": "string",
      "nullable": true,
      "minLength": 1,
      "description": "Collection wallet ID, or null to clear it.",
      "example": "wal_collector"
    },
    "metadataUri": {
      "type": "string",
      "nullable": true,
      "maxLength": 128,
      "format": "uri",
      "description": "Plan metadata URI, or null to clear it."
    },
    "status": {
      "type": "string",
      "enum": [
        "draft",
        "active",
        "archived"
      ],
      "description": "Subscription plan status.",
      "example": "active"
    }
  },
  "description": "Updates mutable SDP subscription plan fields."
}
```


### `#/components/schemas/ReviewSchema133`

```json
{
  "type": "object",
  "properties": {
    "destinations": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "maxItems": 4,
      "description": "Allowed destination addresses for the on-chain plan. Defaults to the stored plan destination."
    },
    "pullers": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "maxItems": 4,
      "description": "Allowed puller addresses for the on-chain plan. Defaults to the stored puller or owner address."
    },
    "endTs": {
      "type": "string",
      "pattern": "^\\d+$",
      "description": "Optional unsigned 64-bit Unix timestamp when the on-chain plan ends.",
      "example": "1770000000"
    },
    "metadataUri": {
      "type": "string",
      "maxLength": 128,
      "format": "uri",
      "description": "Optional metadata URI to embed in the on-chain plan.",
      "example": "https://example.com/subscriptions/monthly-usdc.json"
    }
  },
  "description": "Optional overrides used when preparing the Solana subscriptions create-plan transaction."
}
```


### `#/components/schemas/ReviewSchema134`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "subscriptionPlan": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "SDP subscription plan ID.",
              "example": "psp_example"
            },
            "organizationId": {
              "type": "string",
              "minLength": 1,
              "description": "Organization identifier.",
              "example": "org_example"
            },
            "projectId": {
              "type": "string",
              "minLength": 1,
              "description": "Project identifier.",
              "example": "prj_example"
            },
            "ownerWalletId": {
              "type": "string",
              "minLength": 1,
              "description": "Provider wallet ID — the `walletId` field returned by GET /v1/wallets.",
              "example": "privy_wallet_123"
            },
            "ownerAddress": {
              "type": "string",
              "minLength": 32,
              "maxLength": 44,
              "description": "Base58-encoded Solana address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "token": {
              "type": "string",
              "description": "Token mint or normalized token identifier."
            },
            "amount": {
              "type": "string",
              "description": "Token amount in UI units (decimal string).",
              "example": "100.00"
            },
            "periodHours": {
              "type": "integer",
              "minimum": 0,
              "exclusiveMinimum": true,
              "example": 720
            },
            "programPlanId": {
              "type": "string",
              "description": "Unsigned 64-bit decimal program plan identifier used in PDA derivation.",
              "example": "17014118346046923173"
            },
            "planPda": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "On-chain plan PDA.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "destinationAddress": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "Allowed destination owner address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "pullerWalletId": {
              "type": "string",
              "nullable": true,
              "minLength": 1,
              "description": "Collector wallet ID.",
              "example": "privy_wallet_123"
            },
            "pullerAddress": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "Collector wallet address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "metadataUri": {
              "type": "string",
              "nullable": true,
              "description": "Optional plan metadata URI."
            },
            "status": {
              "type": "string",
              "enum": [
                "draft",
                "active",
                "archived"
              ],
              "description": "Subscription plan status.",
              "example": "active"
            },
            "createdBy": {
              "type": "string",
              "nullable": true,
              "description": "Creator user ID or API key ID."
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "updatedAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "organizationId",
            "projectId",
            "ownerWalletId",
            "ownerAddress",
            "token",
            "amount",
            "periodHours",
            "programPlanId",
            "planPda",
            "destinationAddress",
            "pullerWalletId",
            "pullerAddress",
            "metadataUri",
            "status",
            "createdBy",
            "createdAt",
            "updatedAt"
          ],
          "description": "Recurring payment subscription plan record."
        },
        "planPda": {
          "type": "string",
          "minLength": 32,
          "maxLength": 44,
          "description": "Derived Solana subscriptions plan PDA.",
          "example": "So11111111111111111111111111111111111111112"
        },
        "preparedTransaction": {
          "type": "object",
          "properties": {
            "serialized": {
              "type": "string",
              "minLength": 1,
              "description": "Base64-encoded unsigned transaction.",
              "example": "AQID"
            },
            "blockhash": {
              "type": "string",
              "description": "Blockhash for the transaction.",
              "example": "blockhash_example"
            },
            "lastValidBlockHeight": {
              "type": "string",
              "description": "Last valid block height.",
              "example": "123456"
            },
            "requiredSigners": {
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 32,
                "maxLength": 44,
                "description": "Base58-encoded Solana address.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "description": "Addresses that must sign the prepared transaction. This includes the sponsored fee payer when the transaction uses one."
            }
          },
          "required": [
            "serialized",
            "blockhash",
            "lastValidBlockHeight",
            "requiredSigners"
          ],
          "description": "Unsigned Solana subscriptions transaction payload for client-side signing."
        }
      },
      "required": [
        "subscriptionPlan",
        "planPda",
        "preparedTransaction"
      ],
      "description": "Prepared Solana subscriptions create-plan response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema135`

```json
{
  "type": "string",
  "minLength": 1
}
```


### `#/components/schemas/ReviewSchema136`

```json
{
  "type": "string",
  "enum": [
    "pending_authorization",
    "active",
    "paused",
    "canceling",
    "canceled",
    "expired"
  ],
  "description": "Subscription status.",
  "example": "active"
}
```


### `#/components/schemas/ReviewSchema137`

```json
{
  "type": "string",
  "format": "date-time"
}
```


### `#/components/schemas/ReviewSchema138`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "subscriptions": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "description": "SDP subscription ID.",
                "example": "psub_example"
              },
              "organizationId": {
                "type": "string",
                "minLength": 1,
                "description": "Organization identifier.",
                "example": "org_example"
              },
              "projectId": {
                "type": "string",
                "minLength": 1,
                "description": "Project identifier.",
                "example": "prj_example"
              },
              "planId": {
                "type": "string",
                "description": "SDP subscription plan ID."
              },
              "counterpartyId": {
                "type": "string",
                "description": "Counterparty ID."
              },
              "subscriberAddress": {
                "type": "string",
                "minLength": 32,
                "maxLength": 44,
                "description": "Base58-encoded Solana address.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "subscriberTokenAccount": {
                "type": "string",
                "nullable": true,
                "minLength": 32,
                "maxLength": 44,
                "description": "Subscriber token account address.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "subscriptionPda": {
                "type": "string",
                "nullable": true,
                "minLength": 32,
                "maxLength": 44,
                "description": "On-chain subscription PDA.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "subscriptionAuthorityAddress": {
                "type": "string",
                "nullable": true,
                "minLength": 32,
                "maxLength": 44,
                "description": "On-chain subscription authority address.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "authorizationSignature": {
                "type": "string",
                "nullable": true,
                "description": "Customer authorization transaction signature."
              },
              "status": {
                "type": "string",
                "enum": [
                  "pending_authorization",
                  "active",
                  "paused",
                  "canceling",
                  "canceled",
                  "expired"
                ],
                "description": "Subscription status.",
                "example": "active"
              },
              "currentPeriodStartAt": {
                "type": "string",
                "nullable": true,
                "format": "date-time",
                "description": "ISO 8601 timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "nextCollectionDueAt": {
                "type": "string",
                "nullable": true,
                "format": "date-time",
                "description": "ISO 8601 timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "cancelAt": {
                "type": "string",
                "nullable": true,
                "format": "date-time",
                "description": "ISO 8601 timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "canceledAt": {
                "type": "string",
                "nullable": true,
                "format": "date-time",
                "description": "ISO 8601 timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "createdBy": {
                "type": "string",
                "nullable": true
              },
              "createdAt": {
                "type": "string",
                "format": "date-time",
                "description": "ISO 8601 timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "updatedAt": {
                "type": "string",
                "format": "date-time",
                "description": "ISO 8601 timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              }
            },
            "required": [
              "id",
              "organizationId",
              "projectId",
              "planId",
              "counterpartyId",
              "subscriberAddress",
              "subscriberTokenAccount",
              "subscriptionPda",
              "subscriptionAuthorityAddress",
              "authorizationSignature",
              "status",
              "currentPeriodStartAt",
              "nextCollectionDueAt",
              "cancelAt",
              "canceledAt",
              "createdBy",
              "createdAt",
              "updatedAt"
            ],
            "description": "Recurring payment subscription record."
          }
        },
        "total": {
          "type": "integer"
        },
        "page": {
          "type": "integer"
        },
        "pageSize": {
          "type": "integer"
        }
      },
      "required": [
        "subscriptions",
        "total",
        "page",
        "pageSize"
      ],
      "description": "Subscription list response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema139`

```json
{
  "type": "object",
  "properties": {
    "planId": {
      "type": "string",
      "minLength": 1,
      "description": "SDP subscription plan ID.",
      "example": "psp_example"
    },
    "counterpartyId": {
      "type": "string",
      "minLength": 1,
      "description": "Counterparty being billed for the recurring payment.",
      "example": "cpty_example"
    },
    "subscriberAddress": {
      "type": "string",
      "description": "Customer wallet address that authorizes the subscription.",
      "example": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    }
  },
  "required": [
    "planId",
    "counterpartyId",
    "subscriberAddress"
  ],
  "additionalProperties": false,
  "description": "Creates a pending SDP subscription record tied to a counterparty. Lifecycle, schedule, on-chain addresses, and authorization proof are server-owned and populated only by verified flows."
}
```


### `#/components/schemas/ReviewSchema140`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "subscription": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "SDP subscription ID.",
              "example": "psub_example"
            },
            "organizationId": {
              "type": "string",
              "minLength": 1,
              "description": "Organization identifier.",
              "example": "org_example"
            },
            "projectId": {
              "type": "string",
              "minLength": 1,
              "description": "Project identifier.",
              "example": "prj_example"
            },
            "planId": {
              "type": "string",
              "description": "SDP subscription plan ID."
            },
            "counterpartyId": {
              "type": "string",
              "description": "Counterparty ID."
            },
            "subscriberAddress": {
              "type": "string",
              "minLength": 32,
              "maxLength": 44,
              "description": "Base58-encoded Solana address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "subscriberTokenAccount": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "Subscriber token account address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "subscriptionPda": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "On-chain subscription PDA.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "subscriptionAuthorityAddress": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "On-chain subscription authority address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "authorizationSignature": {
              "type": "string",
              "nullable": true,
              "description": "Customer authorization transaction signature."
            },
            "status": {
              "type": "string",
              "enum": [
                "pending_authorization",
                "active",
                "paused",
                "canceling",
                "canceled",
                "expired"
              ],
              "description": "Subscription status.",
              "example": "active"
            },
            "currentPeriodStartAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "nextCollectionDueAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "cancelAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "canceledAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "createdBy": {
              "type": "string",
              "nullable": true
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "updatedAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "organizationId",
            "projectId",
            "planId",
            "counterpartyId",
            "subscriberAddress",
            "subscriberTokenAccount",
            "subscriptionPda",
            "subscriptionAuthorityAddress",
            "authorizationSignature",
            "status",
            "currentPeriodStartAt",
            "nextCollectionDueAt",
            "cancelAt",
            "canceledAt",
            "createdBy",
            "createdAt",
            "updatedAt"
          ],
          "description": "Recurring payment subscription record."
        }
      },
      "required": [
        "subscription"
      ],
      "description": "Subscription response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema141`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "SDP subscription record ID.",
  "example": "psub_example"
}
```


### `#/components/schemas/ReviewSchema142`

```json
{
  "type": "string",
  "enum": [
    "pending",
    "processing",
    "confirmed",
    "failed",
    "skipped"
  ],
  "description": "Collection attempt status.",
  "example": "pending"
}
```


### `#/components/schemas/ReviewSchema143`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "collectionAttempts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "description": "Collection attempt ID.",
                "example": "psca_example"
              },
              "organizationId": {
                "type": "string",
                "minLength": 1,
                "description": "Organization identifier.",
                "example": "org_example"
              },
              "projectId": {
                "type": "string",
                "minLength": 1,
                "description": "Project identifier.",
                "example": "prj_example"
              },
              "subscriptionId": {
                "type": "string",
                "description": "Subscription ID."
              },
              "transferId": {
                "type": "string",
                "nullable": true,
                "minLength": 1,
                "description": "Payment transfer record ID when linked.",
                "example": "xfr_example"
              },
              "token": {
                "type": "string",
                "description": "Token mint or normalized token identifier."
              },
              "amount": {
                "type": "string",
                "description": "Token amount in UI units (decimal string).",
                "example": "100.00"
              },
              "dueAt": {
                "type": "string",
                "format": "date-time",
                "description": "ISO 8601 timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "attemptedAt": {
                "type": "string",
                "nullable": true,
                "format": "date-time",
                "description": "ISO 8601 timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "status": {
                "type": "string",
                "enum": [
                  "pending",
                  "processing",
                  "confirmed",
                  "failed",
                  "skipped"
                ],
                "description": "Collection attempt status.",
                "example": "pending"
              },
              "signature": {
                "type": "string",
                "nullable": true,
                "description": "Solana transaction signature."
              },
              "error": {
                "type": "string",
                "nullable": true,
                "description": "Collection error, if any."
              },
              "metadata": {
                "oneOf": [
                  {
                    "type": "object",
                    "properties": {
                      "recurringPaymentId": {
                        "type": "string"
                      },
                      "initiatedByKeyId": {
                        "type": "string",
                        "nullable": true
                      },
                      "source": {
                        "type": "string",
                        "enum": [
                          "manual"
                        ]
                      }
                    },
                    "required": [
                      "recurringPaymentId",
                      "initiatedByKeyId",
                      "source"
                    ]
                  },
                  {
                    "type": "object",
                    "properties": {
                      "recurringPaymentId": {
                        "type": "string"
                      },
                      "initiatedByKeyId": {
                        "type": "string",
                        "nullable": true
                      },
                      "source": {
                        "type": "string",
                        "enum": [
                          "automated"
                        ]
                      }
                    },
                    "required": [
                      "recurringPaymentId",
                      "initiatedByKeyId",
                      "source"
                    ]
                  },
                  {
                    "type": "object",
                    "properties": {
                      "recurringPaymentId": {
                        "type": "string"
                      },
                      "initiatedByKeyId": {
                        "type": "string",
                        "nullable": true
                      },
                      "source": {
                        "type": "string",
                        "enum": [
                          "retry"
                        ]
                      },
                      "initialSource": {
                        "type": "string",
                        "enum": [
                          "manual",
                          "automated"
                        ]
                      },
                      "transferId": {
                        "type": "string",
                        "nullable": true
                      },
                      "error": {
                        "type": "string"
                      },
                      "retryAfterAt": {
                        "type": "string"
                      }
                    },
                    "required": [
                      "recurringPaymentId",
                      "initiatedByKeyId",
                      "source",
                      "initialSource",
                      "transferId",
                      "error",
                      "retryAfterAt"
                    ]
                  },
                  {
                    "type": "object",
                    "properties": {
                      "recurringPaymentId": {
                        "type": "string"
                      },
                      "initiatedByKeyId": {
                        "type": "string",
                        "nullable": true
                      },
                      "source": {
                        "type": "string",
                        "enum": [
                          "linked_transfer"
                        ]
                      },
                      "initialSource": {
                        "type": "string",
                        "enum": [
                          "manual",
                          "automated"
                        ]
                      },
                      "transferId": {
                        "type": "string"
                      }
                    },
                    "required": [
                      "recurringPaymentId",
                      "initiatedByKeyId",
                      "source",
                      "initialSource",
                      "transferId"
                    ]
                  }
                ],
                "description": "Provider/job metadata for the attempt."
              },
              "createdAt": {
                "type": "string",
                "format": "date-time",
                "description": "ISO 8601 timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              },
              "updatedAt": {
                "type": "string",
                "format": "date-time",
                "description": "ISO 8601 timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              }
            },
            "required": [
              "id",
              "organizationId",
              "projectId",
              "subscriptionId",
              "transferId",
              "token",
              "amount",
              "dueAt",
              "attemptedAt",
              "status",
              "signature",
              "error",
              "metadata",
              "createdAt",
              "updatedAt"
            ],
            "description": "Recurring payment collection attempt record."
          }
        },
        "total": {
          "type": "integer"
        },
        "page": {
          "type": "integer"
        },
        "pageSize": {
          "type": "integer"
        }
      },
      "required": [
        "collectionAttempts",
        "total",
        "page",
        "pageSize"
      ],
      "description": "Collection attempt list response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema144`

```json
{
  "type": "object",
  "properties": {
    "subscriberTokenAccount": {
      "type": "string",
      "description": "Subscriber token account that authorizes the subscription authority delegation.",
      "example": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    },
    "expectedPlanCreatedAt": {
      "type": "string",
      "pattern": "^\\d+$",
      "description": "Unsigned 64-bit created-at timestamp from the on-chain plan terms that the subscriber consents to.",
      "example": "0"
    },
    "expectedSubscriptionAuthorityInitId": {
      "type": "string",
      "pattern": "^-?\\d+$",
      "description": "Signed 64-bit init id from the on-chain subscription authority that the subscriber consents to.",
      "example": "0"
    }
  },
  "required": [
    "subscriberTokenAccount",
    "expectedPlanCreatedAt",
    "expectedSubscriptionAuthorityInitId"
  ],
  "description": "Inputs for preparing the subscriber-signed Solana subscription authorization transaction."
}
```


### `#/components/schemas/ReviewSchema145`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "subscription": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "SDP subscription ID.",
              "example": "psub_example"
            },
            "organizationId": {
              "type": "string",
              "minLength": 1,
              "description": "Organization identifier.",
              "example": "org_example"
            },
            "projectId": {
              "type": "string",
              "minLength": 1,
              "description": "Project identifier.",
              "example": "prj_example"
            },
            "planId": {
              "type": "string",
              "description": "SDP subscription plan ID."
            },
            "counterpartyId": {
              "type": "string",
              "description": "Counterparty ID."
            },
            "subscriberAddress": {
              "type": "string",
              "minLength": 32,
              "maxLength": 44,
              "description": "Base58-encoded Solana address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "subscriberTokenAccount": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "Subscriber token account address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "subscriptionPda": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "On-chain subscription PDA.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "subscriptionAuthorityAddress": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "On-chain subscription authority address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "authorizationSignature": {
              "type": "string",
              "nullable": true,
              "description": "Customer authorization transaction signature."
            },
            "status": {
              "type": "string",
              "enum": [
                "pending_authorization",
                "active",
                "paused",
                "canceling",
                "canceled",
                "expired"
              ],
              "description": "Subscription status.",
              "example": "active"
            },
            "currentPeriodStartAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "nextCollectionDueAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "cancelAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "canceledAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "createdBy": {
              "type": "string",
              "nullable": true
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "updatedAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "organizationId",
            "projectId",
            "planId",
            "counterpartyId",
            "subscriberAddress",
            "subscriberTokenAccount",
            "subscriptionPda",
            "subscriptionAuthorityAddress",
            "authorizationSignature",
            "status",
            "currentPeriodStartAt",
            "nextCollectionDueAt",
            "cancelAt",
            "canceledAt",
            "createdBy",
            "createdAt",
            "updatedAt"
          ],
          "description": "Recurring payment subscription record."
        },
        "subscriptionPda": {
          "type": "string",
          "minLength": 32,
          "maxLength": 44,
          "description": "Derived subscription delegation PDA.",
          "example": "So11111111111111111111111111111111111111112"
        },
        "subscriptionAuthorityAddress": {
          "type": "string",
          "minLength": 32,
          "maxLength": 44,
          "description": "Derived subscription authority PDA.",
          "example": "So11111111111111111111111111111111111111112"
        },
        "preparedTransaction": {
          "type": "object",
          "properties": {
            "serialized": {
              "type": "string",
              "minLength": 1,
              "description": "Base64-encoded unsigned transaction.",
              "example": "AQID"
            },
            "blockhash": {
              "type": "string",
              "description": "Blockhash for the transaction.",
              "example": "blockhash_example"
            },
            "lastValidBlockHeight": {
              "type": "string",
              "description": "Last valid block height.",
              "example": "123456"
            },
            "requiredSigners": {
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 32,
                "maxLength": 44,
                "description": "Base58-encoded Solana address.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "description": "Addresses that must sign the prepared transaction. This includes the sponsored fee payer when the transaction uses one."
            }
          },
          "required": [
            "serialized",
            "blockhash",
            "lastValidBlockHeight",
            "requiredSigners"
          ],
          "description": "Unsigned Solana subscriptions transaction payload for client-side signing."
        }
      },
      "required": [
        "subscription",
        "subscriptionPda",
        "subscriptionAuthorityAddress",
        "preparedTransaction"
      ],
      "description": "Prepared subscription authorization response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema146`

```json
{
  "type": "object",
  "properties": {},
  "description": "Empty request body for preparing subscriber-signed subscription lifecycle transactions."
}
```


### `#/components/schemas/ReviewSchema147`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "subscription": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "SDP subscription ID.",
              "example": "psub_example"
            },
            "organizationId": {
              "type": "string",
              "minLength": 1,
              "description": "Organization identifier.",
              "example": "org_example"
            },
            "projectId": {
              "type": "string",
              "minLength": 1,
              "description": "Project identifier.",
              "example": "prj_example"
            },
            "planId": {
              "type": "string",
              "description": "SDP subscription plan ID."
            },
            "counterpartyId": {
              "type": "string",
              "description": "Counterparty ID."
            },
            "subscriberAddress": {
              "type": "string",
              "minLength": 32,
              "maxLength": 44,
              "description": "Base58-encoded Solana address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "subscriberTokenAccount": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "Subscriber token account address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "subscriptionPda": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "On-chain subscription PDA.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "subscriptionAuthorityAddress": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "On-chain subscription authority address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "authorizationSignature": {
              "type": "string",
              "nullable": true,
              "description": "Customer authorization transaction signature."
            },
            "status": {
              "type": "string",
              "enum": [
                "pending_authorization",
                "active",
                "paused",
                "canceling",
                "canceled",
                "expired"
              ],
              "description": "Subscription status.",
              "example": "active"
            },
            "currentPeriodStartAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "nextCollectionDueAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "cancelAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "canceledAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "createdBy": {
              "type": "string",
              "nullable": true
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "updatedAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "organizationId",
            "projectId",
            "planId",
            "counterpartyId",
            "subscriberAddress",
            "subscriberTokenAccount",
            "subscriptionPda",
            "subscriptionAuthorityAddress",
            "authorizationSignature",
            "status",
            "currentPeriodStartAt",
            "nextCollectionDueAt",
            "cancelAt",
            "canceledAt",
            "createdBy",
            "createdAt",
            "updatedAt"
          ],
          "description": "Recurring payment subscription record."
        },
        "preparedTransaction": {
          "type": "object",
          "properties": {
            "serialized": {
              "type": "string",
              "minLength": 1,
              "description": "Base64-encoded unsigned transaction.",
              "example": "AQID"
            },
            "blockhash": {
              "type": "string",
              "description": "Blockhash for the transaction.",
              "example": "blockhash_example"
            },
            "lastValidBlockHeight": {
              "type": "string",
              "description": "Last valid block height.",
              "example": "123456"
            },
            "requiredSigners": {
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 32,
                "maxLength": 44,
                "description": "Base58-encoded Solana address.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "description": "Addresses that must sign the prepared transaction. This includes the sponsored fee payer when the transaction uses one."
            }
          },
          "required": [
            "serialized",
            "blockhash",
            "lastValidBlockHeight",
            "requiredSigners"
          ],
          "description": "Unsigned Solana subscriptions transaction payload for client-side signing."
        }
      },
      "required": [
        "subscription",
        "preparedTransaction"
      ],
      "description": "Prepared subscription lifecycle response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema148`

```json
{
  "type": "object",
  "properties": {
    "receiverTokenAccount": {
      "type": "string",
      "description": "Receiver token account for the pulled subscription payment. It must be allowed by the on-chain plan.",
      "example": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    }
  },
  "required": [
    "receiverTokenAccount"
  ],
  "additionalProperties": false,
  "description": "Inputs for preparing the collector-signed Solana subscriptions transfer transaction. The amount is always derived from the stored plan."
}
```


### `#/components/schemas/ReviewSchema149`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "subscription": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "SDP subscription ID.",
              "example": "psub_example"
            },
            "organizationId": {
              "type": "string",
              "minLength": 1,
              "description": "Organization identifier.",
              "example": "org_example"
            },
            "projectId": {
              "type": "string",
              "minLength": 1,
              "description": "Project identifier.",
              "example": "prj_example"
            },
            "planId": {
              "type": "string",
              "description": "SDP subscription plan ID."
            },
            "counterpartyId": {
              "type": "string",
              "description": "Counterparty ID."
            },
            "subscriberAddress": {
              "type": "string",
              "minLength": 32,
              "maxLength": 44,
              "description": "Base58-encoded Solana address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "subscriberTokenAccount": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "Subscriber token account address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "subscriptionPda": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "On-chain subscription PDA.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "subscriptionAuthorityAddress": {
              "type": "string",
              "nullable": true,
              "minLength": 32,
              "maxLength": 44,
              "description": "On-chain subscription authority address.",
              "example": "So11111111111111111111111111111111111111112"
            },
            "authorizationSignature": {
              "type": "string",
              "nullable": true,
              "description": "Customer authorization transaction signature."
            },
            "status": {
              "type": "string",
              "enum": [
                "pending_authorization",
                "active",
                "paused",
                "canceling",
                "canceled",
                "expired"
              ],
              "description": "Subscription status.",
              "example": "active"
            },
            "currentPeriodStartAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "nextCollectionDueAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "cancelAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "canceledAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "createdBy": {
              "type": "string",
              "nullable": true
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "updatedAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "organizationId",
            "projectId",
            "planId",
            "counterpartyId",
            "subscriberAddress",
            "subscriberTokenAccount",
            "subscriptionPda",
            "subscriptionAuthorityAddress",
            "authorizationSignature",
            "status",
            "currentPeriodStartAt",
            "nextCollectionDueAt",
            "cancelAt",
            "canceledAt",
            "createdBy",
            "createdAt",
            "updatedAt"
          ],
          "description": "Recurring payment subscription record."
        },
        "preparedTransaction": {
          "type": "object",
          "properties": {
            "serialized": {
              "type": "string",
              "minLength": 1,
              "description": "Base64-encoded unsigned transaction.",
              "example": "AQID"
            },
            "blockhash": {
              "type": "string",
              "description": "Blockhash for the transaction.",
              "example": "blockhash_example"
            },
            "lastValidBlockHeight": {
              "type": "string",
              "description": "Last valid block height.",
              "example": "123456"
            },
            "requiredSigners": {
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 32,
                "maxLength": 44,
                "description": "Base58-encoded Solana address.",
                "example": "So11111111111111111111111111111111111111112"
              },
              "description": "Addresses that must sign the prepared transaction. This includes the sponsored fee payer when the transaction uses one."
            }
          },
          "required": [
            "serialized",
            "blockhash",
            "lastValidBlockHeight",
            "requiredSigners"
          ],
          "description": "Unsigned Solana subscriptions transaction payload for client-side signing."
        },
        "collectionAttempt": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "Collection attempt ID.",
              "example": "psca_example"
            },
            "organizationId": {
              "type": "string",
              "minLength": 1,
              "description": "Organization identifier.",
              "example": "org_example"
            },
            "projectId": {
              "type": "string",
              "minLength": 1,
              "description": "Project identifier.",
              "example": "prj_example"
            },
            "subscriptionId": {
              "type": "string",
              "description": "Subscription ID."
            },
            "transferId": {
              "type": "string",
              "nullable": true,
              "minLength": 1,
              "description": "Payment transfer record ID when linked.",
              "example": "xfr_example"
            },
            "token": {
              "type": "string",
              "description": "Token mint or normalized token identifier."
            },
            "amount": {
              "type": "string",
              "description": "Token amount in UI units (decimal string).",
              "example": "100.00"
            },
            "dueAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "attemptedAt": {
              "type": "string",
              "nullable": true,
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "status": {
              "type": "string",
              "enum": [
                "pending",
                "processing",
                "confirmed",
                "failed",
                "skipped"
              ],
              "description": "Collection attempt status.",
              "example": "pending"
            },
            "signature": {
              "type": "string",
              "nullable": true,
              "description": "Solana transaction signature."
            },
            "error": {
              "type": "string",
              "nullable": true,
              "description": "Collection error, if any."
            },
            "metadata": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "recurringPaymentId": {
                      "type": "string"
                    },
                    "initiatedByKeyId": {
                      "type": "string",
                      "nullable": true
                    },
                    "source": {
                      "type": "string",
                      "enum": [
                        "manual"
                      ]
                    }
                  },
                  "required": [
                    "recurringPaymentId",
                    "initiatedByKeyId",
                    "source"
                  ]
                },
                {
                  "type": "object",
                  "properties": {
                    "recurringPaymentId": {
                      "type": "string"
                    },
                    "initiatedByKeyId": {
                      "type": "string",
                      "nullable": true
                    },
                    "source": {
                      "type": "string",
                      "enum": [
                        "automated"
                      ]
                    }
                  },
                  "required": [
                    "recurringPaymentId",
                    "initiatedByKeyId",
                    "source"
                  ]
                },
                {
                  "type": "object",
                  "properties": {
                    "recurringPaymentId": {
                      "type": "string"
                    },
                    "initiatedByKeyId": {
                      "type": "string",
                      "nullable": true
                    },
                    "source": {
                      "type": "string",
                      "enum": [
                        "retry"
                      ]
                    },
                    "initialSource": {
                      "type": "string",
                      "enum": [
                        "manual",
                        "automated"
                      ]
                    },
                    "transferId": {
                      "type": "string",
                      "nullable": true
                    },
                    "error": {
                      "type": "string"
                    },
                    "retryAfterAt": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "recurringPaymentId",
                    "initiatedByKeyId",
                    "source",
                    "initialSource",
                    "transferId",
                    "error",
                    "retryAfterAt"
                  ]
                },
                {
                  "type": "object",
                  "properties": {
                    "recurringPaymentId": {
                      "type": "string"
                    },
                    "initiatedByKeyId": {
                      "type": "string",
                      "nullable": true
                    },
                    "source": {
                      "type": "string",
                      "enum": [
                        "linked_transfer"
                      ]
                    },
                    "initialSource": {
                      "type": "string",
                      "enum": [
                        "manual",
                        "automated"
                      ]
                    },
                    "transferId": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "recurringPaymentId",
                    "initiatedByKeyId",
                    "source",
                    "initialSource",
                    "transferId"
                  ]
                }
              ],
              "description": "Provider/job metadata for the attempt."
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "updatedAt": {
              "type": "string",
              "format": "date-time",
              "description": "ISO 8601 timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "organizationId",
            "projectId",
            "subscriptionId",
            "transferId",
            "token",
            "amount",
            "dueAt",
            "attemptedAt",
            "status",
            "signature",
            "error",
            "metadata",
            "createdAt",
            "updatedAt"
          ],
          "description": "Recurring payment collection attempt record."
        }
      },
      "required": [
        "subscription",
        "preparedTransaction"
      ],
      "description": "Prepared subscription collection response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema150`

```json
{
  "type": "string",
  "enum": [
    "payments",
    "earn",
    "dvp",
    "private_channels",
    "issuance",
    "rings"
  ]
}
```


### `#/components/schemas/ReviewSchema151`

```json
{
  "type": "string"
}
```


### `#/components/schemas/ReviewSchema152`

```json
{
  "type": "string",
  "enum": [
    "pending",
    "succeeded",
    "failed",
    "canceled"
  ]
}
```


### `#/components/schemas/ReviewSchema153`

```json
{
  "type": "string",
  "maxLength": 128
}
```


### `#/components/schemas/ReviewSchema154`

```json
{
  "type": "string",
  "minLength": 3,
  "maxLength": 200,
  "description": "Prefix match against transaction id, module id, or signature — not a substring search."
}
```


### `#/components/schemas/ReviewSchema155`

```json
{
  "type": "integer",
  "minimum": 1,
  "maximum": 100,
  "default": 50
}
```


### `#/components/schemas/ReviewSchema156`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "transactions": {
          "type": "array",
          "items": {
            "oneOf": [
              {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string"
                  },
                  "moduleId": {
                    "type": "string"
                  },
                  "status": {
                    "type": "string",
                    "enum": [
                      "pending",
                      "succeeded",
                      "failed",
                      "canceled"
                    ]
                  },
                  "organizationId": {
                    "type": "string"
                  },
                  "projectId": {
                    "type": "string",
                    "nullable": true
                  },
                  "custodyWalletId": {
                    "type": "string",
                    "nullable": true
                  },
                  "custodyWalletLabel": {
                    "type": "string",
                    "nullable": true
                  },
                  "token": {
                    "type": "string",
                    "nullable": true
                  },
                  "amount": {
                    "type": "string",
                    "nullable": true
                  },
                  "counterpartyId": {
                    "type": "string",
                    "nullable": true
                  },
                  "signature": {
                    "type": "string",
                    "nullable": true
                  },
                  "createdAt": {
                    "type": "string"
                  },
                  "module": {
                    "type": "string",
                    "enum": [
                      "payments"
                    ]
                  },
                  "kind": {
                    "type": "string",
                    "enum": [
                      "pay",
                      "confidential_pay",
                      "batch_pay",
                      "recurring_pay",
                      "deposit",
                      "request_deposit",
                      "onramp",
                      "offramp"
                    ]
                  },
                  "moduleStatus": {
                    "type": "string",
                    "enum": [
                      "pending",
                      "processing",
                      "confirmed",
                      "finalized",
                      "failed",
                      "awaiting_payment",
                      "settling",
                      "completed",
                      "canceled",
                      "expired"
                    ]
                  }
                },
                "required": [
                  "id",
                  "moduleId",
                  "status",
                  "organizationId",
                  "projectId",
                  "custodyWalletId",
                  "custodyWalletLabel",
                  "token",
                  "amount",
                  "counterpartyId",
                  "signature",
                  "createdAt",
                  "module",
                  "kind",
                  "moduleStatus"
                ]
              },
              {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string"
                  },
                  "moduleId": {
                    "type": "string"
                  },
                  "status": {
                    "type": "string",
                    "enum": [
                      "pending",
                      "succeeded",
                      "failed",
                      "canceled"
                    ]
                  },
                  "organizationId": {
                    "type": "string"
                  },
                  "projectId": {
                    "type": "string",
                    "nullable": true
                  },
                  "custodyWalletId": {
                    "type": "string",
                    "nullable": true
                  },
                  "custodyWalletLabel": {
                    "type": "string",
                    "nullable": true
                  },
                  "token": {
                    "type": "string",
                    "nullable": true
                  },
                  "amount": {
                    "type": "string",
                    "nullable": true
                  },
                  "counterpartyId": {
                    "type": "string",
                    "nullable": true
                  },
                  "signature": {
                    "type": "string",
                    "nullable": true
                  },
                  "createdAt": {
                    "type": "string"
                  },
                  "module": {
                    "type": "string",
                    "enum": [
                      "earn"
                    ]
                  },
                  "kind": {
                    "type": "string",
                    "enum": [
                      "deposit",
                      "withdraw"
                    ]
                  },
                  "moduleStatus": {
                    "type": "string",
                    "enum": [
                      "requested",
                      "processing",
                      "pending_approval",
                      "completed",
                      "partially_completed",
                      "failed",
                      "cancelled",
                      "submitted",
                      "confirmed",
                      "finalized"
                    ]
                  }
                },
                "required": [
                  "id",
                  "moduleId",
                  "status",
                  "organizationId",
                  "projectId",
                  "custodyWalletId",
                  "custodyWalletLabel",
                  "token",
                  "amount",
                  "counterpartyId",
                  "signature",
                  "createdAt",
                  "module",
                  "kind",
                  "moduleStatus"
                ]
              },
              {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string"
                  },
                  "moduleId": {
                    "type": "string"
                  },
                  "status": {
                    "type": "string",
                    "enum": [
                      "pending",
                      "succeeded",
                      "failed",
                      "canceled"
                    ]
                  },
                  "organizationId": {
                    "type": "string"
                  },
                  "projectId": {
                    "type": "string",
                    "nullable": true
                  },
                  "custodyWalletId": {
                    "type": "string",
                    "nullable": true
                  },
                  "custodyWalletLabel": {
                    "type": "string",
                    "nullable": true
                  },
                  "token": {
                    "type": "string",
                    "nullable": true
                  },
                  "amount": {
                    "type": "string",
                    "nullable": true
                  },
                  "counterpartyId": {
                    "type": "string",
                    "nullable": true
                  },
                  "signature": {
                    "type": "string",
                    "nullable": true
                  },
                  "createdAt": {
                    "type": "string"
                  },
                  "module": {
                    "type": "string",
                    "enum": [
                      "dvp"
                    ]
                  },
                  "kind": {
                    "type": "string",
                    "enum": [
                      "fund",
                      "close"
                    ]
                  },
                  "moduleStatus": {
                    "type": "string",
                    "enum": [
                      "creating",
                      "create_failed",
                      "created",
                      "partially_funded",
                      "funded",
                      "settled",
                      "cancelled",
                      "rejected",
                      "expired",
                      "closed_unknown"
                    ]
                  }
                },
                "required": [
                  "id",
                  "moduleId",
                  "status",
                  "organizationId",
                  "projectId",
                  "custodyWalletId",
                  "custodyWalletLabel",
                  "token",
                  "amount",
                  "counterpartyId",
                  "signature",
                  "createdAt",
                  "module",
                  "kind",
                  "moduleStatus"
                ]
              },
              {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string"
                  },
                  "moduleId": {
                    "type": "string"
                  },
                  "status": {
                    "type": "string",
                    "enum": [
                      "pending",
                      "succeeded",
                      "failed",
                      "canceled"
                    ]
                  },
                  "organizationId": {
                    "type": "string"
                  },
                  "projectId": {
                    "type": "string",
                    "nullable": true
                  },
                  "custodyWalletId": {
                    "type": "string",
                    "nullable": true
                  },
                  "custodyWalletLabel": {
                    "type": "string",
                    "nullable": true
                  },
                  "token": {
                    "type": "string",
                    "nullable": true
                  },
                  "amount": {
                    "type": "string",
                    "nullable": true
                  },
                  "counterpartyId": {
                    "type": "string",
                    "nullable": true
                  },
                  "signature": {
                    "type": "string",
                    "nullable": true
                  },
                  "createdAt": {
                    "type": "string"
                  },
                  "module": {
                    "type": "string",
                    "enum": [
                      "private_channels"
                    ]
                  },
                  "kind": {
                    "type": "string",
                    "enum": [
                      "transfer",
                      "deposit",
                      "withdraw"
                    ]
                  },
                  "moduleStatus": {
                    "type": "string",
                    "enum": [
                      "pending",
                      "submitted",
                      "confirmed",
                      "settled",
                      "failed"
                    ]
                  }
                },
                "required": [
                  "id",
                  "moduleId",
                  "status",
                  "organizationId",
                  "projectId",
                  "custodyWalletId",
                  "custodyWalletLabel",
                  "token",
                  "amount",
                  "counterpartyId",
                  "signature",
                  "createdAt",
                  "module",
                  "kind",
                  "moduleStatus"
                ]
              },
              {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string"
                  },
                  "moduleId": {
                    "type": "string"
                  },
                  "status": {
                    "type": "string",
                    "enum": [
                      "pending",
                      "succeeded",
                      "failed",
                      "canceled"
                    ]
                  },
                  "organizationId": {
                    "type": "string"
                  },
                  "projectId": {
                    "type": "string",
                    "nullable": true
                  },
                  "custodyWalletId": {
                    "type": "string",
                    "nullable": true
                  },
                  "custodyWalletLabel": {
                    "type": "string",
                    "nullable": true
                  },
                  "token": {
                    "type": "string",
                    "nullable": true
                  },
                  "amount": {
                    "type": "string",
                    "nullable": true
                  },
                  "counterpartyId": {
                    "type": "string",
                    "nullable": true
                  },
                  "signature": {
                    "type": "string",
                    "nullable": true
                  },
                  "createdAt": {
                    "type": "string"
                  },
                  "module": {
                    "type": "string",
                    "enum": [
                      "issuance"
                    ]
                  },
                  "kind": {
                    "type": "string",
                    "enum": [
                      "mint",
                      "burn",
                      "freeze",
                      "unfreeze",
                      "seize",
                      "force_burn",
                      "update_authority",
                      "pause",
                      "unpause",
                      "deploy"
                    ]
                  },
                  "moduleStatus": {
                    "type": "string",
                    "enum": [
                      "pending",
                      "processing",
                      "confirmed",
                      "finalized",
                      "failed"
                    ]
                  }
                },
                "required": [
                  "id",
                  "moduleId",
                  "status",
                  "organizationId",
                  "projectId",
                  "custodyWalletId",
                  "custodyWalletLabel",
                  "token",
                  "amount",
                  "counterpartyId",
                  "signature",
                  "createdAt",
                  "module",
                  "kind",
                  "moduleStatus"
                ]
              },
              {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string"
                  },
                  "moduleId": {
                    "type": "string"
                  },
                  "status": {
                    "type": "string",
                    "enum": [
                      "pending",
                      "succeeded",
                      "failed",
                      "canceled"
                    ]
                  },
                  "organizationId": {
                    "type": "string"
                  },
                  "projectId": {
                    "type": "string",
                    "nullable": true
                  },
                  "custodyWalletId": {
                    "type": "string",
                    "nullable": true
                  },
                  "custodyWalletLabel": {
                    "type": "string",
                    "nullable": true
                  },
                  "token": {
                    "type": "string",
                    "nullable": true
                  },
                  "amount": {
                    "type": "string",
                    "nullable": true
                  },
                  "counterpartyId": {
                    "type": "string",
                    "nullable": true
                  },
                  "signature": {
                    "type": "string",
                    "nullable": true
                  },
                  "createdAt": {
                    "type": "string"
                  },
                  "module": {
                    "type": "string",
                    "enum": [
                      "rings"
                    ]
                  },
                  "kind": {
                    "type": "string",
                    "enum": [
                      "shield",
                      "transfer_registered",
                      "transfer_anonymous",
                      "withdraw",
                      "merge",
                      "timelock_create",
                      "timelock_settle",
                      "zone_create",
                      "ring_exit",
                      "ring_entry"
                    ]
                  },
                  "moduleStatus": {
                    "type": "string",
                    "enum": [
                      "draft",
                      "preparing",
                      "approval_required",
                      "proving",
                      "ready_to_sign",
                      "submitted",
                      "indexing",
                      "completed",
                      "failed",
                      "voided"
                    ]
                  }
                },
                "required": [
                  "id",
                  "moduleId",
                  "status",
                  "organizationId",
                  "projectId",
                  "custodyWalletId",
                  "custodyWalletLabel",
                  "token",
                  "amount",
                  "counterpartyId",
                  "signature",
                  "createdAt",
                  "module",
                  "kind",
                  "moduleStatus"
                ]
              }
            ]
          }
        },
        "nextCursor": {
          "type": "string",
          "nullable": true
        }
      },
      "required": [
        "transactions",
        "nextCursor"
      ]
    }
  },
  "required": [
    "data"
  ]
}
```


### `#/components/schemas/ReviewSchema157`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "linked": {
          "type": "boolean",
          "description": "Whether the Clerk org is linked."
        },
        "organization": {
          "type": "object",
          "nullable": true,
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1,
              "description": "Organization identifier.",
              "example": "org_example"
            },
            "name": {
              "type": "string",
              "description": "Organization name.",
              "example": "Example Org"
            },
            "slug": {
              "type": "string",
              "description": "URL-friendly slug.",
              "example": "example-org"
            },
            "tier": {
              "type": "string",
              "enum": [
                "individual",
                "enterprise"
              ],
              "description": "Organization tier.",
              "example": "enterprise"
            },
            "status": {
              "type": "string",
              "enum": [
                "provisioning",
                "active",
                "suspended",
                "deleted"
              ],
              "description": "Organization status.",
              "example": "active"
            },
            "settings": {
              "type": "object",
              "nullable": true,
              "properties": {
                "defaultEnvironment": {
                  "type": "string",
                  "enum": [
                    "sandbox",
                    "production"
                  ],
                  "description": "Default environment for new resources.",
                  "example": "production"
                },
                "allowedIpAddresses": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  },
                  "description": "IPv4/IPv6 addresses and CIDR ranges the organization's API keys may be used from. It applies to every API-key request, intersected with each key's own `allowedIps`, and never to signed-in members. An empty or absent list places no restriction. Entries are stored in canonical form, so a range with host bits set is returned as the network it selects.",
                  "example": [
                    "203.0.113.0/24"
                  ]
                },
                "legacyAllowedIpAddresses": {
                  "nullable": true,
                  "description": "Read-only. An allowlist recorded before this setting was enforced, retained for reference and never applied. Send it back as `allowedIpAddresses` to put it into effect, which validates it first.",
                  "example": [
                    "203.0.113.0/24"
                  ]
                },
                "customRateLimits": {
                  "type": "object",
                  "properties": {
                    "requestsPerMinute": {
                      "type": "integer",
                      "minimum": 0,
                      "exclusiveMinimum": true,
                      "description": "Maximum requests allowed per minute.",
                      "example": 60
                    },
                    "requestsPerDay": {
                      "type": "integer",
                      "minimum": 0,
                      "exclusiveMinimum": true,
                      "description": "Maximum requests allowed per day.",
                      "example": 10000
                    }
                  },
                  "description": "Custom rate limit overrides."
                },
                "alertEmails": {
                  "type": "boolean",
                  "description": "Whether organization admins are emailed when money moves in a mainnet project or the organization's members, API keys, custody or mainnet access change. Unset means true. Turning it off is itself emailed to the admins.",
                  "example": true
                }
              },
              "additionalProperties": false,
              "description": "Organization settings (nullable when unset)."
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "Creation timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            },
            "updatedAt": {
              "type": "string",
              "format": "date-time",
              "description": "Last update timestamp.",
              "example": "2025-01-02T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "name",
            "slug",
            "tier",
            "status",
            "settings",
            "createdAt",
            "updatedAt"
          ],
          "description": "Linked organization details, if available."
        },
        "setup": {
          "type": "object",
          "nullable": true,
          "properties": {
            "status": {
              "type": "string",
              "enum": [
                "not_started",
                "in_progress",
                "complete"
              ]
            },
            "currentStep": {
              "type": "string",
              "enum": [
                "custody",
                "complete"
              ]
            },
            "custodyProviders": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "local",
                  "fireblocks",
                  "privy",
                  "coinbase_cdp",
                  "para",
                  "turnkey",
                  "dfns",
                  "ibm_haven",
                  "anchorage",
                  "utila"
                ],
                "description": "Wallet signing provider.",
                "example": "privy"
              },
              "description": "Custody providers with an active Managed config or active BYOK connection in the default sandbox project, in provider-catalog order."
            },
            "completedAt": {
              "type": "string",
              "nullable": true
            },
            "version": {
              "type": "integer",
              "minimum": 0,
              "exclusiveMinimum": true
            },
            "canManage": {
              "type": "boolean"
            }
          },
          "required": [
            "status",
            "currentStep",
            "custodyProviders",
            "completedAt",
            "version",
            "canManage"
          ]
        }
      },
      "required": [
        "linked",
        "organization",
        "setup"
      ],
      "description": "Onboarding status response."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema158`

```json
{
  "type": "string",
  "enum": [
    "email",
    "domain"
  ],
  "description": "Filter by allowlist entry type.",
  "example": "domain"
}
```


### `#/components/schemas/ReviewSchema159`

```json
{
  "type": "string",
  "enum": [
    "active",
    "disabled"
  ],
  "description": "Filter by allowlist entry status.",
  "example": "active"
}
```


### `#/components/schemas/ReviewSchema160`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "entries": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "description": "Allowlist entry identifier.",
                "example": "al_example"
              },
              "type": {
                "type": "string",
                "enum": [
                  "email",
                  "domain"
                ],
                "description": "Allowlist entry type.",
                "example": "domain"
              },
              "value": {
                "type": "string",
                "description": "Email address or domain value.",
                "example": "example.com"
              },
              "tier": {
                "type": "string",
                "description": "Allowlist tier label.",
                "example": "standard"
              },
              "notes": {
                "type": "string",
                "nullable": true,
                "description": "Optional notes.",
                "example": "Approved partner"
              },
              "status": {
                "type": "string",
                "enum": [
                  "active",
                  "disabled"
                ],
                "description": "Allowlist entry status.",
                "example": "active"
              },
              "createdAt": {
                "type": "string",
                "format": "date-time",
                "description": "Creation timestamp.",
                "example": "2025-01-01T00:00:00.000Z"
              }
            },
            "required": [
              "id",
              "type",
              "value",
              "tier",
              "notes",
              "status",
              "createdAt"
            ],
            "description": "Allowlist entry record."
          },
          "description": "Allowlist entries."
        }
      },
      "required": [
        "entries"
      ],
      "description": "Allowlist entries response payload."
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema161`

```json
{
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "enum": [
        "email",
        "domain"
      ],
      "description": "Allowlist entry type.",
      "example": "email"
    },
    "value": {
      "type": "string",
      "minLength": 1,
      "description": "Email or domain to allowlist.",
      "example": "example.com"
    },
    "tier": {
      "type": "string",
      "enum": [
        "standard",
        "pro",
        "enterprise"
      ],
      "description": "Optional allowlist tier.",
      "example": "standard"
    },
    "notes": {
      "type": "string",
      "maxLength": 500,
      "description": "Optional notes.",
      "example": "Approved partner"
    }
  },
  "required": [
    "type",
    "value"
  ],
  "description": "Add allowlist entry request body."
}
```


### `#/components/schemas/ReviewSchema162`

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "entry": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1,
              "description": "Allowlist entry identifier.",
              "example": "al_example"
            },
            "type": {
              "type": "string",
              "enum": [
                "email",
                "domain"
              ],
              "description": "Allowlist entry type.",
              "example": "domain"
            },
            "value": {
              "type": "string",
              "description": "Email address or domain value.",
              "example": "example.com"
            },
            "tier": {
              "type": "string",
              "description": "Allowlist tier label.",
              "example": "standard"
            },
            "notes": {
              "type": "string",
              "nullable": true,
              "description": "Optional notes.",
              "example": "Approved partner"
            },
            "status": {
              "type": "string",
              "enum": [
                "active",
                "disabled"
              ],
              "description": "Allowlist entry status.",
              "example": "active"
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "description": "Creation timestamp.",
              "example": "2025-01-01T00:00:00.000Z"
            }
          },
          "required": [
            "id",
            "type",
            "value",
            "tier",
            "notes",
            "status",
            "createdAt"
          ],
          "description": "Allowlist entry record."
        }
      },
      "required": [
        "entry"
      ]
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1,
          "description": "Request identifier for tracing.",
          "example": "req_example"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp.",
          "example": "2025-01-01T00:00:00.000Z"
        }
      },
      "required": [
        "requestId",
        "timestamp"
      ],
      "description": "Response metadata."
    }
  },
  "required": [
    "data",
    "meta"
  ],
  "description": "Standard success response envelope."
}
```


### `#/components/schemas/ReviewSchema163`

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Allowlist entry identifier.",
  "example": "al_example"
}
```


### `#/components/securitySchemes/adminKey`

```json
{
  "type": "apiKey",
  "in": "header",
  "name": "X-Admin-Key",
  "description": "Admin key for internal allowlist management."
}
```


### `#/components/securitySchemes/apiKeyAuth`

```json
{
  "type": "http",
  "scheme": "bearer",
  "bearerFormat": "API Key",
  "description": "Use Authorization: Bearer sf_<key id>_<secret><checksum>. Keys issued before this format (sk_test_..., sk_live_...) are still accepted."
}
```


### `#/components/securitySchemes/clerkBearerAuth`

```json
{
  "type": "http",
  "scheme": "bearer",
  "bearerFormat": "JWT",
  "description": "Clerk JWT bearer token for dashboard authentication."
}
```
