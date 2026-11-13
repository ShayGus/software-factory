import { randomUUID } from "node:crypto";
import type { BeadsConfig } from "../config.js";
import { AxiError, unsupported } from "../errors.js";
import { validateId } from "../id.js";
import { isHoldActive } from "../derive.js";
import {
  HOLD_KINDS,
  STATES,
  type Dep,
  type State,
  type Task,
  type TaskInput,
  type TaskPatch,
  type TaskQuery,
  type TaskUpdateChange,
  type TaskUpdateResult,
  type TransitionOpts,
} from "../model.js";
import type { PublicFollowupMutation } from "../public-followup.js";
import type {
  Capabilities,
  PruneOptions,
  PruneResult,
  Store,
} from "../store.js";
import { deriveLinks, extractTags, leadingKind } from "./markdown-grammar.js";
import { BeadsTransport } from "./beads-transport.js";
import {
  APPLY_ROUTINE,
  HISTORY_TABLE,
  PAYLOAD_TABLE,
  PAYLOAD_IGNORE,
  READ,
  sqlString,
} from "./beads-sql.js";

interface Namespace {
  version: 1;
  logical_id: string;
  task: Task;
  revision: string;
  order: number;
  archived: boolean;
}
interface Row {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  metadata: unknown;
  edges: unknown;
  token: string;
}
interface RecordTask {
  task: Task;
  namespace: Namespace;
  row: Row;
}
const TO_NATIVE: Record<State, string> = {
  queued: "open",
  in_flight: "in_progress",
  done: "closed",
};
const FROM_NATIVE: Record<string, State | undefined> = {
  open: "queued",
  in_progress: "in_flight",
  closed: "done",
};
const EDGE_NATIVE = {
  "blocked-by": "blocks",
  parent: "parent-child",
  "discovered-from": "discovered-from",
};
const EDGE_LOGICAL: Record<string, Dep["type"] | undefined> = {
  blocks: "blocked-by",
  "parent-child": "parent",
  "discovered-from": "discovered-from",
};
const STATE_ORDER: State[] = ["in_flight", "queued", "done"];

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fail(message: string): never {
  throw new AxiError(message, "VALIDATION_ERROR");
}
function appendLink(task: Task, link: Task["links"][number]): void {
  if (!deriveLinks(link.url).some((candidate) => same(candidate, link)))
    fail(`Invalid ${link.kind} link`);
  if (!deriveLinks(task.title).some((candidate) => candidate.url === link.url))
    task.title += ` ${link.url}`;
  if (!task.links.some((candidate) => same(candidate, link)))
    task.links.push(link);
}
function jsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      fail("Invalid Beads JSON column");
    }
  }
  return value;
}
function object(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    fail("Invalid Beads metadata object");
  return parsed as Record<string, unknown>;
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a),
    kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every(
      (k) =>
        Object.hasOwn(b, k) &&
        same(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
    )
  );
}
function normalize(task: Task): Task {
  validateId(task.id);
  if (task.kind === "public-followup" || task.public_followup)
    throw unsupported("public followups", "beads");
  if (!STATES.includes(task.state)) fail("Invalid task state");
  if (
    typeof task.title !== "string" ||
    /[\r\n]/.test(task.title) ||
    !task.title.trim()
  )
    fail("Task title must be a nonempty single line");
  task.title = task.title.trim();
  if (extractTags(task.title).title !== task.title)
    fail("Task title must not end with canonical task tags");
  if (task.title.length > 500)
    fail("Beads task title must be at most 500 characters");
  for (const field of ["kind", "repo"] as const) {
    const value = task[field];
    if (value !== undefined) {
      if (typeof value !== "string" || /[()\r\n]/.test(value))
        fail(`Invalid task ${field}`);
      if (value.trim()) task[field] = value.trim();
      else delete task[field];
    }
  }
  task.kind ??= leadingKind(task.title);
  if (task.kind === undefined) delete task.kind;
  if (
    task.priority !== undefined &&
    (!Number.isInteger(task.priority) || task.priority < 0 || task.priority > 4)
  )
    fail("Task priority must be an integer 0-4");
  for (const date of [
    task.created,
    task.updated,
    task.closed,
    task.hold?.until,
  ]) {
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date))
      fail("Task dates must be YYYY-MM-DD");
  }
  if (task.hold) {
    if (!task.hold.reason?.trim() || /[()\r\n]/.test(task.hold.reason))
      fail("Invalid task hold reason");
    task.hold.reason = task.hold.reason.trim();
    if (task.hold.kind && !HOLD_KINDS.includes(task.hold.kind))
      fail("Invalid task hold kind");
  }
  const targets = new Set<string>();
  task.deps = task.deps
    .map((dep) => {
      validateId(dep.id);
      if (!(dep.type in EDGE_NATIVE) || dep.id === task.id)
        fail("Invalid dependency or self-block");
      if (targets.has(dep.id))
        fail("Beads supports one dependency type per target");
      targets.add(dep.id);
      if (
        dep.reason !== undefined &&
        (/[\r\n]/.test(dep.reason) ||
          /(?:^|\s)(?:blocked-by|parent|discovered-from):\s/.test(dep.reason))
      )
        fail("Invalid dependency reason");
      return {
        ...dep,
        ...(dep.reason !== undefined ? { reason: dep.reason.trim() } : {}),
      };
    })
    .sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  for (const link of task.links) {
    if (
      !deriveLinks(link.url).some(
        (candidate) =>
          candidate.kind === link.kind && candidate.url === link.url,
      )
    )
      fail(`Invalid ${link.kind} link`);
  }
  task.links = [...task.links, ...deriveLinks(task.title)].filter(
    (link, i, links) => links.findIndex((other) => same(other, link)) === i,
  );
  // Reject non-JSON metadata rather than silently dropping values in transport.
  if (task.meta) {
    try {
      if (!same(task.meta, JSON.parse(JSON.stringify(task.meta))))
        fail("Task meta must be JSON data");
    } catch {
      fail("Task meta must be JSON data");
    }
  }
  return task;
}

export class BeadsStore implements Store {
  private readonly transport: BeadsTransport;
  private installed?: Promise<void>;
  constructor(
    private readonly config: BeadsConfig,
    private readonly now: () => string = localToday,
  ) {
    this.transport = new BeadsTransport(config);
  }
  capabilities(): Capabilities {
    return {
      backend: "beads",
      deps: true,
      prune: true,
      comments: false,
      fullTextSearch: false,
      realtimeSync: false,
      customStates: false,
      serverMintsIds: false,
      publicFollowups: false,
    };
  }
  private physical(id: string): string {
    const value = `${this.config.prefix}-${validateId(id)}`;
    if (value.length > 255) fail("Beads physical ID exceeds 255 characters");
    return value;
  }
  private logical(id: string): string {
    const prefix = `${this.config.prefix}-`;
    if (!id.startsWith(prefix))
      fail("Foreign dependency outside this Beads workspace");
    return validateId(id.slice(prefix.length));
  }
  private decode(row: Row): RecordTask {
    if (
      !row ||
      typeof row.id !== "string" ||
      typeof row.token !== "string" ||
      typeof row.title !== "string" ||
      typeof row.description !== "string" ||
      !Number.isInteger(row.priority)
    )
      fail("Unsupported Beads row schema");
    const namespace = object(
      object(row.metadata).tasks_axi,
    ) as unknown as Namespace;
    const id = this.logical(row.id);
    if (
      namespace.version !== 1 ||
      namespace.logical_id !== id ||
      namespace.task?.id !== id ||
      typeof namespace.revision !== "string" ||
      !Number.isFinite(namespace.order) ||
      typeof namespace.archived !== "boolean"
    ) {
      fail("Foreign or unsupported tasks-axi metadata in Beads workspace");
    }
    const state = FROM_NATIVE[row.status];
    if (!state) throw unsupported(`native status ${row.status}`, "beads");
    const task = structuredClone(namespace.task);
    task.title = row.title;
    if (row.description !== "" || task.body !== undefined)
      task.body = row.description;
    task.state = state;
    if (task.priority !== undefined || row.priority !== 2)
      task.priority = row.priority;
    const edges = jsonValue(row.edges);
    if (!Array.isArray(edges)) fail("Unsupported Beads dependency schema");
    task.deps = edges.flatMap((edge: { id?: string; type?: string }) => {
      const type = EDGE_LOGICAL[edge.type ?? ""];
      if (!type) return [];
      if (!edge.id) fail("External Beads dependency is unsupported");
      const target = this.logical(edge.id);
      const reason = task.deps.find(
        (dep) => dep.id === target && dep.type === type,
      )?.reason;
      return [
        { type, id: target, ...(reason !== undefined ? { reason } : {}) },
      ];
    });
    // Metadata evidence remains durable even when a native client edits prose.
    return { task: normalize(task), namespace, row };
  }
  private async records(id?: string): Promise<RecordTask[]> {
    const rows = await this.transport.json([
      "sql",
      `${READ}${id === undefined ? "" : ` WHERE i.id=${sqlString(this.physical(id))}`}`,
    ]);
    if (!Array.isArray(rows)) fail("Unsupported Beads query envelope");
    return (rows as Row[]).map((row) => this.decode(row));
  }
  private async require(id: string): Promise<RecordTask> {
    const record = (await this.records(id))[0];
    if (!record) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    return record;
  }
  async get(id: string): Promise<Task | null> {
    return (await this.records(id))[0]?.task ?? null;
  }
  async list(query: TaskQuery): Promise<{ items: Task[]; total: number }> {
    const records = (await this.records())
      .filter((r) => !r.namespace.archived || r.task.state !== "done")
      .sort(
        (a, b) =>
          STATE_ORDER.indexOf(a.task.state) -
            STATE_ORDER.indexOf(b.task.state) ||
          a.namespace.order - b.namespace.order ||
          a.task.id.localeCompare(b.task.id),
      );
    const matched = records
      .map((r) => r.task)
      .filter(
        (t) =>
          (!query.state || t.state === query.state) &&
          (!query.repo || t.repo === query.repo) &&
          (!query.kind || t.kind === query.kind),
      );
    return {
      items:
        query.limit === undefined ? matched : matched.slice(0, query.limit),
      total: matched.length,
    };
  }
  private async install(): Promise<void> {
    await this.transport.json(["sql", HISTORY_TABLE]);
    await this.transport.json(["sql", PAYLOAD_TABLE]);
    await this.transport.json(["sql", PAYLOAD_IGNORE]);
    const inspect = () =>
      this.transport.json([
        "sql",
        "SELECT create_stmt FROM dolt_procedures WHERE name='tasks_axi_apply_v1'",
      ]);
    const rows = await inspect();
    if (!Array.isArray(rows)) fail("Unsupported Dolt procedure schema");
    if (!rows.length) {
      try {
        await this.transport.json(["sql", APPLY_ROUTINE]);
      } catch (error) {
        const concurrent = await inspect();
        if (!Array.isArray(concurrent) || !concurrent.length) throw error;
      }
    }
    const installed = await inspect();
    if (
      !Array.isArray(installed) ||
      installed[0]?.create_stmt !== APPLY_ROUTINE
    ) {
      throw unsupported(
        "installed tasks_axi_apply_v1 routine revision; provision a matching scratch-verified schema",
        "beads",
      );
    }
  }
  private entry(
    task: Task,
    record?: RecordTask,
    mode = record ? "update" : "create",
    archived = false,
  ) {
    const namespace: Namespace = {
      version: 1,
      logical_id: task.id,
      task,
      revision: randomUUID(),
      order:
        record?.namespace.order ??
        (task.state === "queued" ? Date.now() : -Date.now()),
      archived,
    };
    return {
      id: this.physical(task.id),
      mode,
      token: record?.row.token,
      namespace,
      status: TO_NATIVE[task.state],
      edges: task.deps.map((dep) => ({
        id: this.physical(dep.id),
        type: EDGE_NATIVE[dep.type],
      })),
    };
  }
  private async apply(
    entries: ReturnType<BeadsStore["entry"]>[],
  ): Promise<void> {
    this.installed ??= this.install();
    await this.installed;
    const wireEntries = entries.map((entry) =>
      entry.mode === "archive"
        ? {
            ...entry,
            namespace: { revision: entry.namespace.revision },
            edges: undefined,
          }
        : entry,
    );
    const payload = Buffer.from(
      JSON.stringify({ entries: wireEntries }),
      "utf8",
    );
    if (payload.length > 24000) {
      const request = randomUUID();
      try {
        for (let offset = 0; offset < payload.length; offset += 8192) {
          await this.transport.json([
            "sql",
            `INSERT INTO tasks_axi_payload_v1(request_id,part_index,data)
            VALUES (${sqlString(request)},${offset / 8192},X'${payload.subarray(offset, offset + 8192).toString("hex")}')`,
          ]);
        }
        await this.transport.json([
          "sql",
          `CALL tasks_axi_apply_v1(${sqlString(JSON.stringify({ request_id: request }))})`,
        ]);
      } catch (error) {
        try {
          await this.transport.json([
            "sql",
            `DELETE FROM tasks_axi_payload_v1 WHERE request_id=${sqlString(request)}`,
          ]);
        } catch {
          /* outage: retained staging data is never dispatchable */
        }
        throw error;
      }
    } else
      await this.transport.json([
        "sql",
        `CALL tasks_axi_apply_v1(${sqlString(payload.toString("utf8"))})`,
      ]);
    // A lost/conflicting response is never inferred successful from an exit code alone.
    for (const entry of entries) {
      const found = (await this.records(entry.namespace.logical_id))[0];
      if (
        entry.mode === "remove"
          ? found !== undefined
          : !found ||
            found.namespace.revision !== entry.namespace.revision ||
            !same(found.task, entry.namespace.task)
      ) {
        throw new AxiError(
          "Beads changed during mutation; inspect task state before retrying",
          "CONFLICT",
        );
      }
    }
  }
  async create(input: TaskInput): Promise<Task> {
    const value = {
      ...structuredClone(input),
      state: input.state ?? "queued",
      links: structuredClone(input.links ?? []),
      deps: structuredClone(input.deps ?? []),
    } as Task;
    if (input.created === null) delete value.created;
    else if (input.created === undefined && value.state !== "done")
      value.created = this.now();
    for (const link of value.links) appendLink(value, link);
    const task = normalize(value);
    if (/^(true|1|yes|on)$/i.test(process.env.BD_DUE_REQUIRED ?? ""))
      fail(
        "Beads due-required policy needs an explicit due date; this adapter does not invent one",
      );
    const existing = await this.get(task.id);
    if (existing) return existing;
    for (const dep of task.deps) await this.require(dep.id);
    await this.apply([this.entry(task)]);
    return task;
  }
  async update(id: string, patch: TaskPatch): Promise<TaskUpdateResult> {
    const record = await this.require(id),
      task = structuredClone(record.task);
    const changed: TaskUpdateChange[] = [];
    for (const field of [
      "title",
      "body",
      "repo",
      "kind",
      "priority",
    ] as const) {
      if (patch[field] !== undefined && !same(task[field], patch[field])) {
        Object.assign(task, { [field]: patch[field] });
        changed.push(field);
      }
    }
    if (patch.hold !== undefined && !same(task.hold, patch.hold ?? undefined)) {
      if (patch.hold === null) delete task.hold;
      else task.hold = structuredClone(patch.hold);
      changed.push("hold");
    }
    if (patch.meta) {
      const meta = { ...task.meta, ...patch.meta };
      if (!same(meta, task.meta)) {
        task.meta = meta;
        changed.push("meta");
      }
    }
    for (const line of patch.addBodyLines ?? []) {
      if (!task.body?.split("\n").includes(line)) {
        task.body = task.body ? `${task.body}\n${line}` : line;
        if (!changed.includes("body")) changed.push("body");
      }
    }
    for (const link of patch.addLinks ?? []) {
      const before = JSON.stringify([task.title, task.links]);
      appendLink(task, link);
      if (
        before !== JSON.stringify([task.title, task.links]) &&
        !changed.includes("links")
      )
        changed.push("links");
    }
    normalize(task);
    if (
      patch.archiveBody &&
      patch.body !== undefined &&
      changed.includes("body") &&
      record.task.body
    )
      changed.push("archive");
    if (!changed.length) return { task: record.task, changed };
    task.updated = this.now();
    await this.apply([
      this.entry(task, record, "update", record.namespace.archived),
    ]);
    return { task, changed };
  }
  async remove(id: string): Promise<Task> {
    const record = await this.require(id);
    const dependents = (await this.records()).filter(
      (r) =>
        r.task.state !== "done" &&
        r.task.deps.some((d) => d.type === "blocked-by" && d.id === id),
    );
    if (dependents.length)
      fail(
        `Task "${id}" is still blocking active tasks: ${dependents.map((r) => r.task.id).join(", ")}`,
      );
    await this.apply([this.entry(record.task, record, "remove")]);
    return record.task;
  }
  async addDep(id: string, dep: Dep): Promise<boolean> {
    const record = await this.require(id);
    if (record.task.deps.some((d) => d.type === dep.type && d.id === dep.id))
      return false;
    await this.require(dep.id);
    record.task.deps.push(dep);
    normalize(record.task);
    await this.apply([
      this.entry(record.task, record, "dependency", record.namespace.archived),
    ]);
    return true;
  }
  async removeDep(id: string, dep: Dep): Promise<boolean> {
    const record = await this.require(id),
      before = record.task.deps.length;
    record.task.deps = record.task.deps.filter(
      (d) => !(d.type === dep.type && d.id === dep.id),
    );
    if (record.task.deps.length === before) return false;
    await this.apply([
      this.entry(record.task, record, "dependency", record.namespace.archived),
    ]);
    return true;
  }
  async transition(
    id: string,
    to: State,
    opts: TransitionOpts = {},
  ): Promise<Task> {
    const record = await this.require(id),
      task = structuredClone(record.task);
    if (!STATES.includes(to)) fail("Invalid transition state");
    if (to === "in_flight") {
      if (isHoldActive({ ...task, state: to }, { today: this.now() }))
        fail("Cannot start an actively held Beads task");
      for (const dep of task.deps.filter((d) => d.type === "blocked-by")) {
        const blocker = await this.get(dep.id);
        if (blocker && blocker.state !== "done")
          fail(`Cannot start task while blocked by "${dep.id}"`);
      }
    }
    if (opts.pr !== undefined) appendLink(task, { kind: "pr", url: opts.pr });
    if (opts.report !== undefined)
      appendLink(task, { kind: "report", url: opts.report });
    if (opts.note && !task.body?.split("\n").includes(opts.note))
      task.body = task.body ? `${task.body}\n${opts.note}` : opts.note;
    const date = opts.date ?? this.now();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      fail("Transition date must be YYYY-MM-DD");
    task.state = to;
    if (to === "done") task.closed = record.task.closed ?? date;
    else {
      delete task.closed;
      if (to === "in_flight" && !task.created) task.created = date;
    }
    normalize(task);
    if (same(task, record.task) && !record.namespace.archived)
      return record.task;
    task.updated = this.now();
    const entry = {
      ...this.entry(
        task,
        record,
        "transition",
        to === "done" && record.namespace.archived,
      ),
      dispatch: to === "in_flight",
      local_date: this.now(),
    };
    if (record.task.state !== to)
      entry.namespace.order = to === "queued" ? Date.now() : -Date.now();
    await this.apply([entry]);
    return task;
  }
  async updatePublicFollowup(
    _id: string,
    _mutation: PublicFollowupMutation,
  ): Promise<Task> {
    void _id;
    void _mutation;
    throw unsupported("public followups", "beads");
  }
  async prune(options: PruneOptions): Promise<PruneResult> {
    if (options.state !== "done")
      throw unsupported("archiving active work", "beads");
    if (!Number.isSafeInteger(options.keep) || options.keep < 0)
      fail("Prune keep must be a nonnegative integer");
    const surplus = (await this.records())
      .filter((r) => r.task.state === "done" && !r.namespace.archived)
      .sort(
        (a, b) =>
          a.namespace.order - b.namespace.order ||
          a.task.id.localeCompare(b.task.id),
      )
      .slice(options.keep);
    if (!surplus.length) return { archived: 0, ids: [] };
    await this.apply(
      surplus.map((record) => this.entry(record.task, record, "archive", true)),
    );
    return { archived: surplus.length, ids: surplus.map((r) => r.task.id) };
  }
}
