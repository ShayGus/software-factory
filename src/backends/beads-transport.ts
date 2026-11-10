import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { BeadsConfig } from "../config.js";
import { AxiError } from "../errors.js";

/** No shell, implicit workspace discovery, embedded fallback, or unbounded process. */
export class BeadsTransport {
  private checked?: Promise<void>;
  constructor(readonly config: BeadsConfig) {}

  private async check(): Promise<void> {
    const c = this.config;
    let metadata: Record<string, unknown>;
    try {
      if (realpathSync(c.path) !== c.path) throw new Error("path is not canonical");
      metadata = JSON.parse(readFileSync(`${c.path}/metadata.json`, "utf8"));
    } catch {
      throw new AxiError("Beads requires an existing canonical server workspace", "VALIDATION_ERROR");
    }
    if (metadata.dolt_mode !== "server" || metadata.dolt_database !== c.database ||
        (c.server_socket ? metadata.dolt_server_socket !== c.server_socket :
          metadata.dolt_server_host !== c.server_host || metadata.dolt_server_port !== c.server_port) ||
        (metadata.dolt_server_user ?? "root") !== c.server_user) {
      throw new AxiError("Beads workspace server settings do not match [beads]; embedded mode is refused", "VALIDATION_ERROR");
    }
    const version = await this.execute(["version"]);
    if (!/^bd version 1\.1\.0 \(8e4e59d39: HEAD@8e4e59d39f34\)/.test(version.trim())) {
      throw new AxiError("Beads adapter requires pinned bd 1.1.0 (8e4e59d39f34)", "UNSUPPORTED");
    }
  }

  async json(args: string[], input?: string): Promise<unknown> {
    this.checked ??= this.check();
    await this.checked;
    const stdout = await this.execute([...args, "--actor", "tasks-axi", "--json", "--sandbox"], input);
    let value: unknown;
    try { value = JSON.parse(stdout); } catch {
      throw new AxiError("Beads returned malformed JSON", "UNKNOWN");
    }
    if (value && typeof value === "object" && "error" in value) {
      throw new AxiError(`Beads failed: ${String(value.error)}`, "CONFLICT");
    }
    return value;
  }

  private execute(args: string[], input?: string): Promise<string> {
    const c = this.config;
    const env = { ...process.env };
    // Ambient connection variables must not redirect an explicitly selected workspace.
    for (const key of Object.keys(env)) {
      if (key.startsWith("BEADS_DOLT_") && key !== "BEADS_DOLT_PASSWORD") delete env[key];
    }
    delete env.BEADS_DB;
    delete env.BEADS_REPO;
    env.BEADS_DIR = c.path;
    env.BEADS_DOLT_AUTO_START = "0";
    env.BEADS_DOLT_DATABASE = c.database;
    env.BEADS_DOLT_SERVER_USER = c.server_user;
    if (c.server_socket) env.BEADS_DOLT_SERVER_SOCKET = c.server_socket;
    else {
      env.BEADS_DOLT_SERVER_HOST = c.server_host;
      env.BEADS_DOLT_SERVER_PORT = String(c.server_port);
    }
    return new Promise((resolve, reject) => {
      const child = spawn(c.binary, args, { cwd: dirname(c.path), env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "", size = 0, timedOut = false, overflow = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, c.timeout_ms);
      const capture = (chunk: Buffer, error: boolean) => {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) { overflow = true; child.kill("SIGKILL"); return; }
        if (error) stderr += chunk.toString(); else stdout += chunk.toString();
      };
      child.stdout.on("data", (b: Buffer) => capture(b, false));
      child.stderr.on("data", (b: Buffer) => capture(b, true));
      child.stdin.on("error", () => { /* exit/error handler reports failed transport */ });
      child.on("error", () => { clearTimeout(timer); reject(new AxiError("Cannot execute configured beads.binary", "UNKNOWN")); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut || overflow || code !== 0) {
          // SQL may have committed before a lost response: callers must inspect and retry.
          reject(new AxiError(timedOut ? "Beads timed out; inspect task state before retrying" :
            overflow ? "Beads output exceeded transport limit" : `Beads command failed: ${stderr.trim() || stdout.trim() || code}`,
          "CONFLICT"));
        } else resolve(stdout);
      });
      child.stdin.end(input);
    });
  }
}
