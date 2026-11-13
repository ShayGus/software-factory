import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Compile the read-only backend's main into a NEW external scratch directory.
 * No npm install, network, source edits, or reliance on the older global backend.
 */
export function prepareTasksAxi(destination, source = '/home/shayg/fm-homes/linux-mate/projects/tasks-axi') {
  const root = resolve(destination);
  const repository = fileURLToPath(new URL('../', import.meta.url));
  if (root === repository.slice(0, -1) || root.startsWith(repository)) throw new Error('external_scratch_required');
  mkdirSync(root); // Deliberately refuse reusing an existing output tree.
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
  const revision = git('rev-parse', 'main');
  const files = git('ls-tree', '-r', '--name-only', revision).split('\n')
    .filter((file) => /^(src|bin)\/.*\.ts$/.test(file));
  for (const file of files) {
    const input = execFileSync('git', ['-C', source, 'show', `${revision}:${file}`], { encoding: 'utf8' });
    const output = ts.transpileModule(input, { fileName: file,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
    const target = join(root, file.replace(/\.ts$/, '.js'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, output);
  }
  // Reuse only the already-installed runtime dependencies. Never run that CLI's
  // older backend and never modify its install or the source repository.
  const installed = realpathSync(execFileSync('which', ['tasks-axi'], { encoding: 'utf8' }).trim());
  const modules = resolve(dirname(installed), '../../node_modules');
  for (const dependency of ['axi-sdk-js', '@toon-format/toon']) readFileSync(join(modules, dependency, 'package.json'));
  symlinkSync(modules, join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'package.json'), execFileSync('git', ['-C', source, 'show', `${revision}:package.json`], { encoding: 'utf8' }));
  writeFileSync(join(root, 'source.json'), JSON.stringify({ source, revision }, null, 2));
  return { executable: join(root, 'bin/tasks-axi.js'), revision };
}
