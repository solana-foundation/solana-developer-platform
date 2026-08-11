const graphqlEndpoint = "https://api.github.com/graphql";

export async function githubGraphqlRequest({ query, variables, token, fetchImpl = fetch }) {
  if (!token) {
    throw new Error("GITHUB_TOKEN is required to call the GitHub GraphQL API");
  }

  const response = await fetchImpl(graphqlEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`GraphQL request failed: ${response.status} ${text}`);
  }

  if (!response.ok || payload.errors?.length) {
    const message = payload.errors?.map((error) => error.message).join("; ") || text;
    throw new Error(`GraphQL request failed: ${response.status} ${message}`);
  }

  return payload.data;
}

export async function createCommitOnBranch({
  repository,
  branch,
  expectedHeadOid,
  headline,
  additions,
  token,
  fetchImpl = fetch,
}) {
  if (!repository || !token) {
    throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required to create a commit");
  }

  const query = `
    mutation CreateCommitOnBranch($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) {
        commit {
          oid
          url
        }
      }
    }
  `;
  const data = await githubGraphqlRequest({
    query,
    variables: {
      input: {
        branch: {
          repositoryNameWithOwner: repository,
          branchName: branch,
        },
        expectedHeadOid,
        message: { headline },
        fileChanges: { additions },
      },
    },
    token,
    fetchImpl,
  });

  const commit = data?.createCommitOnBranch?.commit;
  if (!commit?.oid) {
    throw new Error("GraphQL request did not return a created commit");
  }

  return commit;
}
