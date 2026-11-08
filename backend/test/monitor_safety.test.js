import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WinController } from '../src/control/winController.js';
import { SimController } from '../src/control/simController.js';
import { Agent } from '../src/agent.js';
import { createApp } from '../src/server.js';
import { DEFAULTS, parseBoolEnv, parseAppEnv } from '../src/config.js';
import { MemoryRepo } from '../src/db/memoryRepo.js';

function createMockWinEnv({ failoverEnabled = false, probeRoutePinning = false, isAdmin = true } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netswitch-safety-test-'));
  const stateFile = path.join(tmpDir, 'netswitch-state.json');
  const commandLog = [];
  const routes = new Map();

  const mockRunPs = async (cmd) => {
    commandLog.push(cmd);
    if (cmd.includes('IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)')) {
      return isAdmin ? 'True' : 'False';
    }
    if (cmd.includes('Get-NetIPInterface')) {
      return JSON.stringify({ InterfaceIndex: 12, InterfaceMetric: 75, AutomaticMetric: 'Disabled' });
    }
    if (cmd.includes('Get-NetAdapter')) {
      return JSON.stringify({ InterfaceIndex: 12, MacAddress: '02-00-00-00-00-01', InterfaceGuid: '{00000000-0000-4000-8000-000000000001}', PnPDeviceID: 'MOCK_WIFI' });
    }
    if (cmd.includes('Find-NetRoute')) {
      return '12';
    }
    // New-NetRoute
    const newRouteMatch = /New-NetRoute -DestinationPrefix "([^"]+)" -InterfaceIndex (\d+) -NextHop "([^"]+)"/.exec(cmd);
    if (newRouteMatch) {
      const prefix = newRouteMatch[1];
      const index = Number(newRouteMatch[2]);
      const nextHop = newRouteMatch[3];
      const list = routes.get(prefix) || [];
      list.push({ DestinationPrefix: prefix, InterfaceIndex: index, NextHop: nextHop, PolicyStore: 'ActiveStore' });
      routes.set(prefix, list);
      return '';
    }
    // Remove-NetRoute
    const removeMatch = /Remove-NetRoute -DestinationPrefix "([^"]+)"(?: -InterfaceIndex (\d+))?/.exec(cmd);
    if (removeMatch) {
      const prefix = removeMatch[1];
      const index = removeMatch[2] ? Number(removeMatch[2]) : null;
      if (routes.has(prefix)) {
        if (index !== null) {
          const rem = routes.get(prefix).filter((r) => r.InterfaceIndex !== index);
          if (rem.length === 0) routes.delete(prefix);
          else routes.set(prefix, rem);
        } else {
          routes.delete(prefix);
        }
      }
      return '';
    }
    // Get-NetRoute
    const getRouteMatch = /Get-NetRoute -DestinationPrefix "([^"]+)"(?: -InterfaceIndex (\d+))?/.exec(cmd);
    if (getRouteMatch) {
      const prefix = getRouteMatch[1];
      const ifIndex = getRouteMatch[2] ? Number(getRouteMatch[2]) : null;
      let matched = routes.get(prefix) || [];
      if (ifIndex !== null) {
        matched = matched.filter((r) => r.InterfaceIndex === ifIndex);
      }
      if (matched.length === 0) return '';
      return JSON.stringify(matched);
    }
    return '';
  };

  const ctl = new WinController({
    stateFile,
    cfg: { ...DEFAULTS, failoverEnabled, probeRoutePinning },
    failoverEnabled,
    probeRoutePinning,
    runPs: mockRunPs,
    connectUnbound: async () => ({ ok: true, localAddress: '192.168.1.100' }),
    log: () => {},
  });
  ctl.canControl = isAdmin;

  const adapters = [
    { id: 'usb', kind: 'usb', alias: 'Ethernet 2', index: 17, description: 'Remote NDIS', ip: '192.168.2.100', gateway: '192.168.2.1', currentMetric: 5, metric: 5, up: true, eligible: true },
    { id: 'wifi', kind: 'wifi', alias: 'Wi-Fi', index: 12, description: 'Intel Wi-Fi 6', ip: '192.168.1.100', gateway: '192.168.1.1', currentMetric: 75, metric: 75, up: true, eligible: true },
  ];
  ctl.discover = async () => adapters;

  return { ctl, tmpDir, stateFile, commandLog, adapters };
}

test('Safety 1: Failover disabled blocks automatic switching in Agent', async () => {
  const { ctl, adapters } = createMockWinEnv({ failoverEnabled: false, isAdmin: true });
  const repo = new MemoryRepo();
  const agent = new Agent({
    controller: ctl,
    repo,
    cfg: { ...DEFAULTS, failoverEnabled: false },
    log: () => {},
  });

  await agent.start();
  assert.equal(agent.phase, 'MONITOR_ONLY');
  assert.equal(agent.failoverEnabled, false);
  assert.equal(agent.switching, false);
  assert.equal(agent.recent.length, 0);

  // Even if an adapter degrades severely, switching cannot be invoked
  const initialActive = agent.state.activeId;
  assert.ok(initialActive);

  // Direct manual switch must also be rejected
  const res = await agent.switchTo('wifi');
  assert.equal(res.ok, false);
  assert.match(res.note, /failover disabled/i);
  assert.equal(agent.state.activeId, initialActive);

  await agent.stop();
});

test('Safety 2: Failover disabled blocks manual API switching (HTTP 422)', async () => {
  const env = {
    NETSWITCH_MODE: 'sim',
    NETSWITCH_DB: 'memory',
    NETSWITCH_FAILOVER_ENABLED: 'false',
  };
  const ctx = await createApp({ env, log: () => {} });
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${ctx.server.address().port}`;

  const reg = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@safety.test', name: 'Admin', password: 'password123' }),
  });
  const { token } = await reg.json();

  // POST /api/control/switch must return 422
  const sw = await fetch(`${base}/api/control/switch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ to: 'wifi' }),
  });
  assert.equal(sw.status, 422);
  const body = await sw.json();
  assert.match(body.error || body.note, /failover disabled.*monitor-only/i);

  // Verify agent state is unchanged
  assert.equal(ctx.agent.state.activeId, 'usb');
  await ctx.close();
});

test('Safety 3: Direct controller switching is rejected at controller boundary', async () => {
  // WinController boundary
  const { ctl, adapters } = createMockWinEnv({ failoverEnabled: false, isAdmin: true });
  const winRes = await ctl.setActive(adapters, 'wifi');
  assert.equal(winRes.ok, false);
  assert.match(winRes.note, /failover disabled by configuration/i);

  // SimController boundary
  const simCtl = new SimController({ failoverEnabled: false });
  const simRes = await simCtl.setActive(adapters, 'wifi');
  assert.equal(simRes.ok, false);
  assert.match(simRes.note, /failover disabled by configuration/i);
});

test('Safety 4: Zero Set-NetIPInterface commands execute in monitor-only mode', async () => {
  const { ctl, adapters, commandLog } = createMockWinEnv({ failoverEnabled: false, isAdmin: true });

  // Attempt active switch
  await ctl.setActive(adapters, 'wifi');
  await ctl.setActive(adapters, 'usb');

  // Verify command log contains NO Set-NetIPInterface
  const setMetricCommands = commandLog.filter((c) => c.includes('Set-NetIPInterface'));
  assert.equal(setMetricCommands.length, 0, 'No Set-NetIPInterface command should ever execute');
});

test('Safety 5: Probe route pinning disabled creates zero routes', async () => {
  const { ctl, commandLog } = createMockWinEnv({ probeRoutePinning: false, isAdmin: true });
  const wifiAdapter = { id: 'wifi', kind: 'wifi', alias: 'Wi-Fi', index: 12, gateway: '192.168.1.1' };

  // Controller rejects pinning
  await assert.rejects(
    () => ctl.pin(wifiAdapter, ['1.1.1.1', '1.0.0.1']),
    /probe route pinning disabled by configuration/i
  );

  // Verify command log contains NO New-NetRoute
  const newRouteCommands = commandLog.filter((c) => c.includes('New-NetRoute'));
  assert.equal(newRouteCommands.length, 0, 'No New-NetRoute command should execute when pinning is disabled');

  // Verify Agent start marks pathVerified = false and sets pinNote
  const repo = new MemoryRepo();
  const agent = new Agent({
    controller: ctl,
    repo,
    cfg: { ...DEFAULTS, probeRoutePinning: false, failoverEnabled: false },
    log: () => {},
  });
  await agent.start();

  const registered = agent.adapters.get('wifi');
  assert.equal(registered.pathVerified, false);
  assert.match(registered.pinNote, /unpinned: probe route pinning disabled/i);
  await agent.stop();
});

test('Safety 6: Probe route pinning enabled allows only approved temporary probe routes', async () => {
  const { ctl, commandLog, stateFile } = createMockWinEnv({ probeRoutePinning: true, isAdmin: true });
  const wifiAdapter = { id: 'wifi', kind: 'wifi', alias: 'Wi-Fi', index: 12, gateway: '192.168.1.1' };

  await ctl.pin(wifiAdapter, ['1.1.1.1', '1.0.0.1']);

  // Pinned routes logged
  const newRouteCommands = commandLog.filter((c) => c.includes('New-NetRoute'));
  assert.equal(newRouteCommands.length, 2);
  assert.ok(newRouteCommands.some((c) => c.includes('1.1.1.1/32') && c.includes('-InterfaceIndex 12')));
  assert.ok(newRouteCommands.some((c) => c.includes('1.0.0.1/32') && c.includes('-InterfaceIndex 12')));

  // State file records exact pinned targets
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.pinned.length, 2);
  assert.equal(state.pinned[0].ip, '1.1.1.1');
  assert.equal(state.pinned[1].ip, '1.0.0.1');

  // Attempting to pin an invalid/virtual adapter is rejected
  const vmnetAdapter = { id: 'vmnet1', kind: 'wifi', alias: 'VMnet1', index: 21, gateway: '192.168.40.1' };
  await assert.rejects(() => ctl.pin(vmnetAdapter, ['1.1.1.1']), /VMware/i);
});

test('Safety 7: Route cleanup works on success and unpinning', async () => {
  const { ctl, commandLog, stateFile } = createMockWinEnv({ probeRoutePinning: true, isAdmin: true });
  const wifiAdapter = { id: 'wifi', kind: 'wifi', alias: 'Wi-Fi', index: 12, gateway: '192.168.1.1' };

  await ctl.pin(wifiAdapter, ['1.1.1.1', '1.0.0.1']);
  await ctl.unpin(['1.1.1.1', '1.0.0.1']);

  const removeCommands = commandLog.filter((c) => c.includes('Remove-NetRoute'));
  assert.ok(removeCommands.length >= 2);

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.pinned.length, 0);
});

test('Safety 8: Elevated privileges alone NEVER enable failover or route pinning', async () => {
  // Process is Administrator, but flags are false
  const { ctl } = createMockWinEnv({ failoverEnabled: false, probeRoutePinning: false, isAdmin: true });
  assert.equal(ctl.canControl, true, 'Process is Administrator');
  assert.equal(ctl.failoverEnabled, false, 'Failover must remain disabled');
  assert.equal(ctl.probeRoutePinning, false, 'Route pinning must remain disabled');

  const repo = new MemoryRepo();
  const agent = new Agent({
    controller: ctl,
    repo,
    cfg: { ...DEFAULTS, failoverEnabled: false, probeRoutePinning: false },
    log: () => {},
  });
  await agent.start();

  assert.equal(agent.canControl, true);
  assert.equal(agent.failoverEnabled, false);
  assert.equal(agent.probeRoutePinning, false);
  assert.equal(agent.phase, 'MONITOR_ONLY');

  // Direct switch calls rejected
  const sw = await agent.switchTo('wifi');
  assert.equal(sw.ok, false);
  assert.match(sw.note, /failover disabled/i);

  await agent.stop();
});

test('Safety 9: Non-admin monitoring still works where supported', async () => {
  const { ctl, adapters } = createMockWinEnv({ failoverEnabled: false, isAdmin: false });
  assert.equal(ctl.canControl, false, 'Process is standard user');

  const repo = new MemoryRepo();
  const agent = new Agent({
    controller: ctl,
    repo,
    cfg: { ...DEFAULTS, failoverEnabled: false },
    log: () => {},
  });

  await agent.start();
  assert.equal(agent.phase, 'MONITOR_ONLY');
  assert.equal(agent.canControl, false);
  assert.equal(agent.failoverEnabled, false);
  assert.ok(agent.lastSnapshot);
  assert.equal(agent.lastSnapshot.phase, 'MONITOR_ONLY');

  await agent.stop();
});

test('Safety 10: Environment parsing safety and defaults', () => {
  // parseBoolEnv edge cases
  assert.equal(parseBoolEnv(undefined, false), false);
  assert.equal(parseBoolEnv(null, false), false);
  assert.equal(parseBoolEnv('', false), false);
  assert.equal(parseBoolEnv('false', true), false);
  assert.equal(parseBoolEnv('0', true), false);
  assert.equal(parseBoolEnv('no', true), false);
  assert.equal(parseBoolEnv('random-string', true), false);
  assert.equal(parseBoolEnv('true', false), true);
  assert.equal(parseBoolEnv('1', false), true);
  assert.equal(parseBoolEnv('yes', false), true);
  assert.equal(parseBoolEnv('TRUE', false), true);

  // parseAppEnv defaults
  const emptyAppEnv = parseAppEnv({});
  assert.equal(emptyAppEnv.failoverEnabled, false);
  assert.equal(emptyAppEnv.autoFailoverEnabled, false);
  assert.equal(emptyAppEnv.probeRoutePinning, false);

  const explicitAppEnv = parseAppEnv({
    NETSWITCH_FAILOVER_ENABLED: 'true',
    NETSWITCH_AUTO_FAILOVER_ENABLED: 'false',
    NETSWITCH_PROBE_ROUTE_PINNING: 'true',
  });
  assert.equal(explicitAppEnv.failoverEnabled, true);
  assert.equal(explicitAppEnv.autoFailoverEnabled, false);
  assert.equal(explicitAppEnv.probeRoutePinning, true);

  const autoAppEnv = parseAppEnv({
    NETSWITCH_AUTO_FAILOVER_ENABLED: 'true',
  });
  assert.equal(autoAppEnv.autoFailoverEnabled, true);
  assert.equal(autoAppEnv.failoverEnabled, false);
});

test('Safety 11: Manual switching allowed with failoverEnabled=true, while auto failover remains blocked', async () => {
  const { ctl, adapters } = createMockWinEnv({ failoverEnabled: true, probeRoutePinning: false, isAdmin: true });
  const repo = new MemoryRepo();
  const agent = new Agent({
    controller: ctl,
    repo,
    cfg: { ...DEFAULTS, failoverEnabled: true, autoFailoverEnabled: false, probeRoutePinning: false },
    log: () => {},
  });

  await agent.start();
  assert.equal(agent.failoverEnabled, true);
  assert.equal(agent.autoFailoverEnabled, false);
  assert.equal(agent.probeRoutePinning, false);
  assert.equal(agent.phase, 'MANUAL_ONLY');
  assert.equal(agent.lastSnapshot.phase, 'MANUAL_ONLY');
  assert.equal(agent.lastSnapshot.autoFailoverEnabled, false);
  assert.equal(agent.lastSnapshot.failoverEnabled, true);

  // Manual switch is permitted and executes controller.setActive
  const sw = await agent.switchTo('wifi');
  assert.equal(sw.ok, true);
  assert.equal(agent.state.activeId, 'wifi');
  assert.equal(agent.recent.length, 1);
  assert.equal(agent.recent[0].reason, 'manual');

  await agent.stop();
});

test('Safety 12: Automatic decide() is NEVER executed when autoFailoverEnabled is false', async () => {
  const { ctl } = createMockWinEnv({ failoverEnabled: true, probeRoutePinning: false, isAdmin: true });
  const repo = new MemoryRepo();
  class ImpairedDriver {
    constructor(adapter) {
      this.adapter = adapter;
    }
    start() {}
    stop() {}
    read() {
      // Simulate 100% loss and 25 consecutive lost probes on active adapter
      return {
        udp: Array.from({ length: 25 }, (_, i) => ({ t: Date.now() - (25 - i) * 200, ok: false, rtt: null })),
        icmp: [],
        tcp: { ok: false, ms: null, at: Date.now() },
      };
    }
  }

  const agent = new Agent({
    controller: ctl,
    repo,
    cfg: { ...DEFAULTS, failoverEnabled: true, autoFailoverEnabled: false, probeRoutePinning: false },
    ProbeDriver: ImpairedDriver,
    log: () => {},
  });

  await agent.start();
  assert.equal(agent.state.activeId, 'usb');
  assert.equal(agent.phase, 'MANUAL_ONLY');

  // Wait for several evaluation intervals (each interval is 1s by default)
  await new Promise((r) => setTimeout(r, 1200));

  // Verify that NO automatic switch occurred despite complete active link failure
  assert.equal(agent.state.activeId, 'usb', 'Active adapter must not change automatically');
  assert.equal(agent.recent.length, 0, 'No automatic failover events recorded');
  assert.equal(agent.phase, 'MANUAL_ONLY');

  await agent.stop();
});

test('Safety 13: Coupling safety - autoFailoverEnabled forced to false if failoverEnabled is false', async () => {
  const { ctl } = createMockWinEnv({ failoverEnabled: false, probeRoutePinning: false, isAdmin: true });
  const repo = new MemoryRepo();
  const agent = new Agent({
    controller: ctl,
    repo,
    cfg: { ...DEFAULTS, failoverEnabled: false, autoFailoverEnabled: true },
    log: () => {},
  });

  await agent.start();
  assert.equal(agent.failoverEnabled, false);
  assert.equal(agent.autoFailoverEnabled, false, 'autoFailoverEnabled must be forced to false when failoverEnabled is false');
  assert.equal(agent.phase, 'MONITOR_ONLY');

  // Manual switch is also blocked
  const sw = await agent.switchTo('wifi');
  assert.equal(sw.ok, false);
  assert.match(sw.note, /failover disabled/i);

  await agent.stop();
});

test('Safety 14: REST API manual-only mode (/api/health and /api/control/switch)', async () => {
  const env = {
    NETSWITCH_MODE: 'sim',
    NETSWITCH_DB: 'memory',
    NETSWITCH_FAILOVER_ENABLED: 'true',
    NETSWITCH_AUTO_FAILOVER_ENABLED: 'false',
    NETSWITCH_PROBE_ROUTE_PINNING: 'false',
  };
  const ctx = await createApp({ env, log: () => {} });
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${ctx.server.address().port}`;

  // Health endpoint verification
  const hRes = await fetch(`${base}/api/health`);
  const health = await hRes.json();
  assert.equal(health.failoverEnabled, true);
  assert.equal(health.autoFailoverEnabled, false);
  assert.equal(health.probeRoutePinning, false);

  // Authenticate admin
  const reg = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@stage5b.test', name: 'Admin', password: 'password123' }),
  });
  const { token } = await reg.json();

  // Manual switch succeeds (HTTP 200)
  const swRes = await fetch(`${base}/api/control/switch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: 'wifi' }),
  });
  assert.equal(swRes.status, 200);
  const swBody = await swRes.json();
  assert.equal(swBody.ok, true);
  assert.equal(ctx.agent.state.activeId, 'wifi');

  await ctx.close();
});

test('Safety 15: Runtime immutability - PUT /api/config cannot change safety flags', async () => {
  const env = {
    NETSWITCH_MODE: 'sim',
    NETSWITCH_DB: 'memory',
    NETSWITCH_FAILOVER_ENABLED: 'true',
    NETSWITCH_AUTO_FAILOVER_ENABLED: 'false',
    NETSWITCH_PROBE_ROUTE_PINNING: 'false',
  };
  const ctx = await createApp({ env, log: () => {} });
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${ctx.server.address().port}`;

  const reg = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@config-safety.test', name: 'Admin', password: 'password123' }),
  });
  const { token } = await reg.json();

  // Attempt to inject safety flags into PUT /api/config
  await fetch(`${base}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      autoFailoverEnabled: true,
      failoverEnabled: false,
      probeRoutePinning: true,
      decide: { holdDownMs: 15000 },
    }),
  });

  // Verify safety flags remain unchanged
  assert.equal(ctx.agent.autoFailoverEnabled, false);
  assert.equal(ctx.agent.failoverEnabled, true);
  assert.equal(ctx.agent.probeRoutePinning, false);

  await ctx.close();
});
