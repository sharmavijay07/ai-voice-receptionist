import { existsSync, readFileSync } from "node:fs";
import { loadBusiness } from "../src/server/config";
import { buildVapiAssistant, syncVapiAssistant } from "../src/server/assistants";

function loadEnvFile(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env");

async function main() {
  const apiKey = process.env.VAPI_API_KEY?.trim();
  if (!apiKey) {
    console.error("Set VAPI_API_KEY. In the Vapi dashboard open API Keys and copy the private key.");
    process.exit(1);
  }

  const business = loadBusiness(process.env.BUSINESS_CONFIG || "business/northline.yaml");
  const assistant = buildVapiAssistant(business, process.env);
  if (!assistant.serverUrl) {
    console.error("Set PUBLIC_BASE_URL to the public https origin, for example https://ai-voice-receptionist-mczp.onrender.com");
    process.exit(1);
  }

  const result = await syncVapiAssistant({
    apiKey,
    assistantId: process.env.VAPI_ASSISTANT_ID,
    payload: assistant,
  });
  const transfer = assistant.model.tools.find((tool) => tool.type === "transferCall");
  const number = transfer && "destinations" in transfer ? transfer.destinations[0]?.number : "";

  if (result.created) {
    console.log(`Created Vapi assistant ${result.id}.`);
    console.log("Put that id in VAPI_ASSISTANT_ID, then run this command again when the shop config changes.");
  } else {
    console.log(`Updated Vapi assistant ${result.id}.`);
  }
  console.log(`Tools call ${assistant.serverUrl}. Transfer destination ${number}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
