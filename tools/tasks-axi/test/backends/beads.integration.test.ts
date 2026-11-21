import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BeadsStore } from "../../src/backends/beads.js";
import { BeadsTransport } from "../../src/backends/beads-transport.js";
import { sqlString } from "../../src/backends/beads-sql.js";
import type { BeadsConfig } from "../../src/config.js";
import { addCommand, showCommand } from "../../src/commands/crud.js";
import {
  startCommand,
  doneCommand,
  reopenCommand,
  holdCommand,
  unholdCommand,
  readyCommand,
  mvCommand,
} from "../../src/commands/state.js";
import { isHoldActive, readyTasks } from "../../src/derive.js";

const enabled = Boolean(process.env.TASKS_AXI_BEADS_TEST_CONFIG);
const config: BeadsConfig = enabled
  ? JSON.parse(process.env.TASKS_AXI_BEADS_TEST_CONFIG!)
  : {};
const second: BeadsConfig = enabled
  ? JSON.parse(process.env.TASKS_AXI_BEADS_SECOND_CONFIG!)
  : {};
if (
  enabled &&
  (!config.path.startsWith("/tmp/tasks-axi-beads-test-") ||
    !config.database.startsWith("tasks_axi_test_") ||
    readFileSync(`${config.path}/.tasks-axi-scratch`, "utf8") !==
      config.database)
)
  throw new Error("Fresh scratch fixture required");
const id = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;
const make = () => new BeadsStore(config, () => "2026-11-10");
const sql = (query: string) => new BeadsTransport(config).json(["sql", query]);

describe.skipIf(!enabled)(
  "pinned bd 1.1.0 with a shared scratch Dolt server",
  () => {
    it("reads native Scotty tickets and adopts edits without losing identity, native data or holds", async () => {
      const store = make(),
        transport = new BeadsTransport(config);
      const parent = id("native-parent"),
        child = id("native-child");
      await transport.json([
        "create",
        "Native feature",
        "--id",
        `fm-${parent}`,
        "-t",
        "feature",
      ]);
      await transport.json([
        "create",
        "Native task",
        "--id",
        `fm-${child}`,
        "--description",
        "Created in Scotty",
        "--assignee",
        "Shay",
      ]);
      await transport.json([
        "update",
        `fm-${child}`,
        "--parent",
        `fm-${parent}`,
      ]);
      await transport.json(["comment", `fm-${child}`, "Owner comment"]);
      await sql(
        `UPDATE issues SET metadata=JSON_OBJECT('foreign',JSON_OBJECT('keep',true)) WHERE id=${sqlString(`fm-${child}`)}`,
      );
      expect(await store.get(child)).toMatchObject({
        id: child,
        title: "Native task",
        body: "Created in Scotty",
        state: "queued",
        deps: [{ id: parent, type: "parent" }],
      });
      expect((await store.get(parent))?.kind).toBe("feature");
      expect(
        (await store.list({})).items.some((task) => task.id === child),
      ).toBe(true);
      await store.update(child, {
        title: "Agent edit",
        body: "Agent instructions",
      });
      const native = (await transport.json([
        "show",
        `fm-${child}`,
        "--include-comments",
      ])) as {
        title: string;
        assignee: string;
        comments: { text: string }[];
        metadata: { foreign: unknown };
      }[];
      expect(native[0]).toMatchObject({
        title: "Agent edit",
        assignee: "Shay",
        metadata: { foreign: { keep: true } },
      });
      expect(
        native[0].comments.some((comment) => comment.text === "Owner comment"),
      ).toBe(true);
      // Native holds are a live projection, never frozen into tasks_axi metadata.
      for (const status of ["blocked", "deferred", "pinned", "hooked"]) {
        await transport.json(["update", `fm-${child}`, "-s", status]);
        expect((await store.get(child))?.hold?.reason).toBe(
          `Native Beads status: ${status}`,
        );
        await expect(store.transition(child, "in_flight")).rejects.toThrow(
          /held/,
        );
        await store.update(child, { title: `Agent edit while ${status}` });
        expect(
          (
            (await transport.json(["show", `fm-${child}`])) as {
              status: string;
            }[]
          )[0].status,
        ).toBe(status);
        await transport.json(["update", `fm-${child}`, "-s", "open"]);
        expect((await store.get(child))?.hold).toBeUndefined();
      }
      await transport.json(["update", `fm-${child}`, "--add-label", "human"]);
      expect((await store.get(child))?.hold?.kind).toBe("captain");
      expect(
        readyTasks((await store.list({})).items).some(
          (task) => task.id === child,
        ),
      ).toBe(false);
      await store.update(child, { priority: 1 });
      await expect(store.transition(child, "in_flight")).rejects.toThrow(
        /held/,
      );
      await transport.json([
        "update",
        `fm-${child}`,
        "--remove-label",
        "human",
      ]);
      expect((await store.get(child))?.hold).toBeUndefined();
      await store.transition(child, "in_flight");
      await store.remove(child);
      await store.remove(parent);
    }, 30000);

    it("archives a native closed ticket without requiring prior tasks-axi metadata", async () => {
      const store = make(),
        logical = id("native-closed"),
        transport = new BeadsTransport(config);
      await transport.json([
        "create",
        "Native closed",
        "--id",
        `fm-${logical}`,
      ]);
      await transport.json(["close", `fm-${logical}`]);
      const before = await store.get(logical);
      expect(before?.state).toBe("done");
      const record = await Reflect.get(store, "require").call(store, logical);
      const entry = Reflect.get(store, "entry").call(
        store,
        before,
        record,
        "archive",
        true,
      );
      await Reflect.get(store, "apply").call(store, [entry]);
      expect(
        (await store.list({ state: "done" })).items.some(
          (task) => task.id === logical,
        ),
      ).toBe(false);
      expect((await store.get(logical))?.title).toBe("Native closed");
      await store.remove(logical);
    }, 20000);

    it("preserves IDs, full bodies, legacy dates, metadata and native edits through either client", async () => {
      const a = make(),
        b = new BeadsStore(second, () => "2026-11-10"),
        logical = id("fm-prefixed");
      const task = await a.create({
        id: logical,
        title: "Title ' quoted \\ 雪",
        body: "a\n\n  ## Resolution\nanswer\n",
        created: null,
        kind: "captain",
        repo: "app",
        meta: { home: "scratch", nested: { keep: true } },
      });
      expect(task.created).toBeUndefined();
      expect(await b.get(logical)).toEqual(task);
      expect(await b.get(`fm-${logical}`)).toBeNull();
      await sql(
        `UPDATE issues SET metadata=JSON_SET(metadata,'$.foreign',JSON_OBJECT('keep',true)),title='Native edit' WHERE id=${sqlString(`fm-${logical}`)}`,
      );
      const result = await b.update(logical, {
        body: "curated",
        archiveBody: true,
        meta: { next: 1 },
      });
      expect(result.changed).toContain("archive");
      expect(result.task.title).toBe("Native edit");
      expect(result.task.meta).toEqual({
        home: "scratch",
        nested: { keep: true },
        next: 1,
      });
      expect(
        (await a.update(logical, { body: "curated", meta: { next: 1 } }))
          .changed,
      ).toEqual([]);
      const rows = (await sql(
        `SELECT metadata FROM issues WHERE id=${sqlString(`fm-${logical}`)}`,
      )) as { metadata: string }[];
      expect(JSON.parse(rows[0].metadata).foreign).toEqual({ keep: true });
      const history = await sql(
        `SELECT snapshot FROM tasks_axi_history_v1 WHERE physical_id=${sqlString(`fm-${logical}`)}`,
      );
      expect(JSON.stringify(history)).toContain("Resolution");
      await b.remove(logical);
      expect(await a.get(logical)).toBeNull();
    }, 20000);

    it("creates native parent-child edges through the task CLI", async () => {
      const store = make(),
        parent = id("feature"),
        child = id("slice");
      const context = {
        store,
        config: {
          backend: "beads" as const,
          path: config.path,
          beads: config,
          doneKeep: 10,
        },
      };
      await addCommand(
        [parent, "Existing feature", "--kind", "feature", "--repo", "tachles"],
        context,
      );
      const receipt = JSON.parse(
        await addCommand(
          [
            child,
            "Planned slice",
            "--parent",
            parent,
            "--repo",
            "tachles",
            "--hold-reason",
            "Instruction check pending",
            "--json",
          ],
          context,
        ),
      );
      expect(receipt.task.deps).toEqual([{ type: "parent", id: parent }]);
      expect(receipt.task.blocked).toBe(false);
      expect(
        await sql(
          `SELECT issue_id,label FROM labels WHERE issue_id IN (${sqlString(`fm-${parent}`)},${sqlString(`fm-${child}`)}) ORDER BY issue_id`,
        ),
      ).toEqual(
        [parent, child].sort().map((task) => ({
          issue_id: `fm-${task}`,
          label: "project:tachles",
        })),
      );
      const edges = await sql(
        `SELECT issue_id,depends_on_issue_id,type FROM dependencies WHERE issue_id=${sqlString(`fm-${child}`)}`,
      );
      expect(edges).toEqual([
        {
          issue_id: `fm-${child}`,
          depends_on_issue_id: `fm-${parent}`,
          type: "parent-child",
        },
      ]);
      expect((await store.get(child))?.deps).toEqual([
        { type: "parent", id: parent },
      ]);
    }, 20000);

    it("keeps dependency direction/reasons, protects blockers and preserves unrelated relations", async () => {
      const s = make(),
        blocker = id("blocker"),
        dependent = id("dependent"),
        other = id("other");
      for (const logical of [blocker, other])
        await s.create({ id: logical, title: logical });
      await s.create({
        id: dependent,
        title: dependent,
        deps: [{ type: "blocked-by", id: blocker, reason: "waits on login" }],
      });
      await expect(s.remove(blocker)).rejects.toThrow(/still blocking/);
      expect(
        await s.addDep(dependent, { type: "blocked-by", id: blocker }),
      ).toBe(false);
      expect((await s.get(dependent))?.deps).toEqual([
        { type: "blocked-by", id: blocker, reason: "waits on login" },
      ]);
      await sql(
        `INSERT INTO dependencies(id,issue_id,depends_on_issue_id,type,created_by) VALUES (UUID(),${sqlString(`fm-${dependent}`)},${sqlString(`fm-${other}`)},'relates-to','test')`,
      );
      expect(
        await s.removeDep(dependent, { type: "blocked-by", id: blocker }),
      ).toBe(true);
      expect(
        await s.removeDep(dependent, { type: "blocked-by", id: blocker }),
      ).toBe(false);
      const unrelated = await sql(
        `SELECT type FROM dependencies WHERE issue_id=${sqlString(`fm-${dependent}`)}`,
      );
      expect(unrelated).toEqual([{ type: "relates-to" }]);
      await s.remove(blocker);
      await expect(
        s.addDep(dependent, { type: "blocked-by", id: dependent }),
      ).rejects.toThrow(/self/);
      await expect(
        s.addDep(dependent, { type: "blocked-by", id: "absent" }),
      ).rejects.toThrow(/not found/);
    }, 20000);

    it("hydrates more than 50 rows without a native list cap and keeps stable filtering/order", async () => {
      const s = make(),
        repo = id("many");
      for (let n = 0; n < 61; n++)
        await s.create({
          id: `${repo}-${n}`,
          title: `row ${n}`,
          repo,
          priority: n % 5,
        });
      const all = await s.list({ repo });
      expect(all.total).toBe(61);
      expect(all.items).toHaveLength(61);
      expect((await s.list({ repo, limit: 3 })).items).toEqual(
        all.items.slice(0, 3),
      );
      expect((await s.list({ repo })).items.map((t) => t.id)).toEqual(
        all.items.map((t) => t.id),
      );
    }, 60000);

    it("rolls back a failed create after insertion and rejects a stale two-client write", async () => {
      const a = make(),
        b = new BeadsStore(second, () => "2026-11-10"),
        logical = id("atomic");
      // Exercise the actual SQL transaction boundary, including failure after INSERT.
      const task = {
        id: logical,
        title: "Atomic",
        state: "queued",
        deps: [],
        links: [],
      };
      const entry = Reflect.get(a, "entry").call(a, task);
      entry.edges = [{ id: "fm-no-such-target", type: "blocks" }];
      await expect(Reflect.get(a, "apply").call(a, [entry])).rejects.toThrow(
        /refused|conflict/,
      );
      expect(await a.get(logical)).toBeNull();
      await a.create(task as Parameters<BeadsStore["create"]>[0]);
      const oldA = await Reflect.get(a, "require").call(a, logical),
        oldB = await Reflect.get(b, "require").call(b, logical);
      const ea = Reflect.get(a, "entry").call(
        a,
        { ...oldA.task, title: "writer a" },
        oldA,
      );
      const eb = Reflect.get(b, "entry").call(
        b,
        { ...oldB.task, title: "writer b" },
        oldB,
      );
      const results = await Promise.allSettled([
        Reflect.get(a, "apply").call(a, [ea]),
        Reflect.get(b, "apply").call(b, [eb]),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(["writer a", "writer b"]).toContain((await a.get(logical))?.title);
    }, 20000);

    it("labels tickets for project names added by callers and preserves the label on an idempotent add", async () => {
      const store = make();
      const logical = id("project-task");
      const project = id("new-project");
      const ctx = {
        store,
        config: { backend: "beads" as const, path: config.path, beads: config, doneKeep: 10 },
      };
      const args = [logical, "A task for the new project", "--repo", project, "--json"];
      await addCommand(args, ctx);
      await addCommand(args, ctx);
      await store.update(logical, { title: "Edited description of work" });
      const labels = () => sql(
        `SELECT label FROM labels WHERE issue_id=${sqlString(`fm-${logical}`)}`,
      );
      expect(await labels()).toEqual([{ label: `project:${project}` }]);
      await store.remove(logical);
      expect(await labels()).toEqual([]);
    }, 20000);

    it("creates held captain work atomically and preserves evidence/holds across lifecycle replay", async () => {
      const store = make(),
        logical = id("captain"),
        ctx = {
          store,
          config: {
            backend: "beads",
            path: config.path,
            doneKeep: 10,
            beads: config,
          },
        };
      const created = JSON.parse(
        await addCommand(
          [
            logical,
            "Captain decision",
            "--kind",
            "captain",
            "--hold-reason",
            "fm-hold-v1:encoded",
            "--hold-kind",
            "captain",
            "--json",
          ],
          ctx,
        ),
      );
      expect(created).toMatchObject({ ok: true, action: "add" });
      const held = await store.get(logical);
      expect(held?.hold).toEqual({
        reason: "fm-hold-v1:encoded",
        kind: "captain",
      });
      expect(
        readyTasks((await store.list({})).items).some((t) => t.id === logical),
      ).toBe(false);
      await expect(startCommand([logical, "--json"], ctx)).rejects.toThrow(
        /held/,
      );
      expect(await readyCommand(["--include-held"], ctx)).toContain(logical);
      const hint = await addCommand([logical, "Captain decision"], ctx);
      expect(hint).toContain(`unhold ${logical}`);
      expect(hint).not.toContain(`start ${logical}`);
      expect(
        JSON.parse(await unholdCommand([logical, "--json"], ctx)),
      ).toMatchObject({ ok: true, action: "unhold" });
      expect(
        JSON.parse(await startCommand([logical, "--json"], ctx)).task.state,
      ).toBe("in_flight");
      await holdCommand(
        [logical, "--reason", "awaits review", "--kind", "captain"],
        ctx,
      );
      const report = `data/${logical}/report.md`,
        pr = "https://github.com/example/repo/pull/3";
      const done = JSON.parse(
        await doneCommand(
          [
            logical,
            "--pr",
            pr,
            "--report",
            report,
            "--note",
            "resolution recorded",
            "--no-prune",
            "--json",
          ],
          ctx,
        ),
      );
      expect(done.task.state).toBe("done");
      expect(done.task.links).toContainEqual({ kind: "pr", url: pr });
      const closed = (await store.get(logical))?.closed;
      await doneCommand(
        [
          logical,
          "--note",
          "resolution recorded",
          "--report",
          report,
          "--no-prune",
          "--json",
        ],
        ctx,
      );
      expect((await store.get(logical))?.body).toBe("resolution recorded");
      expect((await store.get(logical))?.closed).toBe(closed);
      const reopened = JSON.parse(
        await reopenCommand([logical, "--json"], ctx),
      );
      expect(reopened).toMatchObject({
        ok: true,
        action: "reopen",
        task: { state: "queued" },
      });
      expect((await store.get(logical))?.hold?.reason).toBe("awaits review");
      expect(await showCommand([logical, "--full"], ctx)).toContain(report);
      await holdCommand(
        [
          logical,
          "--reason",
          "expired",
          "--kind",
          "future",
          "--until",
          "2000-01-01",
        ],
        ctx,
      );
      expect(isHoldActive((await store.get(logical))!)).toBe(false);
      expect((await store.transition(logical, "in_flight")).hold?.reason).toBe(
        "expired",
      );
      await expect(
        mvCommand([logical, "--to", "/tmp/must-not-write-backlog.md"], ctx),
      ).rejects.toThrow(/one-home/);
      await expect(
        store.create({
          id: id("obligation"),
          title: "no",
          kind: "public-followup",
        }),
      ).rejects.toThrow(/public followups/);
    }, 20000);

    it("archives by count without deletion, retains native history and reopens archived records", async () => {
      const store = make(),
        ids = [id("archive-a"), id("archive-b"), id("archive-c")];
      for (const logical of ids) {
        await store.create({
          id: logical,
          title: logical,
          body: "Captain resolution preserved",
        });
        await store.transition(logical, "done", {
          report: `data/${logical}/report.md`,
        });
      }
      const count = await sql("SELECT COUNT(*) AS count FROM issues");
      const result = await store.prune({
        state: "done",
        keep: 1,
        archive: true,
      });
      expect(result.archived).toBe(2);
      expect(result.ids).toHaveLength(2);
      expect(await sql("SELECT COUNT(*) AS count FROM issues")).toEqual(count);
      expect((await store.list({ state: "done" })).items).toHaveLength(1);
      const archived = result.ids[0];
      expect(await store.get(archived)).toMatchObject({
        state: "done",
        body: "Captain resolution preserved",
      });
      const history = await new BeadsTransport(second).json([
        "history",
        `fm-${archived}`,
      ]);
      expect(Array.isArray(history)).toBe(true);
      expect((history as unknown[]).length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(history)).toContain("Captain resolution preserved");
      await store.transition(archived, "queued");
      expect(
        (await store.list({ state: "queued" })).items.some(
          (t) => t.id === archived,
        ),
      ).toBe(true);
      expect((await store.get(archived))?.links).toContainEqual({
        kind: "report",
        url: `data/${archived}/report.md`,
      });
      const ctx = {
        store,
        config: {
          backend: "beads",
          path: config.path,
          doneKeep: 0,
          beads: config,
        },
      };
      const automatic = id("autoprune");
      await store.create({ id: automatic, title: automatic });
      const completed = JSON.parse(
        await doneCommand([automatic, "--json"], ctx),
      );
      expect(completed.ok).toBe(true);
      expect(completed.pruned).toBeGreaterThan(0);
      expect((await store.get(automatic))?.state).toBe("done");
      expect((await store.list({ state: "done" })).items).toEqual([]);
    }, 20000);

    it("round-trips large Unicode bodies and stdin, and refuses wrapper path overrides", async () => {
      const store = make(),
        logical = id("long-body"),
        body = "resolution: 雪\\quote'\n".repeat(5000);
      await store.create({ id: logical, title: "large body", body });
      expect((await store.get(logical))?.body).toBe(body);
      const viaDocker = new BeadsTransport(second);
      await viaDocker.json(
        ["update", `fm-${logical}`, "--body-file", "-"],
        "native stdin\n\nanswer",
      );
      expect((await store.get(logical))?.body).toBe("native stdin\n\nanswer");
      const denied = spawnSync(
        second.binary,
        ["list", "--directory", "/tmp/refused"],
        {
          env: { ...process.env, BEADS_DIR: second.path },
          encoding: "utf8",
        },
      );
      expect(denied.status).toBe(1);
      expect(denied.stderr).toContain("override is refused");
      const unknown = spawnSync(second.binary, ["list"], {
        env: { ...process.env, BEADS_DIR: config.path },
        encoding: "utf8",
      });
      expect(unknown.status).toBe(1);
      expect(unknown.stderr).toContain("not allowlisted");
    }, 30000);

    it("bounds a failed server read, never maps it to absence, then recovers", async () => {
      const logical = id("outage"),
        store = make();
      await store.create({ id: logical, title: "survives outage" });
      const server = process.env.TASKS_AXI_BEADS_TEST_SERVER!;
      expect(spawnSync("docker", ["pause", server]).status).toBe(0);
      try {
        await expect(
          new BeadsStore({ ...config, timeout_ms: 150 }).get(logical),
        ).rejects.toThrow(/verify|timed out/);
      } finally {
        expect(spawnSync("docker", ["unpause", server]).status).toBe(0);
      }
      expect((await store.get(logical))?.title).toBe("survives outage");
    }, 10000);
  },
);
