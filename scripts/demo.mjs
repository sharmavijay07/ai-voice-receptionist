import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

if (!existsSync(".env.local")) {
  copyFileSync(".env.example", ".env.local");
  console.log("Created .env.local from .env.example. Add GROQ_API_KEY there when you want Groq on the line.");
}
mkdirSync("data", { recursive: true });

const child = spawn("npx", ["next", "dev", "-p", "43123", "-H", "0.0.0.0"], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => process.exit(code ?? 0));
