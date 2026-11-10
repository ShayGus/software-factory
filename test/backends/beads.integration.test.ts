import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BeadsStore } from "../../src/backends/beads.js";
import { BeadsTransport } from "../../src/backends/beads-transport.js";
import { sqlString } from "../../src/backends/beads-sql.js";
import type { BeadsConfig } from "../../src/config.js";

const enabled = Boolean(process.env.TASKS_AXI_BEADS_TEST_CONFIG);
const config: BeadsConfig = enabled ? JSON.parse(process.env.TASKS_AXI_BEADS_TEST_CONFIG!) : {};
const second: BeadsConfig = enabled ? JSON.parse(process.env.TASKS_AXI_BEADS_SECOND_CONFIG!) : {};
if (enabled && (!config.path.startsWith("/tmp/tasks-axi-beads-test-") || !config.database.startsWith("tasks_axi_test_") ||
  readFileSync(`${config.path}/.tasks-axi-scratch`,"utf8") !== config.database)) throw new Error("Fresh scratch fixture required");
const id = (prefix: string) => `${prefix}-${randomUUID().slice(0,8)}`;
const make = () => new BeadsStore(config,()=>"2026-11-10");
const sql = (query: string) => new BeadsTransport(config).json(["sql",query]);

describe.skipIf(!enabled)("pinned bd 1.1.0 with a shared scratch Dolt server", () => {
  it("preserves IDs, full bodies, legacy dates, metadata and native edits through either client", async () => {
    const a=make(), b=new BeadsStore(second,()=>"2026-11-10"), logical=id("fm-prefixed");
    const task=await a.create({id:logical,title:"Title ' quoted \\ 雪",body:"a\n\n  ## Resolution\nanswer\n",created:null,
      kind:"captain",repo:"app",meta:{home:"scratch",nested:{keep:true}}});
    expect(task.created).toBeUndefined();
    expect(await b.get(logical)).toEqual(task);
    expect(await b.get(`fm-${logical}`)).toBeNull();
    await sql(`UPDATE issues SET metadata=JSON_SET(metadata,'$.foreign',JSON_OBJECT('keep',true)),title='Native edit' WHERE id=${sqlString(`fm-${logical}`)}`);
    const result=await b.update(logical,{body:"curated",archiveBody:true,meta:{next:1}});
    expect(result.changed).toContain("archive"); expect(result.task.title).toBe("Native edit");
    expect(result.task.meta).toEqual({home:"scratch",nested:{keep:true},next:1});
    expect((await a.update(logical,{body:"curated",meta:{next:1}})).changed).toEqual([]);
    const rows=await sql(`SELECT metadata FROM issues WHERE id=${sqlString(`fm-${logical}`)}`) as {metadata:string}[];
    expect(JSON.parse(rows[0].metadata).foreign).toEqual({keep:true});
    const history=await sql(`SELECT snapshot FROM tasks_axi_history_v1 WHERE physical_id=${sqlString(`fm-${logical}`)}`);
    expect(JSON.stringify(history)).toContain("Resolution");
    await b.remove(logical); expect(await a.get(logical)).toBeNull();
  },20000);

  it("keeps dependency direction/reasons, protects blockers and preserves unrelated relations", async () => {
    const s=make(), blocker=id("blocker"), dependent=id("dependent"), other=id("other");
    for (const logical of [blocker,other]) await s.create({id:logical,title:logical});
    await s.create({id:dependent,title:dependent,deps:[{type:"blocked-by",id:blocker,reason:"waits on login"}]});
    await expect(s.remove(blocker)).rejects.toThrow(/still blocking/);
    expect(await s.addDep(dependent,{type:"blocked-by",id:blocker})).toBe(false);
    expect((await s.get(dependent))?.deps).toEqual([{type:"blocked-by",id:blocker,reason:"waits on login"}]);
    await sql(`INSERT INTO dependencies(id,issue_id,depends_on_issue_id,type,created_by) VALUES (UUID(),${sqlString(`fm-${dependent}`)},${sqlString(`fm-${other}`)},'relates-to','test')`);
    expect(await s.removeDep(dependent,{type:"blocked-by",id:blocker})).toBe(true);
    expect(await s.removeDep(dependent,{type:"blocked-by",id:blocker})).toBe(false);
    const unrelated=await sql(`SELECT type FROM dependencies WHERE issue_id=${sqlString(`fm-${dependent}`)}`);
    expect(unrelated).toEqual([{type:"relates-to"}]);
    await s.remove(blocker);
    await expect(s.addDep(dependent,{type:"blocked-by",id:dependent})).rejects.toThrow(/self/);
    await expect(s.addDep(dependent,{type:"blocked-by",id:"absent"})).rejects.toThrow(/not found/);
  },20000);

  it("hydrates more than 50 rows without a native list cap and keeps stable filtering/order", async () => {
    const s=make(), repo=id("many");
    for (let n=0;n<61;n++) await s.create({id:`${repo}-${n}`,title:`row ${n}`,repo,priority:n%5});
    const all=await s.list({repo});
    expect(all.total).toBe(61);expect(all.items).toHaveLength(61);
    expect((await s.list({repo,limit:3})).items).toEqual(all.items.slice(0,3));
    expect((await s.list({repo})).items.map((t)=>t.id)).toEqual(all.items.map((t)=>t.id));
  },60000);

  it("rolls back a failed create after insertion and rejects a stale two-client write", async () => {
    const a=make(), b=new BeadsStore(second,()=>"2026-11-10"), logical=id("atomic");
    // Exercise the actual SQL transaction boundary, including failure after INSERT.
    const task={id:logical,title:"Atomic",state:"queued",deps:[],links:[]};
    const entry=Reflect.get(a,"entry").call(a,task);
    entry.edges=[{id:"fm-no-such-target",type:"blocks"}];
    await expect(Reflect.get(a,"apply").call(a,[entry])).rejects.toThrow(/refused|conflict/);
    expect(await a.get(logical)).toBeNull();
    await a.create(task as Parameters<BeadsStore["create"]>[0]);
    const oldA=await Reflect.get(a,"require").call(a,logical), oldB=await Reflect.get(b,"require").call(b,logical);
    const ea=Reflect.get(a,"entry").call(a,{...oldA.task,title:"writer a"},oldA);
    const eb=Reflect.get(b,"entry").call(b,{...oldB.task,title:"writer b"},oldB);
    const results=await Promise.allSettled([Reflect.get(a,"apply").call(a,[ea]),Reflect.get(b,"apply").call(b,[eb])]);
    expect(results.filter((r)=>r.status==="fulfilled")).toHaveLength(1);
    expect(results.filter((r)=>r.status==="rejected")).toHaveLength(1);
    expect(["writer a","writer b"]).toContain((await a.get(logical))?.title);
  },20000);
});
