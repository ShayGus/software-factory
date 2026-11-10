import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readFileSafe } from "./backends/lock.js";
import { AxiError } from "./errors.js";

/**
 * Backend + path resolution (report §8 config selection).
 *
 * Override order:
 *   --backend / --file flag > TASKS_AXI_* env > project .tasks.toml >
 *   ~/.tasks-axi/config.toml > defaults (markdown, first existing
 *   backlog.md/data/backlog.md, otherwise backlog.md).
 *
 * P1 ships only the markdown backend; the Store seam keeps sqlite/remote
 * additions invisible to the CLI layer.
 */

export interface ResolvedConfig {
  backend: string;
  /** Markdown backlog path (resolved to an absolute path). */
  path: string;
  /** Optional archive path for pruned tasks (resolved to an absolute path). */
  archivePath?: string;
  doneKeep: number;
  beads?: BeadsConfig;
}

export interface BeadsConfig {
  path: string;
  binary: string;
  prefix: string;
  database: string;
  server_host?: string;
  server_port?: number;
  server_user: string;
  server_socket?: string;
  timeout_ms: number;
}

export interface ConfigOverrides {
  backend?: string;
  file?: string;
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

interface TomlConfig {
  backend?: string;
  beads?: Partial<BeadsConfig> & { done_keep?: number };
  markdown?: {
    path?: string;
    archive?: string;
    done_keep?: number;
  };
}

const DEFAULT_KEEP = 10;
const PATH_CANDIDATES = ["backlog.md", "data/backlog.md"];
type ConfigTable = "root" | "markdown" | "beads" | "unsupported";

/**
 * Minimal TOML reader for the tiny config surface we need: a top-level
 * `backend` key and a `[markdown]` table with `path` / `archive` / `done_keep`.
 * `archive` points at the file that receives pruned tasks.
 * Intentionally not a general TOML parser.
 */
export function parseConfigToml(src: string): TomlConfig {
  const config: TomlConfig = {};
  let table: ConfigTable = "root";

  for (const rawLine of src.split("\n")) {
    const line = stripTomlComment(rawLine).trim();
    if (line === "") continue;

    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      const name = section[1].trim();
      table = name === "markdown" || name === "beads" ? name : "unsupported";
      continue;
    }

    if (table === "unsupported") continue;

    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!kv) {
      throw new AxiError(
        "Invalid config line: expected `key = value`",
        "VALIDATION_ERROR",
        ["Use `key = value` assignments in .tasks.toml"],
      );
    }
    const key = kv[1];
    const source = configKeySource(table, key);
    if (!source) continue;
    const value = parseTomlValue(kv[2], source);

    if (table === "root") {
      config.backend = requireTomlString(value, source);
      continue;
    }
    if (table === "beads") {
      config.beads ??= {};
      if (["server_port", "timeout_ms", "done_keep"].includes(key)) {
        if (typeof value !== "number") {
          throw new AxiError(`${source} must be an integer`, "VALIDATION_ERROR");
        }
        Object.assign(config.beads, { [key]: value });
      } else {
        Object.assign(config.beads, { [key]: requireTomlString(value, source) });
      }
      continue;
    }
    config.markdown ??= {};
    if (key === "path") config.markdown.path = requireTomlString(value, source);
    if (key === "archive")
      config.markdown.archive = requireTomlString(value, source);
    if (key === "done_keep") {
      if (typeof value !== "number") {
        throw new AxiError(
          "markdown.done_keep must be an integer",
          "VALIDATION_ERROR",
          ["Set `[markdown] done_keep = 10` in .tasks.toml"],
        );
      }
      config.markdown.done_keep = value;
    }
  }

  return config;
}

function stripTomlComment(raw: string): string {
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return raw.slice(0, i);
  }
  return raw;
}

function configKeySource(
  table: ConfigTable,
  key: string,
): string | undefined {
  if (table === "root" && key === "backend") return "backend";
  if (
    table === "markdown" &&
    (key === "path" || key === "archive" || key === "done_keep")
  ) {
    return `markdown.${key}`;
  }
  if (table === "beads" && ["path", "binary", "prefix", "database",
    "server_host", "server_port", "server_user", "server_socket", "timeout_ms", "done_keep"].includes(key)) {
    return `beads.${key}`;
  }
  return undefined;
}

function parseTomlValue(raw: string, source: string): string | number {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    if (!trimmed.endsWith(quote) || trimmed.length === 1) {
      throw new AxiError(
        `${source} has an unterminated quoted value`,
        "VALIDATION_ERROR",
      );
    }
    return trimmed.slice(1, -1);
  }
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  throw new AxiError(`${source} has an invalid value`, "VALIDATION_ERROR");
}

function requireTomlString(value: string | number, source: string): string {
  if (typeof value === "string") return value;
  throw new AxiError(`${source} must be a quoted string`, "VALIDATION_ERROR");
}

function loadToml(path: string): TomlConfig {
  const src = readFileSafe(path);
  return src ? parseConfigToml(src) : {};
}

function resolveMarkdownPath(
  explicit: string | undefined,
  tomlPath: string | undefined,
  cwd: string,
): string {
  const chosen = explicit ?? tomlPath;
  if (chosen) return isAbsolute(chosen) ? chosen : resolve(cwd, chosen);

  for (const candidate of PATH_CANDIDATES) {
    const full = resolve(cwd, candidate);
    if (existsSync(full)) return full;
  }
  return resolve(cwd, PATH_CANDIDATES[0]);
}

function validatePathValue(
  value: string | undefined,
  source: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") {
    throw new AxiError(`${source} must not be empty`, "VALIDATION_ERROR", [
      "Set it to a backlog path or remove the empty override",
    ]);
  }
  return value;
}

function validateDoneKeep(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AxiError(
      "markdown.done_keep must be a non-negative integer",
      "VALIDATION_ERROR",
      ["Set `[markdown] done_keep = 10` in .tasks.toml"],
    );
  }
  return value;
}

export function resolveConfig(overrides: ConfigOverrides = {}): ResolvedConfig {
  const env = overrides.env ?? process.env;
  const cwd = overrides.cwd ?? process.cwd();
  const home = overrides.home ?? homedir();

  const homeToml = loadToml(join(home, ".tasks-axi", "config.toml"));
  const projectToml = loadToml(resolve(cwd, ".tasks.toml"));

  const explicitPath =
    overrides.file !== undefined
      ? validatePathValue(overrides.file, "--file")
      : env.TASKS_AXI_FILE !== undefined
        ? validatePathValue(env.TASKS_AXI_FILE, "TASKS_AXI_FILE")
        : undefined;
  const tomlPath =
    explicitPath !== undefined
      ? undefined
      : projectToml.markdown?.path !== undefined
        ? validatePathValue(projectToml.markdown.path, "markdown.path")
        : validatePathValue(homeToml.markdown?.path, "markdown.path");

  const backend =
    overrides.backend ??
    env.TASKS_AXI_BACKEND ??
    projectToml.backend ??
    homeToml.backend ??
    "markdown";

  if (backend === "beads") {
    if (explicitPath !== undefined) {
      throw new AxiError("--file/TASKS_AXI_FILE is Markdown-only; configure beads.path explicitly", "VALIDATION_ERROR");
    }
    const values = { ...homeToml.beads, ...projectToml.beads };
    function required(key: "path" | "binary" | "prefix" | "database"): string {
      const value = validatePathValue(values[key], `beads.${key}`);
      if (!value) throw new AxiError(`beads.${key} is required`, "VALIDATION_ERROR");
      return value;
    }
    const path = resolve(cwd, required("path"));
    const binary = required("binary");
    const prefix = required("prefix");
    const database = required("database");
    if (!/^[a-z][a-z0-9-]*$/.test(prefix) || !/^[a-zA-Z0-9_]+$/.test(database)) {
      throw new AxiError("Invalid beads.prefix or beads.database", "VALIDATION_ERROR");
    }
    if (/\s/.test(binary) && !existsSync(resolve(cwd, binary))) {
      throw new AxiError("beads.binary must name one executable, not a shell command", "VALIDATION_ERROR");
    }
    const socket = values.server_socket ? resolve(cwd, values.server_socket) : undefined;
    const port = values.server_port;
    if (!socket && (!values.server_host || !Number.isInteger(port) || port! < 1 || port! > 65535)) {
      throw new AxiError("Beads requires server_socket or explicit server_host and server_port", "VALIDATION_ERROR");
    }
    if (socket && (values.server_host !== undefined || port !== undefined)) {
      throw new AxiError("Choose beads.server_socket or server_host/server_port", "VALIDATION_ERROR");
    }
    const timeout = values.timeout_ms ?? 15000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000) {
      throw new AxiError("beads.timeout_ms must be 1-60000", "VALIDATION_ERROR");
    }
    const beads: BeadsConfig = { path, binary: binary.includes("/") ? resolve(cwd, binary) : binary,
      prefix, database, server_user: values.server_user ?? "root", timeout_ms: timeout,
      ...(socket ? {server_socket: socket} : {server_host: values.server_host, server_port: port}) };
    return { backend, path, doneKeep: validateDoneKeep(values.done_keep ?? DEFAULT_KEEP), beads };
  }

  const path = resolveMarkdownPath(explicitPath, tomlPath, cwd);

  const archive =
    projectToml.markdown?.archive !== undefined
      ? validatePathValue(projectToml.markdown.archive, "markdown.archive")
      : validatePathValue(homeToml.markdown?.archive, "markdown.archive");
  const doneKeep = validateDoneKeep(
    projectToml.markdown?.done_keep ??
      homeToml.markdown?.done_keep ??
      DEFAULT_KEEP,
  );

  const config: ResolvedConfig = { backend, path, doneKeep };
  if (archive) {
    config.archivePath = isAbsolute(archive) ? archive : resolve(cwd, archive);
  }
  return config;
}
