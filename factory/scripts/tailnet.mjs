// Optional, persistent tailnet HTTPS. Never reset shared Serve config or enable Funnel.
import { run } from './home-acceptance.mjs';

const cli = args => run('tailscale', args, { timeout: 20000 });
const status = execute => JSON.parse(execute(['serve', 'status', '--json']));
const authority = origin => new URL(origin).host;

function inspect(config, origin, target) {
  const url = new URL(origin);
  const port = url.port || '443';
  if (Object.entries(config.AllowFunnel ?? {}).some(([key, enabled]) => enabled && key.endsWith(`:${port}`))) {
    throw new Error(`Tailnet port ${port} has public Funnel enabled; refusing it`);
  }
  const tcp = config.TCP?.[port];
  const entries = Object.entries(config.Web ?? {}).filter(([key]) => key.endsWith(`:${port}`));
  if (!tcp && !entries.length) return false;
  if (JSON.stringify(tcp) !== JSON.stringify({ HTTPS: true }) || entries.length !== 1 ||
    entries[0][0] !== authority(origin) || Object.keys(entries[0][1].Handlers ?? {}).length !== 1 ||
    JSON.stringify(entries[0][1].Handlers['/']) !== JSON.stringify({ Proxy: target })) {
    throw new Error(`Tailnet port ${port} belongs to a different Serve configuration; leaving it unchanged`);
  }
  return true;
}

export function verifyTailnet(services, execute = cli) {
  if (!services.tailnet?.enabled) return;
  const config = status(execute);
  for (const kind of ['ui', 'scotty']) {
    if (!inspect(config, services.tailnet[`${kind}Origin`], services[`${kind}Origin`])) throw new Error(`Missing ${kind} tailnet Serve entry; rerun setup to restore it`);
  }
}

export function configureTailnet(services, execute = cli) {
  let node, config;
  try {
    node = JSON.parse(execute(['status', '--json']));
    if (node.BackendState !== 'Running') throw new Error(`Tailscale is ${node.BackendState ?? 'not running'}`);
    const dnsName = node.Self?.DNSName?.replace(/\.$/, '');
    if (!dnsName || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/i.test(dnsName)) throw new Error('Tailscale HTTPS DNS name is unavailable');
    if (!node.CertDomains?.includes(dnsName)) throw new Error('Enable HTTPS certificates in the Tailscale admin console first');
    config = status(execute);
    node = { enabled: true, dnsName, uiOrigin: new URL(`https://${dnsName}:${services.uiPort}`).origin, scottyOrigin: new URL(`https://${dnsName}:${services.scottyPort}`).origin };
  } catch (error) {
    return { enabled: false, reason: error.message };
  }
  if (services.tailnet?.enabled && (services.tailnet.uiOrigin !== node.uiOrigin || services.tailnet.scottyOrigin !== node.scottyOrigin)) {
    throw new Error('Tailscale DNS name changed; use the one-step update to rebuild trusted origins');
  }
  // Inspect both ports before changing either; a collision never overwrites another app.
  const missing = ['ui', 'scotty'].filter(kind => !inspect(config, node[`${kind}Origin`], services[`${kind}Origin`]));
  for (const kind of missing) {
    // --bg persists in tailscaled across reboots; --yes avoids an unattended prompt.
    // A permission/HTTPS failure is actionable, rather than a claimed tailnet success.
    execute(['serve', '--bg', '--yes', '--https', String(services[`${kind}Port`]), services[`${kind}Origin`]]);
  }
  verifyTailnet({ ...services, tailnet: node }, execute);
  return node;
}
