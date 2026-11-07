import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WinController } from '../src/control/winController.js';
import { isVirtualOrExcluded, toAdapters } from '../src/windows/discovery.js';

const mockCfg = {
  activeMetric: 5,
  standbyMetric: 75,
  verifyTarget: '9.9.9.9',
};

function createMockEnvironment() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netswitch-ctl-test-'));
  const stateFile = path.join(tmpDir, 'netswitch-state.json');

  const ifaces = new Map([
    [12, { index: 12, metric: 75, autoMetric: false, alias: 'Wi-Fi' }],
    [17, { index: 17, metric: 5, autoMetric: false, alias: 'Ethernet 2' }],
    [21, { index: 21, metric: 20, autoMetric: false, alias: 'VMnet1' }],
  ]);

  const commandLog = [];
  const failureHooks = new Map();

  const mockRunPs = async (cmd) => {
    commandLog.push(cmd);

    // Check if any failure hook matches this command
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

    // Find-NetRoute
    if (cmd.includes('Find-NetRoute')) {
      // Return whichever interface has the lower metric
      const sorted = [...ifaces.values()].sort((a, b) => a.metric - b.metric);
      return String(sorted[0].index);
    }

    // Route add / remove
    if (cmd.includes('New-NetRoute') || cmd.includes('Remove-NetRoute')) {
      return '';
    }

    return '';
  };

  const mockConnectUnbound = async (host, port, timeoutMs) => {
    // Look up which interface currently has the lowest metric
    const sorted = [...ifaces.values()].sort((a, b) => a.metric - b.metric);
    const preferred = sorted[0];
    const ip = preferred.index === 12 ? '10.97.128.167' : '10.41.171.54';
    return { ok: true, localAddress: ip };
  };

  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  };

  return { tmpDir, stateFile, ifaces, commandLog, failureHooks, mockRunPs, mockConnectUnbound, cleanup };
}

const wifiAdapter = {
  id: 'wifi',
  kind: 'wifi',
  alias: 'Wi-Fi',
  index: 12,
  description: 'Intel(R) Wi-Fi 6 AX203',
  ip: '10.97.128.167',
  prefix: 24,
  gateway: '10.97.128.135',
  metric: 75,
  autoMetric: false,
  up: true,
  eligible: true,
};

const usbAdapter = {
  id: 'usb',
  kind: 'usb',
  alias: 'Ethernet 2',
  index: 17,
  description: 'Remote NDIS based Internet Sharing Device',
  ip: '10.41.171.54',
  prefix: 24,
  gateway: '10.41.171.250',
  metric: 5,
  autoMetric: false,
  up: true,
  eligible: true,
};

const vmwareAdapter = {
  id: 'other',
  kind: 'other',
  alias: 'VMware Network Adapter VMnet1',
  index: 21,
  description: 'VMware Virtual Ethernet Adapter for VMnet1',
  ip: '192.168.100.1',
  prefix: 24,
  gateway: '192.168.100.254',
  metric: 20,
  autoMetric: false,
  up: true,
  eligible: false,
};

// ------------------- TEST SUITE -------------------

test('1. First adapter succeeds, second adapter fails (triggers reverse-order rollback)', async () => {
  const env = createMockEnvironment();
  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: mockCfg,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  await ctl.init();

  // Make setting metric on Ethernet 2 (index 17) fail
  env.failureHooks.set(/Set-NetIPInterface -InterfaceIndex 17/, new Error('Simulated PS failure on second adapter'));

  const res = await ctl.setActive([wifiAdapter, usbAdapter], 'wifi');

  assert.equal(res.ok, false);
  assert.equal(res.rolledBack, true);
  assert.equal(res.verifiedRollback, true);

  // Both interfaces must be back at original metrics
  assert.equal(env.ifaces.get(12).metric, 75);
  assert.equal(env.ifaces.get(17).metric, 5);
  assert.equal(ctl.lock, false);

  env.cleanup();
});

test('2. Complete reverse-order rollback verified', async () => {
  const env = createMockEnvironment();
  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: mockCfg,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  await ctl.init();

  // Fail on index 17
  env.failureHooks.set(/Set-NetIPInterface -InterfaceIndex 17/, new Error('Failure on second adapter'));
  await ctl.setActive([wifiAdapter, usbAdapter], 'wifi');

  // Verify command log shows:
  // 1. Set idx 12 to 5
  // 2. Set idx 17 to 75 (failed)
  // 3. Rollback: Set idx 12 back to 75
  const setCmds = env.commandLog.filter((c) => c.includes('Set-NetIPInterface'));
  assert.ok(setCmds.length >= 3);
  assert.ok(setCmds[0].includes('-InterfaceIndex 12') && setCmds[0].includes('-InterfaceMetric 5'));
  assert.ok(setCmds[1].includes('-InterfaceIndex 17') && setCmds[1].includes('-InterfaceMetric 75'));
  assert.ok(setCmds[2].includes('-InterfaceIndex 12') && setCmds[2].includes('-InterfaceMetric 75'));

  env.cleanup();
});

test('3. Verification failure triggers rollback and verified rollback report', async () => {
  const env = createMockEnvironment();
  // Simulate verification returning the wrong local source address
  const badConnect = async () => ({ ok: true, localAddress: '10.41.171.54' }); // wrong IP, not Wi-Fi

  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: mockCfg,
    runPs: env.mockRunPs,
    connectUnbound: badConnect,
  });
  await ctl.init();

  const res = await ctl.setActive([wifiAdapter, usbAdapter], 'wifi');

  assert.equal(res.ok, false);
  assert.equal(res.verified, false);
  assert.equal(res.rolledBack, true);
  assert.equal(res.verifiedRollback, true);

  // Interface metrics must be restored to previous values
  assert.equal(env.ifaces.get(12).metric, 75);
  assert.equal(env.ifaces.get(17).metric, 5);

  env.cleanup();
});

test('4. Rollback itself fails: reported honestly, state preserved, lock released', async () => {
  const env = createMockEnvironment();
  let setCalls = 0;
  // 1st Set: idx 12 to 5 -> succeeds
  // 2nd Set: idx 17 to 75 -> fails (triggers rollback)
  // 3rd Set: rollback idx 12 to 75 -> fails (rollback itself fails!)
  const originalRunPs = env.mockRunPs;
  env.mockRunPs = async (cmd) => {
    if (cmd.includes('Set-NetIPInterface')) {
      setCalls++;
      if (setCalls === 2) throw new Error('Switch failure on second adapter');
      if (setCalls === 3) throw new Error('Hardware failure during rollback attempt');
    }
    return originalRunPs(cmd);
  };

  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: mockCfg,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  await ctl.init();

  const res = await ctl.setActive([wifiAdapter, usbAdapter], 'wifi');

  assert.equal(res.ok, false);
  assert.equal(res.rolledBack, false);
  assert.equal(res.verifiedRollback, false);
  assert.equal(ctl.lock, false); // Lock MUST be released
  assert.ok(res.note.includes('Rollback failed or unverified'));

  env.cleanup();
});

test('5. Corrupted state-file handling: backs up corrupted file and initializes safely', async () => {
  const env = createMockEnvironment();
  // Write malformed JSON to stateFile
  fs.writeFileSync(env.stateFile, '{"originals": [ incomplete json...');

  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: mockCfg,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });

  // init() must NOT crash
  const canControl = await ctl.init();
  assert.equal(canControl, true);

  // Check that corrupted backup was created
  const files = fs.readdirSync(env.tmpDir);
  const backup = files.find((f) => f.includes('corrupted'));
  assert.ok(backup, 'Corrupted backup file must exist');

  env.cleanup();
});

test('6. State-file preservation after failed recovery', async () => {
  const env = createMockEnvironment();
  // Populate state file
  const testState = {
    originals: [{ index: 12, alias: 'Wi-Fi', metric: 75, autoMetric: false }],
    pinned: [{ ip: '1.1.1.1', index: 12, gateway: '10.97.128.135' }],
  };
  fs.writeFileSync(env.stateFile, JSON.stringify(testState, null, 2));

  // Make Set-NetIPInterface fail during recovery
  env.failureHooks.set(/Set-NetIPInterface -InterfaceIndex 12/, new Error('Metric rollback rejected by OS'));

  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: mockCfg,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  ctl.canControl = true;

  const res = await ctl.restoreFromStateFile('crash_test');

  assert.equal(res.verified, false);
  assert.ok(fs.existsSync(env.stateFile), 'State file must be preserved on disk when recovery fails verification');

  env.cleanup();
});

test('7. VMware adapter exclusion: VMware VMnet adapters are rejected and never modified', async () => {
  const env = createMockEnvironment();
  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: mockCfg,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  await ctl.init();

  // 1. Assert assertEligible rejects VMware
  assert.throws(() => ctl.assertEligible(vmwareAdapter), /strictly prohibited/i);

  // 2. setActive must reject switching to VMware
  const res = await ctl.setActive([wifiAdapter, usbAdapter, vmwareAdapter], 'other');
  assert.equal(res.ok, false);

  // Verify zero commands were executed against index 21
  const vmnetCmds = env.commandLog.filter((c) => c.includes('InterfaceIndex 21'));
  assert.equal(vmnetCmds.length, 0);

  env.cleanup();
});

test('8. Virtual adapter exclusion: VirtualBox and vEthernet detected and excluded', () => {
  assert.ok(isVirtualOrExcluded('VirtualBox Host-Only Ethernet Adapter', 'VirtualBox Host-Only Network'));
  assert.ok(isVirtualOrExcluded('Hyper-V Virtual Ethernet Adapter', 'vEthernet (Default Switch)'));
  assert.ok(isVirtualOrExcluded('VMware Virtual Ethernet Adapter for VMnet8', 'VMware Network Adapter VMnet8'));
  assert.ok(!isVirtualOrExcluded('Intel(R) Wi-Fi 6 AX203 160MHz', 'Wi-Fi'));
  assert.ok(!isVirtualOrExcluded('Remote NDIS based Internet Sharing Device', 'Ethernet 2'));

  const rows = [
    { index: 12, alias: 'Wi-Fi', description: 'Intel Wi-Fi 6', ip: '10.97.128.167', prefix: 24, gateway: '10.97.128.135', metric: 75, autoMetric: false },
    { index: 15, alias: 'VMnet8', description: 'VMware Virtual Ethernet Adapter', ip: '192.168.1.1', prefix: 24, gateway: '192.168.1.254', metric: 20, autoMetric: false },
    { index: 21, alias: 'VMnet1', description: 'VMware Virtual Ethernet Adapter', ip: '192.168.2.1', prefix: 24, gateway: '192.168.2.254', metric: 20, autoMetric: false },
    { index: 17, alias: 'Ethernet 2', description: 'Remote NDIS', ip: '10.41.171.54', prefix: 24, gateway: '10.41.171.250', metric: 5, autoMetric: false },
  ];

  const filtered = toAdapters(rows);
  assert.deepEqual(filtered.map((a) => a.id), ['wifi', 'usb']);
  assert.equal(filtered.some((a) => a.index === 15 || a.index === 21), false);
});

test('9. Application restart with unfinished recovery state restores settings on init()', async () => {
  const env = createMockEnvironment();
  // Pre-seed state file with an interrupted state: Wi-Fi original was 75
  env.ifaces.set(12, { index: 12, metric: 5, autoMetric: false, alias: 'Wi-Fi' });
  const interruptedState = {
    originals: [{ index: 12, alias: 'Wi-Fi', metric: 75, autoMetric: false }],
    pinned: [{ ip: '1.1.1.1', index: 12, gateway: '10.97.128.135' }],
  };
  fs.writeFileSync(env.stateFile, JSON.stringify(interruptedState, null, 2));

  // New controller instance simulates app reboot
  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: mockCfg,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });

  await ctl.init();

  // Metrics should have been restored to 75
  assert.equal(env.ifaces.get(12).metric, 75);
  // State file should have been verified and removed
  assert.equal(fs.existsSync(env.stateFile), false);

  env.cleanup();
});

test('10. Concurrent switching and restoration protection', async () => {
  const env = createMockEnvironment();
  const ctl = new WinController({
    stateFile: env.stateFile,
    cfg: mockCfg,
    runPs: env.mockRunPs,
    connectUnbound: env.mockConnectUnbound,
  });
  await ctl.init();

  // Manually hold the lock to simulate an in-progress operation
  ctl.lock = true;

  const switchRes = await ctl.setActive([wifiAdapter, usbAdapter], 'wifi');
  assert.equal(switchRes.busy, true);
  assert.equal(switchRes.ok, false);

  const restoreRes = await ctl.restoreFromStateFile('manual');
  assert.equal(restoreRes.busy, true);
  assert.equal(restoreRes.ok, false);

  ctl.lock = false;

  env.cleanup();
});
