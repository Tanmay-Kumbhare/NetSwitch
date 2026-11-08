import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { WinController } from '../src/control/winController.js';
import { Agent } from '../src/agent.js';
import { isVirtualOrExcluded, toAdapters } from '../src/windows/discovery.js';
import { runCheckWindows } from '../scripts/check-windows.js';
import { MemoryRepo } from '../src/db/memoryRepo.js';

function createMockEnvironment({ failoverEnabled = false, probeRoutePinning = false } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netswitch-harden-test-'));
  const stateFile = path.join(tmpDir, 'netswitch-state.json');

  const ifaces = new Map([
    [12, { index: 12, metric: 75, autoMetric: false, alias: 'Wi-Fi', mac: '02-00-00-00-00-01', guid: '{00000000-0000-4000-8000-000000000001}' }],
    [17, { index: 17, metric: 5, autoMetric: false, alias: 'Ethernet 2', mac: '02-00-00-00-00-02', guid: '{00000000-0000-4000-8000-000000000002}' }],
  ]);

  // Routing table simulation: destinationPrefix -> array of { DestinationPrefix, InterfaceIndex, NextHop, PolicyStore }
  const routes = new Map();

  const commandLog = [];
  const failureHooks = new Map();

  const mockRunPs = async (cmd) => {
    commandLog.push(cmd);

    for (const [pattern, err] of failureHooks.entries()) {
      if (typeof pattern === 'string' ? cmd.includes(pattern) : pattern.test(cmd)) {
        throw err;
      }
    }

    if (cmd.includes('IsInRole')) {
      return 'True';
    }

    // Set-NetIPInterface
    const setMatch = /Set-NetIPInterface -InterfaceIndex (\d+) -AddressFamily IPv4 (?:-AutomaticMetric Enabled|-AutomaticMetric Disabled -InterfaceMetric (\d+))/.exec(cmd);
    if (setMatch) {
      const idx = Number(setMatch[1]);
      const isAuto = cmd.includes('-AutomaticMetric Enabled');
      const metric = isAuto ? 0 : Number(setMatch[2]);
      if (ifaces.has(idx)) {
        ifaces.set(idx, { ...ifaces.get(idx), metric, autoMetric: isAuto });
      }
      return '';
    }

    // Get-NetIPInterface
    const getMatch = /Get-NetIPInterface -InterfaceIndex (\d+)/.exec(cmd);
    if (getMatch) {
      const idx = Number(getMatch[1]);
      const iface = ifaces.get(idx) || { index: idx, metric: 75, autoMetric: false };
      return JSON.stringify({
        InterfaceIndex: iface.index,
        InterfaceMetric: iface.metric,
        AutomaticMetric: iface.autoMetric ? 'Enabled' : 'Disabled',
      });
    }

    // Get-NetAdapter
    const adapterMatch = /Get-NetAdapter -InterfaceIndex (\d+)/.exec(cmd);
    if (adapterMatch) {
      const idx = Number(adapterMatch[1]);
      const iface = ifaces.get(idx);
      if (!iface) return '';
      return JSON.stringify({
        InterfaceIndex: iface.index,
        MacAddress: iface.mac,
        InterfaceGuid: iface.guid,
        PnPDeviceID: iface.pnpId || 'MOCK_DEVICE',
      });
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

    // Find-NetRoute
    if (cmd.includes('Find-NetRoute')) {
      const sorted = [...ifaces.values()].sort((a, b) => a.metric - b.metric);
      return String(sorted[0].index);
    }

    return '';
  };

  const mockConnectUnbound = async () => ({ ok: true, localAddress: '192.168.1.100' });

  const cleanup = () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  return { tmpDir, stateFile, ifaces, routes, commandLog, failureHooks, mockRunPs, mockConnectUnbound, cleanup };
}

// ============================================================================
// TASK 1: STARTUP RECOVERY GUARD TESTS (P0)
// ============================================================================

test('Task 1.1: Monitor-only startup with stale state does not execute PowerShell mutations', async () => {
  const env = createMockEnvironment({ failoverEnabled: false });
  const staleState = {
    originals: [{ index: 12, alias: 'Wi-Fi', metric: 75, autoMetric: false }],
    pinned: [{ prefix: '1.1.1.1/32', ip: '1.1.1.1', index: 12, gateway: '192.168.1.1' }],
  };
  fs.writeFileSync(env.stateFile, JSON.stringify(staleState, null, 2));

  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: false, probeRoutePinning: false },
    failoverEnabled: false,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });

  await ctl.init();

  const mutations = env.commandLog.filter((c) => c.includes('Set-NetIPInterface') || c.includes('Remove-NetRoute'));
  assert.equal(mutations.length, 0, 'Zero mutation commands must be executed in monitor-only startup');

  env.cleanup();
});

test('Task 1.2: State file remains preserved on disk during monitor-only startup', async () => {
  const env = createMockEnvironment({ failoverEnabled: false });
  const staleState = {
    originals: [{ index: 12, alias: 'Wi-Fi', metric: 75, autoMetric: false }],
    pinned: [{ prefix: '1.1.1.1/32', ip: '1.1.1.1', index: 12, gateway: '192.168.1.1' }],
  };
  fs.writeFileSync(env.stateFile, JSON.stringify(staleState, null, 2));

  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: false, probeRoutePinning: false },
    failoverEnabled: false,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });

  await ctl.init();

  assert.ok(fs.existsSync(env.stateFile), 'State file must be preserved on disk in monitor-only mode');
  const readBack = JSON.parse(fs.readFileSync(env.stateFile, 'utf8'));
  assert.equal(readBack.originals.length, 1);
  assert.equal(readBack.pinned.length, 1);

  env.cleanup();
});

test('Task 1.3: Monitor-only startup reports that recovery is pending', async () => {
  const env = createMockEnvironment({ failoverEnabled: false });
  const staleState = {
    originals: [{ index: 12, alias: 'Wi-Fi', metric: 75, autoMetric: false }],
    pinned: [],
  };
  fs.writeFileSync(env.stateFile, JSON.stringify(staleState, null, 2));

  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: false, probeRoutePinning: false },
    failoverEnabled: false,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });

  await ctl.init();
  assert.equal(ctl.recoveryPending, true, 'Controller must record recoveryPending = true');

  const rec = await ctl.restoreFromStateFile('startup');
  assert.equal(rec.pending, true);
  assert.equal(rec.preserved, true);
  assert.equal(rec.restored, 0);

  env.cleanup();
});

test('Task 1.4: Explicitly authorized recovery still works even in monitor-only mode', async () => {
  const env = createMockEnvironment({ failoverEnabled: false });
  env.ifaces.set(12, { index: 12, metric: 5, autoMetric: false, alias: 'Wi-Fi' });
  const staleState = {
    originals: [{ index: 12, alias: 'Wi-Fi', metric: 75, autoMetric: false }],
    pinned: [{ prefix: '1.1.1.1/32', ip: '1.1.1.1', index: 12, gateway: '192.168.1.1' }],
  };
  fs.writeFileSync(env.stateFile, JSON.stringify(staleState, null, 2));

  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: false, probeRoutePinning: false },
    failoverEnabled: false,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  await ctl.init();

  const res = await ctl.restoreAll();
  assert.equal(res.restored, 1);
  assert.equal(res.verified, true);
  assert.equal(env.ifaces.get(12).metric, 75, 'Metric must be restored to original value');
  assert.ok(!fs.existsSync(env.stateFile), 'State file should be cleaned up after verified explicit recovery');

  env.cleanup();
});

test('Task 1.5: Corrupt state file is backed up and never silently deleted', async () => {
  const env = createMockEnvironment();
  fs.writeFileSync(env.stateFile, 'MALFORMED_JSON_CORRUPT_BYTES');

  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: true, probeRoutePinning: true },
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });

  await ctl.init();

  const files = fs.readdirSync(env.tmpDir);
  const backup = files.find((f) => f.includes('.corrupted.'));
  assert.ok(backup, 'Corrupt backup file must exist');

  env.cleanup();
});

// ============================================================================
// TASK 2: ROUTE OWNERSHIP AND CLEANUP VERIFICATION TESTS (P0)
// ============================================================================

test('Task 2.1: Successful owned-route removal and verification', async () => {
  const env = createMockEnvironment();
  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: true, probeRoutePinning: true },
    probeRoutePinning: true,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  await ctl.init();

  const adapter = { id: 'wifi', kind: 'wifi', index: 12, alias: 'Wi-Fi', gateway: '192.168.1.1' };
  await ctl.pin(adapter, ['1.1.1.1']);

  assert.ok(env.routes.has('1.1.1.1/32'));

  const unpinRes = await ctl.unpin(['1.1.1.1'], adapter);
  assert.equal(unpinRes.ok, true);
  assert.equal(unpinRes.verified, true);
  assert.ok(!env.routes.has('1.1.1.1/32'), 'Route must be removed');

  env.cleanup();
});

test('Task 2.2: Route still present after attempted removal triggers verification failure', async () => {
  const env = createMockEnvironment();
  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: true, probeRoutePinning: true },
    probeRoutePinning: true,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  await ctl.init();

  const adapter = { id: 'wifi', kind: 'wifi', index: 12, alias: 'Wi-Fi', gateway: '192.168.1.1' };
  await ctl.pin(adapter, ['1.1.1.1']);

  // Simulate PowerShell Remove-NetRoute failing silently (leaving route present in routing table)
  env.failureHooks.set(/Remove-NetRoute/, new Error('Access Denied from OS'));

  const unpinRes = await ctl.unpin(['1.1.1.1'], adapter);
  assert.equal(unpinRes.verified, false, 'Unpin must fail verification if route remains present');
  assert.ok(unpinRes.errors.length > 0);

  // State file must be preserved
  const st = JSON.parse(fs.readFileSync(env.stateFile, 'utf8'));
  assert.ok(st.pinned.some((p) => p.ip === '1.1.1.1'), 'Unverified route must remain in state file');

  env.cleanup();
});

test('Task 2.3: Pre-existing or unrelated route on different interface is preserved', async () => {
  const env = createMockEnvironment();
  // Pre-seed an unrelated route for 1.1.1.1 on interface 99
  env.routes.set('1.1.1.1/32', [
    { DestinationPrefix: '1.1.1.1/32', InterfaceIndex: 99, NextHop: '192.168.1.1', PolicyStore: 'ActiveStore' },
  ]);

  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: true, probeRoutePinning: true },
    probeRoutePinning: true,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  await ctl.init();

  // Calling unpin for 1.1.1.1 without NetSwitch having pinned it
  const adapter = { id: 'wifi', kind: 'wifi', index: 12, alias: 'Wi-Fi', gateway: '192.168.1.1' };
  await ctl.unpin(['1.1.1.1'], adapter);

  // The unrelated route on interface 99 must NOT have been deleted
  assert.ok(env.routes.has('1.1.1.1/32'));
  const remaining = env.routes.get('1.1.1.1/32');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].InterfaceIndex, 99, 'Unrelated route on interface 99 must be preserved');

  env.cleanup();
});

test('Task 2.4: Repeated cleanup is idempotent and verified', async () => {
  const env = createMockEnvironment();
  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: true, probeRoutePinning: true },
    probeRoutePinning: true,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  await ctl.init();

  const adapter = { id: 'wifi', kind: 'wifi', index: 12, alias: 'Wi-Fi', gateway: '192.168.1.1' };
  await ctl.pin(adapter, ['1.1.1.1']);
  await ctl.unpin(['1.1.1.1'], adapter);

  const secondUnpin = await ctl.unpin(['1.1.1.1'], adapter);
  assert.equal(secondUnpin.ok, true);
  assert.equal(secondUnpin.verified, true);

  env.cleanup();
});

// ============================================================================
// TASK 3: HARDWARE IDENTITY ANCHORING TESTS (P1)
// ============================================================================

test('Task 3.1: USB removal stops probe driver promptly', async () => {
  class MockProbeDriver {
    constructor() { this.stopped = false; this.started = false; }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    read() { return { udp: [], icmp: [], tcp: null }; }
  }

  const mockCtl = new EventEmitter();
  mockCtl.mode = 'windows';
  mockCtl.canControl = false;
  mockCtl.failoverEnabled = false;
  mockCtl.probeRoutePinning = false;
  mockCtl.init = async () => false;

  let currentAdapters = [
    { id: 'wifi', kind: 'wifi', alias: 'Wi-Fi', index: 12, mac: '02-00-00-00-00-01', description: 'Intel AX203', ip: '192.168.1.100', prefix: 24, gateway: '192.168.1.1', metric: 75 },
    { id: 'usb', kind: 'usb', alias: 'Ethernet 2', index: 17, mac: '02-00-00-00-00-02', description: 'Remote NDIS', ip: '192.168.2.100', prefix: 24, gateway: '192.168.2.1', metric: 5 },
  ];
  mockCtl.discover = async () => currentAdapters;

  const repo = new MemoryRepo();
  const agent = new Agent({
    controller: mockCtl,
    repo,
    ProbeDriver: MockProbeDriver,
    log: () => {},
  });

  await agent.start();
  const usb = agent.adapters.get('usb');
  assert.equal(usb.up, true);
  const usbDriver = usb.driver;
  assert.equal(usbDriver.stopped, false);

  // Simulate USB removal
  currentAdapters = [currentAdapters[0]]; // Only Wi-Fi remains
  await agent.refreshDiscovery();

  assert.equal(usb.up, false, 'Adapter up flag must be false when unplugged');
  assert.equal(usbDriver.stopped, true, 'Probe driver must be stopped promptly upon disconnect');

  await agent.stop();
});

test('Task 3.2: Reconnection with identical MAC preserves identity and updates index', async () => {
  const env = createMockEnvironment();
  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: true, probeRoutePinning: true },
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  await ctl.init();

  env.ifaces.set(22, { index: 22, metric: 5, autoMetric: false, alias: 'Ethernet 2', mac: '02-00-00-00-00-02' });

  const queryHw = await ctl.queryAdapterIdentity(22);
  assert.equal(queryHw.mac, '02-00-00-00-00-02');
  assert.equal(queryHw.index, 22);

  env.cleanup();
});

test('Task 3.3: Hardware identity conflict is detected before mutation', async () => {
  const env = createMockEnvironment({ failoverEnabled: true });
  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: true, probeRoutePinning: true },
    failoverEnabled: true,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  ctl.canControl = true;

  const targetAdapter = {
    id: 'usb',
    kind: 'usb',
    index: 17,
    alias: 'Ethernet 2',
    description: 'Remote NDIS',
    mac: '02-00-00-00-00-02',
    ip: '192.168.2.100',
    metric: 5,
    up: true,
  };

  // The OS reports that index 17 has a different device with MAC 'AA-BB-CC-DD-EE-FF'
  env.ifaces.set(17, { index: 17, metric: 5, autoMetric: false, alias: 'Ethernet 2', mac: 'AA-BB-CC-DD-EE-FF' });

  const res = await ctl.setActive([targetAdapter], 'usb');
  assert.equal(res.ok, false);
  assert.ok(res.note.includes('hardware identity mismatch'), `Expected hardware identity mismatch error, got: ${res.note}`);

  env.cleanup();
});

// ============================================================================
// TASK 4: DIAGNOSTIC SCRIPT CLEANUP TESTS (P1)
// ============================================================================

test('Task 4.1: runCheckWindows executes cleanup in finally block on success', async () => {
  const logs = [];
  let restored = false;

  const mockCtl = {
    canControl: true,
    init: async () => true,
    discover: async () => [
      { id: 'wifi', kind: 'wifi', alias: 'Wi-Fi', index: 12, ip: '192.168.1.100', prefix: 24, gateway: '192.168.1.1', metric: 75 },
      { id: 'usb', kind: 'usb', alias: 'Ethernet 2', index: 17, ip: '192.168.2.100', prefix: 24, gateway: '192.168.2.1', metric: 5 },
    ],
    pin: async () => {},
    routeInterface: async () => 12,
    restoreAll: async () => { restored = true; return { restored: 2, verified: true }; },
  };

  class MockDriver {
    constructor() { this.stopped = false; }
    start() {}
    stop() { this.stopped = true; }
    read() {
      return {
        udp: [{ t: Date.now(), ok: true, rtt: 35 }],
        icmp: [{ t: Date.now(), ok: true, rtt: 35 }],
        tcp: { ok: true, ms: 40, at: Date.now() },
      };
    }
  }

  const res = await runCheckWindows({
    ctl: mockCtl,
    ProbeDriver: MockDriver,
    log: (msg) => logs.push(String(msg)),
    errorLog: () => {},
    sleep: async () => {},
    probeDurationMs: 10,
  });

  assert.equal(res.ok, true);
  assert.equal(restored, true, 'ctl.restoreAll() must be called in finally block');
});

test('Task 4.2: runCheckWindows cleans up and preserves original error when probing fails', async () => {
  let restored = false;

  const mockCtl = {
    canControl: true,
    init: async () => true,
    discover: async () => [
      { id: 'wifi', kind: 'wifi', alias: 'Wi-Fi', index: 12, ip: '192.168.1.100', prefix: 24, gateway: '192.168.1.1', metric: 75 },
    ],
    pin: async () => { throw new Error('OS route pinning failed'); },
    restoreAll: async () => { restored = true; return { restored: 0, verified: true }; },
  };

  await assert.rejects(
    async () => {
      await runCheckWindows({
        ctl: mockCtl,
        log: () => {},
        errorLog: () => {},
        sleep: async () => {},
        probeDurationMs: 10,
      });
    },
    /OS route pinning failed/
  );

  assert.equal(restored, true, 'ctl.restoreAll() must be called even when pinning throws');
});

// ============================================================================
// STAGE 4B.1: CRITICAL SAFETY CORRECTIONS TESTS (P0)
// ============================================================================

test('Task 4B.1-1: Route query failure prevents deletion', async () => {
  const env = createMockEnvironment();
  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: true, probeRoutePinning: true },
    probeRoutePinning: true,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  await ctl.init();

  const adapter = { id: 'wifi', kind: 'wifi', index: 12, alias: 'Wi-Fi', gateway: '192.168.1.1', guid: '{00000000-0000-4000-8000-000000000001}', mac: '02-00-00-00-00-01' };
  await ctl.pin(adapter, ['1.1.1.1']);

  // Reset command log to isolate unpin commands
  env.commandLog.length = 0;

  // Simulate route query throwing an error
  env.failureHooks.set(/Get-NetRoute/, new Error('WMI Query Failed'));

  const unpinRes = await ctl.unpin(['1.1.1.1'], adapter);
  assert.equal(unpinRes.verified, false);

  // Assert NO Remove-NetRoute command was issued
  const removeCmds = env.commandLog.filter((c) => c.includes('Remove-NetRoute'));
  assert.equal(removeCmds.length, 0, 'No Remove-NetRoute must be executed if queryRoute fails');

  // Assert route is preserved in state file and routing table
  assert.ok(env.routes.has('1.1.1.1/32'));
  const st = JSON.parse(fs.readFileSync(env.stateFile, 'utf8'));
  assert.ok(st.pinned.some((p) => p.ip === '1.1.1.1'));

  env.cleanup();
});

test('Task 4B.1-2: Route query returning null prevents deletion', async () => {
  const env = createMockEnvironment();
  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: true, probeRoutePinning: true },
    probeRoutePinning: true,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  await ctl.init();

  const adapter = { id: 'wifi', kind: 'wifi', index: 12, alias: 'Wi-Fi', gateway: '192.168.1.1', guid: '{00000000-0000-4000-8000-000000000001}', mac: '02-00-00-00-00-01' };
  await ctl.pin(adapter, ['1.1.1.1']);

  env.commandLog.length = 0;

  // Make queryRoute return null by returning invalid JSON
  const originalRunPs = env.mockRunPs;
  ctl.runPs = async (cmd) => {
    if (cmd.includes('Get-NetRoute')) return 'INVALID_JSON_CORRUPTED';
    return originalRunPs(cmd);
  };

  const unpinRes = await ctl.unpin(['1.1.1.1'], adapter);
  assert.equal(unpinRes.verified, false);

  const removeCmds = env.commandLog.filter((c) => c.includes('Remove-NetRoute'));
  assert.equal(removeCmds.length, 0, 'No Remove-NetRoute must be executed if queryRoute returns null');

  env.cleanup();
});

test('Task 4B.1-3: Destination-only Remove-NetRoute is never executed', async () => {
  const env = createMockEnvironment();
  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: true, probeRoutePinning: true },
    probeRoutePinning: true,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  await ctl.init();

  const adapter = { id: 'wifi', kind: 'wifi', index: 12, alias: 'Wi-Fi', gateway: '192.168.1.1', guid: '{00000000-0000-4000-8000-000000000001}', mac: '02-00-00-00-00-01' };
  await ctl.pin(adapter, ['1.1.1.1']);
  await ctl.unpin(['1.1.1.1'], adapter);

  // Inspect all Remove-NetRoute commands issued during pin and unpin
  const removeCmds = env.commandLog.filter((c) => c.includes('Remove-NetRoute'));
  assert.ok(removeCmds.length > 0);
  for (const cmd of removeCmds) {
    assert.ok(cmd.includes('-InterfaceIndex'), `Command must specify -InterfaceIndex: ${cmd}`);
    assert.ok(!cmd.match(/Remove-NetRoute -DestinationPrefix "[^"]+" -Confirm/i), `Destination-only command prohibited: ${cmd}`);
  }

  env.cleanup();
});

test('Task 4B.1-4: Pre-existing route on the same interface is preserved', async () => {
  const env = createMockEnvironment();
  // Pre-seed an unrelated route on interface 12
  env.routes.set('1.1.1.1/32', [
    { DestinationPrefix: '1.1.1.1/32', InterfaceIndex: 12, NextHop: '192.168.1.99', PolicyStore: 'ActiveStore' },
  ]);

  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: true, probeRoutePinning: true },
    probeRoutePinning: true,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  await ctl.init();

  const adapter = { id: 'wifi', kind: 'wifi', index: 12, alias: 'Wi-Fi', gateway: '192.168.1.1', guid: '{00000000-0000-4000-8000-000000000001}', mac: '02-00-00-00-00-01' };
  env.commandLog.length = 0;

  // Unpin called without NetSwitch having owned this route
  await ctl.unpin(['1.1.1.1'], adapter);

  const removeCmds = env.commandLog.filter((c) => c.includes('Remove-NetRoute'));
  assert.equal(removeCmds.length, 0, 'No Remove-NetRoute must execute against pre-existing route on same interface');
  assert.ok(env.routes.has('1.1.1.1/32'));

  env.cleanup();
});

test('Task 4B.1-5: Existing route with a different gateway is preserved', async () => {
  const env = createMockEnvironment();
  // Seed state saying NetSwitch owns 1.1.1.1 on index 12 with gateway 192.168.1.1
  const staleState = {
    originals: [],
    pinned: [{ prefix: '1.1.1.1/32', ip: '1.1.1.1', index: 12, gateway: '192.168.1.1', guid: '{00000000-0000-4000-8000-000000000001}', mac: '02-00-00-00-00-01' }],
  };
  fs.writeFileSync(env.stateFile, JSON.stringify(staleState, null, 2));

  // But the OS route actually has NextHop 192.168.1.254 (different gateway!)
  env.routes.set('1.1.1.1/32', [
    { DestinationPrefix: '1.1.1.1/32', InterfaceIndex: 12, NextHop: '192.168.1.254', PolicyStore: 'ActiveStore' },
  ]);

  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: true, probeRoutePinning: true },
    probeRoutePinning: true,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  await ctl.init();

  const adapter = { id: 'wifi', kind: 'wifi', index: 12, alias: 'Wi-Fi', gateway: '192.168.1.1', guid: '{00000000-0000-4000-8000-000000000001}', mac: '02-00-00-00-00-01' };
  env.commandLog.length = 0;

  await ctl.unpin(['1.1.1.1'], adapter);

  const removeCmds = env.commandLog.filter((c) => c.includes('Remove-NetRoute'));
  assert.equal(removeCmds.length, 0, 'Must NOT delete route with different gateway');
  assert.equal(env.routes.get('1.1.1.1/32')[0].NextHop, '192.168.1.254');

  env.cleanup();
});

test('Task 4B.1-6: Changed interface GUID prevents route deletion', async () => {
  const env = createMockEnvironment();
  // State records owned route with original Wi-Fi GUID
  const staleState = {
    originals: [],
    pinned: [{ prefix: '1.1.1.1/32', ip: '1.1.1.1', index: 12, gateway: '192.168.1.1', guid: '{00000000-0000-4000-8000-000000000001}', mac: '02-00-00-00-00-01' }],
  };
  fs.writeFileSync(env.stateFile, JSON.stringify(staleState, null, 2));

  env.routes.set('1.1.1.1/32', [
    { DestinationPrefix: '1.1.1.1/32', InterfaceIndex: 12, NextHop: '192.168.1.1', PolicyStore: 'ActiveStore' },
  ]);

  // OS reports that index 12 now has a DIFFERENT GUID
  env.ifaces.set(12, { index: 12, metric: 75, autoMetric: false, alias: 'Wi-Fi', guid: '{NEW-SUBSTITUTE-GUID-000000000000}', mac: '02-00-00-00-00-01' });

  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: true, probeRoutePinning: true },
    probeRoutePinning: true,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  await ctl.init();

  const adapter = { id: 'wifi', kind: 'wifi', index: 12, alias: 'Wi-Fi', gateway: '192.168.1.1', guid: '{00000000-0000-4000-8000-000000000001}', mac: '02-00-00-00-00-01' };
  env.commandLog.length = 0;

  const res = await ctl.unpin(['1.1.1.1'], adapter);
  assert.equal(res.verified, false);

  const removeCmds = env.commandLog.filter((c) => c.includes('Remove-NetRoute'));
  assert.equal(removeCmds.length, 0, 'Must NOT delete route when interface GUID has changed');
  assert.ok(env.routes.has('1.1.1.1/32'));

  env.cleanup();
});

test('Task 4B.1-7: Pinning aborts when a conflicting pre-existing route exists', async () => {
  const env = createMockEnvironment();
  // Pre-existing route for 1.1.1.1 already in OS routing table
  env.routes.set('1.1.1.1/32', [
    { DestinationPrefix: '1.1.1.1/32', InterfaceIndex: 99, NextHop: '192.168.1.1', PolicyStore: 'ActiveStore' },
  ]);

  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: true, probeRoutePinning: true },
    probeRoutePinning: true,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  await ctl.init();

  const adapter = { id: 'wifi', kind: 'wifi', index: 12, alias: 'Wi-Fi', gateway: '192.168.1.1', guid: '{00000000-0000-4000-8000-000000000001}', mac: '02-00-00-00-00-01' };
  env.commandLog.length = 0;

  await assert.rejects(
    () => ctl.pin(adapter, ['1.1.1.1']),
    /Conflicting pre-existing route found/
  );

  // Assert NO New-NetRoute or Remove-NetRoute commands were executed
  const routeMutations = env.commandLog.filter((c) => c.includes('New-NetRoute') || c.includes('Remove-NetRoute'));
  assert.equal(routeMutations.length, 0, 'No route mutation commands must execute when conflicting route exists');

  // Assert pre-existing route preserved
  assert.equal(env.routes.get('1.1.1.1/32')[0].InterfaceIndex, 99);

  env.cleanup();
});

test('Task 4B.1-8: Identity query failure blocks setActive', async () => {
  const env = createMockEnvironment({ failoverEnabled: true });
  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: true, probeRoutePinning: true },
    failoverEnabled: true,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  ctl.canControl = true;

  const targetAdapter = {
    id: 'usb',
    kind: 'usb',
    index: 17,
    alias: 'Ethernet 2',
    mac: '02-00-00-00-00-02',
    guid: '{00000000-0000-4000-8000-000000000002}',
    ip: '192.168.2.100',
    metric: 5,
    up: true,
  };

  // Make Get-NetAdapter fail
  env.failureHooks.set(/Get-NetAdapter/, new Error('WMI Adapter query failure'));
  env.commandLog.length = 0;

  const res = await ctl.setActive([targetAdapter], 'usb');
  assert.equal(res.ok, false);

  // Assert ZERO Set-NetIPInterface commands were issued
  const setCmds = env.commandLog.filter((c) => c.includes('Set-NetIPInterface'));
  assert.equal(setCmds.length, 0, 'Zero Set-NetIPInterface commands must execute when identity query fails');

  env.cleanup();
});

test('Task 4B.1-9: Missing GUID blocks setActive when GUID was recorded', async () => {
  const env = createMockEnvironment({ failoverEnabled: true });
  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: true, probeRoutePinning: true },
    failoverEnabled: true,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  ctl.canControl = true;

  const targetAdapter = {
    id: 'usb',
    kind: 'usb',
    index: 17,
    alias: 'Ethernet 2',
    mac: '02-00-00-00-00-02',
    guid: '{00000000-0000-4000-8000-000000000002}',
    ip: '192.168.2.100',
    metric: 5,
    up: true,
  };

  // OS reports adapter at index 17 has null or empty GUID
  env.ifaces.set(17, { index: 17, metric: 5, autoMetric: false, alias: 'Ethernet 2', mac: '02-00-00-00-00-02', guid: null });
  env.commandLog.length = 0;

  const res = await ctl.setActive([targetAdapter], 'usb');
  assert.equal(res.ok, false);

  const setCmds = env.commandLog.filter((c) => c.includes('Set-NetIPInterface'));
  assert.equal(setCmds.length, 0, 'Zero Set-NetIPInterface commands must execute when GUID is missing');

  env.cleanup();
});

test('Task 4B.1-10: Rollback refuses to mutate a mismatched adapter', async () => {
  const env = createMockEnvironment();
  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: true, probeRoutePinning: true, activeMetric: 5, standbyMetric: 75, verifyTarget: '9.9.9.9' },
    failoverEnabled: true,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  ctl.canControl = true;

  const wifiAdapter = { id: 'wifi', kind: 'wifi', index: 12, alias: 'Wi-Fi', mac: '02-00-00-00-00-01', guid: '{00000000-0000-4000-8000-000000000001}', currentMetric: 75, metric: 75, ip: '192.168.1.100', up: true };
  const usbAdapter = { id: 'usb', kind: 'usb', index: 17, alias: 'Ethernet 2', mac: '02-00-00-00-00-02', guid: '{00000000-0000-4000-8000-000000000002}', currentMetric: 5, metric: 5, ip: '192.168.2.100', up: true };

  // Make setting metric on index 17 fail, triggering rollback of index 12
  env.failureHooks.set(/Set-NetIPInterface -InterfaceIndex 17/, new Error('Second adapter switch failed'));

  // But before rollback happens on index 12, simulate index 12 GUID changing in OS
  let set12Calls = 0;
  const originalRunPs = env.mockRunPs;
  ctl.runPs = async (cmd) => {
    if (cmd.includes('Set-NetIPInterface -InterfaceIndex 12')) {
      set12Calls++;
      if (set12Calls === 1) {
        // Initial mutation succeeds, but then adapter index 12 gets a different GUID before rollback
        env.ifaces.set(12, { ...env.ifaces.get(12), guid: '{CHANGED-GUID-DURING-TX}' });
      }
    }
    return originalRunPs(cmd);
  };

  const res = await ctl.setActive([wifiAdapter, usbAdapter], 'wifi');
  assert.equal(res.ok, false);
  assert.equal(res.rolledBack, false);
  assert.ok(res.note.includes('Rollback failed or unverified'));

  env.cleanup();
});

test('Task 4B.1-11: Startup recovery refuses to restore metrics to a mismatched adapter', async () => {
  const env = createMockEnvironment();
  // State file records original Wi-Fi adapter with GUID {00000000-0000-4000-8000-000000000001}
  const state = {
    originals: [{ index: 12, alias: 'Wi-Fi', metric: 75, autoMetric: false, guid: '{00000000-0000-4000-8000-000000000001}', mac: '02-00-00-00-00-01' }],
    pinned: [],
  };
  fs.writeFileSync(env.stateFile, JSON.stringify(state, null, 2));

  // In OS, index 12 now has a mismatched GUID
  env.ifaces.set(12, { index: 12, metric: 5, autoMetric: false, alias: 'Wi-Fi', guid: '{DIFFERENT-UNVERIFIED-GUID}', mac: '02-00-00-00-00-01' });

  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: true, probeRoutePinning: true },
    failoverEnabled: true,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  ctl.canControl = true;
  env.commandLog.length = 0;

  const res = await ctl.restoreFromStateFile('manual');
  assert.equal(res.verified, false);
  assert.equal(res.restored, 0);

  // Assert zero Set-NetIPInterface commands were issued against index 12
  const setCmds = env.commandLog.filter((c) => c.includes('Set-NetIPInterface -InterfaceIndex 12'));
  assert.equal(setCmds.length, 0, 'Zero Set-NetIPInterface commands must execute against mismatched adapter');

  // State file must be preserved
  assert.ok(fs.existsSync(env.stateFile));

  env.cleanup();
});

test('Task 4B.1-12: Failed recovery preserves the state file', async () => {
  const env = createMockEnvironment();
  const state = {
    originals: [{ index: 12, alias: 'Wi-Fi', metric: 75, autoMetric: false, guid: '{00000000-0000-4000-8000-000000000001}' }],
    pinned: [],
  };
  fs.writeFileSync(env.stateFile, JSON.stringify(state, null, 2));

  // Make queryInterface fail during verification
  env.failureHooks.set(/Get-NetIPInterface/, new Error('Query error during verification'));

  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: { failoverEnabled: true, probeRoutePinning: true },
    failoverEnabled: true,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  ctl.canControl = true;

  const res = await ctl.restoreFromStateFile('manual');
  assert.equal(res.verified, false);

  // State file must still exist
  assert.ok(fs.existsSync(env.stateFile), 'State file must be preserved on disk when recovery verification fails');

  env.cleanup();
});
