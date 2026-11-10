import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfigToml, resolveConfig } from "../src/config.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture(extra = "") {
  const dir = mkdtempSync(join(tmpdir(), "tasks-beads-config-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, ".tasks.toml"),
    `backend = "beads"
[beads]
path = "scratch/.beads"
binary = "./bd-wrapper"
prefix = "fm"
database = "scratch"
server_socket = "scratch/server.sock"
${extra}`,
  );
  return { cwd: dir, home: dir, env: {} };
}
describe("Beads configuration", () => {
  it("resolves every workspace/executable/socket path at the backlog root", () => {
    const options = fixture("done_keep = 4\ntimeout_ms = 1200");
    const config = resolveConfig(options);
    expect(config.path).toBe(join(options.cwd, "scratch/.beads"));
    expect(config.doneKeep).toBe(4);
    expect(config.beads).toMatchObject({
      binary: join(options.cwd, "bd-wrapper"),
      server_socket: join(options.cwd, "scratch/server.sock"),
      database: "scratch",
      prefix: "fm",
      timeout_ms: 1200,
    });
  });
  it("refuses ambiguous Markdown pins, implicit servers and mixed endpoints", () => {
    const options = fixture();
    expect(() => resolveConfig({ ...options, file: "backlog.md" })).toThrow(
      /Markdown-only/,
    );
    expect(() => resolveConfig(fixture('server_host = "localhost"'))).toThrow(
      /Choose/,
    );
    expect(() => resolveConfig(fixture("timeout_ms = 0"))).toThrow(/timeout/);
    expect(() =>
      resolveConfig({ ...options, env: { TASKS_AXI_FILE: "x" } }),
    ).toThrow(/Markdown-only/);
  });
  it("type-checks known table keys and leaves unknown tables alone", () => {
    expect(() => parseConfigToml("[beads]\npath = 4")).toThrow(/quoted string/);
    expect(() => parseConfigToml('[beads]\nserver_port = "3306"')).toThrow(
      /integer/,
    );
    expect(parseConfigToml("[other]\nbad assignment")).toEqual({});
  });
});
