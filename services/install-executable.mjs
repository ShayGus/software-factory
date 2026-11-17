// Replace the directory entry, never the inode a running process may execute.
import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export function installExecutable(source, destination) {
  const bytes = readFileSync(source);
  let current;
  try { current = readFileSync(destination); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current?.equals(bytes)) {
    chmodSync(destination, 0o755);
    return;
  }
  const temp = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
    chmodSync(temp, 0o755);
    renameSync(temp, destination);
  } finally { rmSync(temp, { force: true }); }
}
