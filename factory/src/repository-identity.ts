import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { PullRequestUrlSchema } from './review-contracts.js';

/** Compare native repository context with stored project repositories. Git common
 * directories identify worktree aliases; forge identity also identifies clones. */
export function repositoryIdentity(input: string): string {
  let remote = input.startsWith('git:') && !input.startsWith('git://') ? input.slice(4) : input;
  if (remote.startsWith('file:')) remote = new URL(remote).pathname;
  if (isAbsolute(remote)) {
    const directory = realpathSync(remote);
    const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try { remote = git('remote', 'get-url', 'origin'); }
    catch { return `local:${realpathSync(git('rev-parse', '--path-format=absolute', '--git-common-dir'))}`; }
  }
  if (!remote.includes('://')) remote = remote.replace(/^(?:[^@]+@)?([^:]+):(.+)$/u, 'ssh://$1/$2');
  const url = new URL(remote);
  if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol) || url.password || url.search || url.hash) throw new Error('factory_repository_identity_unavailable');
  const path = url.pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/iu, '');
  if (!path) throw new Error('factory_repository_identity_unavailable');
  return `${url.host.toLowerCase()}/${url.hostname === 'github.com' ? path.toLowerCase() : path}`;
}
export function pullRequestIdentity(input: string) {
  const url = new URL(PullRequestUrlSchema.parse(input));
  const path = /^(.*)\/(pull|pulls|-\/merge_requests)\/([1-9][0-9]*)$/u.exec(url.pathname)!;
  return { repository: repositoryIdentity(`${url.origin}${path[1]}`), route: path[2]!, number: path[3]! };
}

export function samePullRequest(left: string, right: string) {
  const a = pullRequestIdentity(left);
  const b = pullRequestIdentity(right);
  return a.repository === b.repository && a.route === b.route && a.number === b.number;
}
