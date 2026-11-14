import assert from 'node:assert/strict';
import test from 'node:test';

test('optional tailnet setup persists both HTTPS routes and is idempotent without touching other ports', async () => {
  const { configureTailnet, verifyTailnet } = await import(new URL('../../scripts/tailnet.mjs', import.meta.url).href);
  const services = { uiPort: 45123, scottyPort: 45124, uiOrigin: 'http://127.0.0.1:45123', scottyOrigin: 'http://127.0.0.1:45124' };
  const host = 'factory.example.ts.net';
  const unrelated = { Handlers: { '/': { Proxy: 'http://127.0.0.1:7374' } } };
  const config = { TCP: { '7374': { HTTPS: true } } as Record<string, unknown>, Web: { [`${host}:7374`]: unrelated } as Record<string, unknown> };
  const mutations: string[][] = [];
  const execute = (args: string[]) => {
    if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { DNSName: host + '.' }, CertDomains: [host] });
    if (args[1] === 'status') return JSON.stringify(config);
    mutations.push(args);
    assert.deepEqual(args.slice(0, 4), ['serve', '--bg', '--yes', '--https']);
    config.TCP[args[4]!] = { HTTPS: true };
    config.Web[`${host}:${args[4]}`] = { Handlers: { '/': { Proxy: args[5] } } };
    return '';
  };
  const tailnet = configureTailnet(services, execute);
  assert.equal(tailnet.enabled, true);
  assert.equal(tailnet.uiOrigin, `https://${host}:45123`);
  assert.equal(tailnet.scottyOrigin, `https://${host}:45124`);
  assert.equal(mutations.length, 2);
  assert.deepEqual(config.Web[`${host}:7374`], unrelated);
  assert.deepEqual(configureTailnet(services, execute), tailnet);
  verifyTailnet({ ...services, tailnet }, execute);
  assert.equal(mutations.length, 2);
  delete config.TCP['45123']; delete config.Web[`${host}:45123`];
  assert.throws(() => verifyTailnet({ ...services, tailnet }, execute), /Missing ui/);
  configureTailnet(services, execute);
  assert.equal(mutations.length, 3, 'Rerun restores only the missing mapping');
});

test('tailnet discovery skips unavailable dependencies and refuses foreign or public routes before mutation', async () => {
  const { configureTailnet } = await import(new URL('../../scripts/tailnet.mjs', import.meta.url).href);
  const services = { uiPort: 45123, scottyPort: 45124, uiOrigin: 'http://127.0.0.1:45123', scottyOrigin: 'http://127.0.0.1:45124' };
  for (const reason of ['spawnSync tailscale ENOENT', 'Tailscale is not running']) {
    assert.deepEqual(configureTailnet(services, () => { throw new Error(reason); }), { enabled: false, reason });
  }
  const host = 'factory.example.ts.net';
  for (const config of [
    { TCP: { '45124': { TCPForward: '127.0.0.1:22' } } },
    { AllowFunnel: { [`${host}:45123`]: true } },
    { TCP: { '45124': { HTTPS: true } }, Web: { [`${host}:45124`]: { Handlers: { '/other': { Proxy: services.scottyOrigin } } } } },
  ]) {
    let mutations = 0;
    const execute = (args: string[]) => {
      if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { DNSName: host }, CertDomains: [host] });
      if (args[1] === 'status') return JSON.stringify(config);
      mutations++; return '';
    };
    assert.throws(() => configureTailnet(services, execute), /refusing|leaving it unchanged/);
    assert.equal(mutations, 0);
  }
  const unavailable = configureTailnet(services, () => JSON.stringify({ BackendState: 'Running', Self: { DNSName: host }, CertDomains: [] }));
  assert.equal(unavailable.enabled, false);
  assert.match(unavailable.reason, /Enable HTTPS/);
});
