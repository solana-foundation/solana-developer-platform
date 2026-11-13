// The requests of the Intent and Plan tabs as curl, TypeScript, and Rust.

const SERVICE = "http://127.0.0.1:8787";

export function prepareSnippets(request: object): Record<string, string> {
  const body = JSON.stringify(request, null, 2);

  return {
    curl: `curl -s ${SERVICE}/v1/prepare \\\n  -H 'content-type: application/json' \\\n  -d '${JSON.stringify(request)}'`,
    TypeScript: `const plan = await fetch("${SERVICE}/v1/prepare", {\n  method: "POST",\n  headers: { "content-type": "application/json" },\n  body: JSON.stringify(${body.replace(/\n/g, "\n  ")}),\n}).then((response) => response.json());`,
    Rust: `// sdp-intents prepare plans the same request against RPC, with no service.\nlet request = serde_json::json!(${body});\nlet plan: serde_json::Value = reqwest::blocking::Client::new()\n    .post("${SERVICE}/v1/prepare")\n    .json(&request)\n    .send()?\n    .json()?;`,
  };
}

export function sendSnippets(compiled: string, message: string): Record<string, string> {
  return {
    curl: `# Verify as the signer, then sign with the service's local wallets and send.\ncurl -s ${SERVICE}/v1/verify -H 'content-type: application/json' \\\n  -d '${JSON.stringify({ message: compiled, expected: message })}'\ncurl -s ${SERVICE}/v1/send -H 'content-type: application/json' \\\n  -d '${JSON.stringify({ message: compiled })}'`,
    CLI: `# The client's verifier reads the registry over RPC, with no service.\nsdp-intents verify plan.json --rpc http://127.0.0.1:8899\nsdp-intents send plan.json --rpc http://127.0.0.1:8899 --keypair <signer.json>`,
    Rust: `let client = sdp_intents_client::Client::new("http://127.0.0.1:8899");\nlet compiled = base64::engine::general_purpose::STANDARD.decode("${compiled.slice(0, 24)}…")?;\nlet verified = client.verify_message(&compiled)?;\nassert_eq!(verified.message, plan_message);\nlet signature = client.send_message(&compiled, &[&fee_payer, &owner])?;`,
  };
}
