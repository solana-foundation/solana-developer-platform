// The requests of the Intent tab as curl, TypeScript, and Rust.

const SERVICE = "http://127.0.0.1:8787";

// A single quote ends the shell's quoted string, so each one closes, escapes, and reopens it.
function shellJson(value: object): string {
  return `'${JSON.stringify(value, null, 2).replace(/'/g, "'\\''")}'`;
}

export function prepareSnippets(request: object): Record<string, string> {
  const body = JSON.stringify(request, null, 2);

  return {
    curl: `curl -s ${SERVICE}/v1/prepare \\\n  -H 'content-type: application/json' \\\n  -d ${shellJson(request)}`,
    TypeScript: `const plan = await fetch("${SERVICE}/v1/prepare", {\n  method: "POST",\n  headers: { "content-type": "application/json" },\n  body: JSON.stringify(${body.replace(/\n/g, "\n  ")}),\n}).then((response) => response.json());`,
    Rust: `// sdp-intents prepare plans the same request against RPC, with no service.\nlet request = serde_json::json!(${body});\nlet plan: serde_json::Value = reqwest::blocking::Client::new()\n    .post("${SERVICE}/v1/prepare")\n    .json(&request)\n    .send()?\n    .json()?;`,
  };
}

/// A plan of instructions alone: the CLI compiles it to a version, verifies that message, then
/// signs and sends it. `/v1/verify` reads a message of any version.
export function compileSnippets(): Record<string, string> {
  return {
    CLI: `# Compile the instructions as a legacy, v0, or v1 transaction, then verify and send it.\nsdp-intents verify plan.json --rpc http://127.0.0.1:8899 --version 0 --lookup-table <table>\nsdp-intents send plan.json --rpc http://127.0.0.1:8899 --version 0 --lookup-table <table> --keypair <signer.json>`,
    curl: `# Verify a message that the caller compiled, of any version.\ncurl -s ${SERVICE}/v1/verify \\\n  -H 'content-type: application/json' \\\n  -d ${shellJson({ message: "<base64 message>", expected: "<plan message>" })}`,
  };
}

export function sendSnippets(compiled: string, message: string): Record<string, string> {
  return {
    curl: `# Verify as the signer, then sign with the service's local wallets and send.\ncurl -s ${SERVICE}/v1/verify \\\n  -H 'content-type: application/json' \\\n  -d ${shellJson({ message: compiled, expected: message })}\n\ncurl -s ${SERVICE}/v1/send \\\n  -H 'content-type: application/json' \\\n  -d ${shellJson({ message: compiled })}`,
    CLI: `# The client's verifier reads the registry over RPC, with no service.\nsdp-intents verify plan.json --rpc http://127.0.0.1:8899\nsdp-intents send plan.json --rpc http://127.0.0.1:8899 --keypair <signer.json>`,
    Rust: `let client = sdp_intents_client::Client::new("http://127.0.0.1:8899");\nlet compiled = base64::engine::general_purpose::STANDARD.decode("${compiled.slice(0, 24)}…")?;\nlet verified = client.verify_message(&compiled)?;\nassert_eq!(verified.message, plan_message);\nlet signature = client.send_message(&compiled, &[&fee_payer, &owner])?;`,
  };
}
