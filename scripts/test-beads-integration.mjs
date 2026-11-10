#!/usr/bin/env node
// Only disposable, explicitly named containers and fresh mkdtemp databases.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "tasks-axi-beads-test-"));
const suffix = `${process.pid}-${Date.now()}`;
const server = `tasks-axi-test-sql-${suffix}`, client = `tasks-axi-test-bd-${suffix}`;
const extract = `tasks-axi-test-extract-${suffix}`;
const socket = join(root,"server/server.sock");
const image = "local/scotty:v0.4.0-cf6dda1";
const dolt = "dolthub/dolt@sha256:1abcdd77083cc7dedce01f91d1314b48e55e5bdd512c575f086b929494c77a31";
function run(command,args,options={}) {
  const result = spawnSync(command,args,{cwd:repo,encoding:"utf8",timeout:30000,...options});
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0]}: ${result.error ?? result.stderr ?? result.stdout}`);
  return result.stdout.trim();
}
let exit = 1;
try {
  run("docker",["image","inspect",image]); run("docker",["image","inspect",dolt]);
  mkdirSync(join(root,"server"));
  run("docker",["run","--rm","-d","--name",server,"--network","none","-v",`${root}:${root}`,"-w",join(root,"server"),dolt,
    "sql-server","--host","127.0.0.1","--port","3306","--socket",socket]);
  const deadline = Date.now()+10000;
  while (!existsSync(socket) && Date.now()<deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
  if (!existsSync(socket)) throw new Error("Scratch SQL server did not create its socket");
  run("docker",["exec",server,"chmod","777",socket]);
  run("docker",["create","--name",extract,"--entrypoint","bd",image,"version"]);
  run("docker",["cp",`${extract}:/usr/local/bin/bd`,join(root,"bd")]);
  const database = `tasks_axi_test_${Date.now()}`;
  for (const name of ["a","b"]) {
    const workspace = join(root,name); mkdirSync(workspace); run("git",["-C",workspace,"init","-q"]);
    run(join(root,"bd"),["init","--server","--external","--server-socket",socket,"--database",database,
      "--prefix","fm","--skip-agents","--skip-hooks","--non-interactive"],{cwd:workspace,
      env:{...process.env,BEADS_DIR:join(workspace,".beads")}});
    writeFileSync(join(workspace,".beads/.tasks-axi-scratch"),database);
  }
  run("docker",["run","--rm","-d","--name",client,"--network","none","-v",`${root}:${root}`,"--entrypoint","sleep",image,"infinity"]);
  const allowlist = join(root,"allowlist.json");
  const path = join(root,"b/.beads");
  writeFileSync(allowlist,JSON.stringify([{path,containerPath:path,container:client,user:String(process.getuid()),socket,containerSocket:socket}]));
  const config={path:join(root,"a/.beads"),binary:join(root,"bd"),database,prefix:"fm",server_user:"root",server_socket:socket,timeout_ms:10000};
  const second={...config,path,binary:join(repo,"scripts/beads-docker-exec.mjs")};
  console.log(`Scratch Beads fixture: ${root} (${database})`);
  const test=spawnSync(process.env.PNPM_BIN ?? "pnpm",["exec","vitest","run","test/backends/beads.integration.test.ts"],{
    cwd:repo,stdio:"inherit",timeout:180000,env:{...process.env,TASKS_AXI_BEADS_TEST_CONFIG:JSON.stringify(config),
      TASKS_AXI_BEADS_SECOND_CONFIG:JSON.stringify(second),TASKS_AXI_BEADS_DOCKER_ALLOWLIST:allowlist,
      TASKS_AXI_BEADS_TEST_SERVER:server}});
  exit=test.status ?? 1;
} catch(error) { console.error(error.message); }
finally {
  // Copy logs before stopping only these task-owned containers.
  if (process.env.TASKS_AXI_BEADS_PROOF_DIR) {
    try { const proof=process.env.TASKS_AXI_BEADS_PROOF_DIR; mkdirSync(proof,{recursive:true});
      writeFileSync(join(proof,`server-${suffix}.log`),run("docker",["logs",server])); } catch { /* best effort */ }
  }
  for (const name of [client,extract]) spawnSync("docker",["rm","-f",name],{stdio:"ignore",timeout:10000});
  spawnSync("docker",["exec",server,"chown","-R",`${process.getuid()}:${process.getgid()}`,root],{stdio:"ignore",timeout:10000});
  spawnSync("docker",["rm","-f",server],{stdio:"ignore",timeout:10000});
  try { rmSync(root,{recursive:true,force:true}); } catch { console.error(`Scratch files retained: ${root}`); }
}
process.exitCode=exit;
