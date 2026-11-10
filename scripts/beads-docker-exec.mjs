#!/usr/bin/env node
// One executable argument for [beads].binary and FirstMate's BEADS_DIR contract.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";

try {
  const entries = JSON.parse(readFileSync(process.env.TASKS_AXI_BEADS_DOCKER_ALLOWLIST, "utf8"));
  const workspace = realpathSync(process.env.BEADS_DIR);
  const entry = entries.find((e) => e.path === workspace);
  if (!entry || !isAbsolute(entry.containerPath) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(entry.container)) {
    throw new Error("workspace is not allowlisted");
  }
  const args = process.argv.slice(2);
  if (!["version", "list", "show", "sql", "create", "update", "close", "reopen", "dep", "delete"].includes(args[0])) {
    throw new Error("command is not allowlisted");
  }
  for (const arg of args) {
    if (/^(?:--(?:db|directory|global|repo|file|output|design-file|agents-file)(?:=|$)|-C)/.test(arg)) {
      throw new Error("workspace/path override is refused");
    }
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--body-file" && args[i + 1] !== "-" || args[i].startsWith("--body-file=") && args[i] !== "--body-file=-") {
      throw new Error("use --body-file - with stdin through the wrapper");
    }
  }
  const command = ["exec", "-i", "--workdir", dirname(entry.containerPath)];
  if (entry.user !== undefined) command.push("--user", String(entry.user));
  command.push("--env", `BEADS_DIR=${entry.containerPath}`);
  for (const key of ["BD_DUE_REQUIRED", "BEADS_ACTOR", "BEADS_DOLT_PASSWORD", "BEADS_DOLT_DATABASE",
    "BEADS_DOLT_SERVER_HOST", "BEADS_DOLT_SERVER_PORT", "BEADS_DOLT_SERVER_USER", "BEADS_DOLT_SERVER_SOCKET"]) {
    let value = process.env[key];
    if (value === undefined) continue;
    if (key === "BEADS_DOLT_SERVER_SOCKET") {
      if (value !== entry.socket || !isAbsolute(entry.containerSocket ?? "")) throw new Error("socket is not allowlisted");
      value = entry.containerSocket;
    }
    command.push("--env", `${key}=${value}`);
  }
  command.push(entry.container, entry.binary ?? "bd", ...args);
  const result = spawnSync("docker", command, { stdio: "inherit", timeout: 60000, killSignal: "SIGKILL" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`beads-docker-exec: ${error.message}`);
  process.exitCode = 1;
}
