import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const envFile = path.join(root, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const consoleDir = path.join(root, "apps", "console");
const host = process.env.CONSOLE_HOST || "127.0.0.1";
const port = process.env.CONSOLE_PORT || "3000";
const baseUrl = `http://${host}:${port}`;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const child = spawn(process.execPath, [nextBin, "dev", "--hostname", host, "--port", port], {
  cwd: consoleDir,
  env: process.env,
  windowsHide: true
});

let output = "";

function append(data) {
  output += data.toString("utf8");
  if (output.length > 20_000) {
    output = output.slice(-20_000);
  }
}

child.stdout.on("data", append);
child.stderr.on("data", append);

function waitForReady() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Console dev server did not become ready.\n${output}`));
    }, 30_000);

    const interval = setInterval(() => {
      if (output.includes("Ready in")) {
        clearTimeout(timeout);
        clearInterval(interval);
        resolve();
      }
    }, 250);

    child.on("exit", (code) => {
      clearTimeout(timeout);
      clearInterval(interval);
      reject(new Error(`Console dev server exited with ${code}.\n${output}`));
    });
  });
}

try {
  await waitForReady();

  const page = await fetch(baseUrl);
  if (!page.ok) {
    throw new Error(`GET / returned ${page.status}`);
  }

  const overview = await fetch(`${baseUrl}/api/overview`);
  if (!overview.ok) {
    throw new Error(`GET /api/overview returned ${overview.status}: ${await overview.text()}`);
  }

  const payload = await overview.json();
  console.log(
    JSON.stringify(
      {
        pageStatus: page.status,
        projects: payload.projects.length,
        workers: payload.workers.length,
        tasks: payload.tasks.length,
        commands: payload.commands.length
      },
      null,
      2
    )
  );
} finally {
  child.kill();
}
