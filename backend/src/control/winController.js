import fs from 'node:fs';
import path from 'node:path';
import { runPs as defaultRunPs, int, ip4 } from '../windows/ps.js';
import { discoverWindows, isVirtualOrExcluded } from '../windows/discovery.js';
import { connectUnbound as defaultConnectUnbound } from '../probes/tcp.js';

export class WinController {
  constructor({
    stateFile,
    cfg,
    failoverEnabled,
    probeRoutePinning,
    log = console.log,
    runPs = defaultRunPs,
    connectUnbound = defaultConnectUnbound,
  } = {}) {
    this.stateFile = stateFile;
    this.cfg = cfg;
    this.failoverEnabled = failoverEnabled ?? cfg?.failoverEnabled ?? false;
    this.probeRoutePinning = probeRoutePinning ?? cfg?.probeRoutePinning ?? false;
    this.log = log;
    this.runPs = runPs;
    this.connectUnbound = connectUnbound;
    this.mode = 'windows';
    this.canControl = false;
    this.lock = false;
  }

  async init() {
    try {
      const res = await this.runPs(
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
      );
      this.canControl = String(res).trim().toLowerCase() === 'true';
    } catch {
      this.canControl = false;
    }
    const rec = await this.restoreFromStateFile('startup'); // Recover from any previous crash
    this.recoveryPending = !!rec?.pending;
    return this.canControl;
  }

  discover() {
    return discoverWindows();
  }

  assertEligible(adapter) {
    if (!adapter || typeof adapter !== 'object') {
      throw new Error('Invalid adapter configuration');
    }
    if (isVirtualOrExcluded(adapter.description || '', adapter.alias || '')) {
      throw new Error(`Modifying virtual or VMware adapter ${adapter.alias || adapter.id} is strictly prohibited`);
    }
    if (adapter.kind !== 'wifi' && adapter.kind !== 'usb') {
      throw new Error(`Adapter ${adapter.id || adapter.alias} (${adapter.kind}) is not eligible for NetSwitch management`);
    }
  }

  // ---- atomic state file handling with corrupted JSON protection ----

  #read() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) {
      return { originals: [], pinned: [] };
    }
    let raw = '';
    try {
      raw = fs.readFileSync(this.stateFile, 'utf8');
      if (!raw.trim()) return { originals: [], pinned: [] };
      const parsed = JSON.parse(raw);
      return {
        originals: Array.isArray(parsed.originals) ? parsed.originals : [],
        pinned: Array.isArray(parsed.pinned) ? parsed.pinned : [],
        updatedAt: parsed.updatedAt || null,
      };
    } catch (err) {
      const backupPath = `${this.stateFile}.corrupted.${Date.now()}`;
      try {
        fs.writeFileSync(backupPath, raw, 'utf8');
        this.log(`[winController] WARNING: corrupted state file detected. Preserved backup at ${backupPath}`);
      } catch (backupErr) {
        this.log(`[winController] Failed to write corrupted state backup: ${backupErr.message}`);
      }
      return { originals: [], pinned: [], corruptedBackup: backupPath };
    }
  }

  #write(s) {
    if (!this.stateFile) return;
    const dir = path.dirname(this.stateFile);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const payload = JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2);
    fs.writeFileSync(tmp, payload, 'utf8');
    try {
      fs.renameSync(tmp, this.stateFile);
    } catch {
      // Windows renameSync retry if destination briefly locked
      try { fs.unlinkSync(this.stateFile); } catch { /* ignore */ }
      fs.renameSync(tmp, this.stateFile);
    }
  }

  async #setMetric(index, metric, auto) {
    int(index, 1, 100000);
    if (auto) {
      return this.runPs(
        `Set-NetIPInterface -InterfaceIndex ${index} -AddressFamily IPv4 -AutomaticMetric Enabled`
      );
    }
    int(metric, 1, 9999);
    return this.runPs(
      `Set-NetIPInterface -InterfaceIndex ${index} -AddressFamily IPv4 -AutomaticMetric Disabled -InterfaceMetric ${metric}`
    );
  }

  async queryInterface(index) {
    int(index, 1, 100000);
    const txt = await this.runPs(
      `Get-NetIPInterface -InterfaceIndex ${index} -AddressFamily IPv4 | Select-Object -Property InterfaceIndex, InterfaceMetric, AutomaticMetric | ConvertTo-Json -Compress`
    );
    if (!txt) return null;
    const parsed = JSON.parse(txt);
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!row) return null;
    const isAuto =
      row.AutomaticMetric === 'Enabled' ||
      row.AutomaticMetric === 1 ||
      row.AutomaticMetric === true ||
      String(row.AutomaticMetric).toLowerCase() === 'enabled';
    return {
      index: Number(row.InterfaceIndex),
      metric: Number(row.InterfaceMetric),
      autoMetric: isAuto,
    };
  }

  async queryRoute(ip, ifIndex) {
    ip4(ip);
    let cmd = `Get-NetRoute -DestinationPrefix "${ip}/32" -ErrorAction SilentlyContinue`;
    if (ifIndex) cmd += ` -InterfaceIndex ${ifIndex}`;
    cmd += ` | Select-Object -Property DestinationPrefix, InterfaceIndex, NextHop, PolicyStore | ConvertTo-Json -Compress`;
    const txt = await this.runPs(cmd);
    if (txt === null || txt === undefined) return null;
    if (!txt.trim()) return [];
    try {
      const parsed = JSON.parse(txt);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return null;
    }
  }

  async queryAdapterIdentity(index) {
    int(index, 1, 100000);
    const txt = await this.runPs(
      `Get-NetAdapter -InterfaceIndex ${index} -ErrorAction SilentlyContinue | Select-Object -Property InterfaceIndex, MacAddress, InterfaceGuid, PnPDeviceID | ConvertTo-Json -Compress`
    );
    if (!txt || !txt.trim()) return null;
    try {
      const parsed = JSON.parse(txt);
      const row = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!row) return null;
      return {
        index: Number(row.InterfaceIndex),
        mac: row.MacAddress || null,
        guid: row.InterfaceGuid || null,
        pnpId: row.PnPDeviceID || null,
      };
    } catch {
      return null;
    }
  }

  // ---- route pinning with strict ownership tracking ----

  async pin(adapter, targets) {
    if (!this.probeRoutePinning) throw new Error('probe route pinning disabled by configuration');
    if (!this.canControl) throw new Error('not administrator');
    this.assertEligible(adapter);
    int(adapter.index, 1, 100000);
    ip4(adapter.gateway);

    // Validate adapter identity before pinning if identity is recorded
    if (adapter.guid || adapter.mac) {
      const hw = await this.queryAdapterIdentity(adapter.index).catch(() => null);
      if (!hw) {
        throw new Error(`Cannot verify adapter identity on interface index ${adapter.index}; aborting pinning`);
      }
      if (adapter.guid && (!hw.guid || hw.guid.toLowerCase() !== adapter.guid.toLowerCase())) {
        throw new Error(`GUID mismatch on interface index ${adapter.index} (${adapter.alias}): expected ${adapter.guid}, actual ${hw.guid || 'null'}`);
      }
      if (adapter.mac && hw.mac && hw.mac.toLowerCase() !== adapter.mac.toLowerCase()) {
        throw new Error(`MAC mismatch on interface index ${adapter.index} (${adapter.alias}): expected ${adapter.mac}, actual ${hw.mac}`);
      }
    }

    for (const t of targets) {
      ip4(t);

      // Query existing routes before attempting creation
      let existingRoutes;
      try {
        existingRoutes = await this.queryRoute(t);
      } catch (qErr) {
        throw new Error(`Failed to query existing routes for target ${t}/32: ${qErr.message}`);
      }
      if (existingRoutes === null || !Array.isArray(existingRoutes)) {
        throw new Error(`Route query returned unverifiable result for target ${t}/32; aborting pinning`);
      }

      const st = this.#read();
      const existingOwned = st.pinned.find((p) => p.ip === t);

      // Check for conflicts with pre-existing or unrelated routes
      if (existingRoutes.length > 0) {
        for (const er of existingRoutes) {
          const isOurTransaction =
            existingOwned &&
            Number(er.InterfaceIndex) === Number(existingOwned.index) &&
            (!existingOwned.gateway || !er.NextHop || er.NextHop === existingOwned.gateway);
          if (!isOurTransaction) {
            throw new Error(
              `Conflicting pre-existing route found for ${t}/32 on interface index ${er.InterfaceIndex} (NextHop: ${er.NextHop || 'none'}); aborting pinning`
            );
          }
        }
      }

      // Persist rich route identity before executing OS modification so partial failures retain recovery state
      st.pinned = st.pinned.filter((p) => p.ip !== t).concat({
        prefix: `${t}/32`,
        ip: t,
        index: adapter.index,
        gateway: adapter.gateway,
        policyStore: 'ActiveStore',
        mac: adapter.mac || null,
        guid: adapter.guid || null,
        alias: adapter.alias || null,
        pinnedAt: new Date().toISOString(),
      });
      this.#write(st);

      // Only remove if already positively identified as belonging to our current transaction
      if (existingOwned && existingRoutes.some((er) => Number(er.InterfaceIndex) === Number(adapter.index))) {
        await this.runPs(
          `Remove-NetRoute -DestinationPrefix "${t}/32" -InterfaceIndex ${adapter.index} -Confirm:$false -ErrorAction SilentlyContinue`
        ).catch(() => {});
      }

      await this.runPs(
        `New-NetRoute -DestinationPrefix "${t}/32" -InterfaceIndex ${adapter.index} -NextHop "${adapter.gateway}" -PolicyStore ActiveStore -ErrorAction Stop | Out-Null`
      );
    }
  }

  async unpin(targets, adapter) {
    const unpinErrors = [];
    for (const t of targets) {
      ip4(t);
      const st = this.#read();
      const owned = st.pinned.find((p) => p.ip === t);

      // 1. Verify route existence and ownership before removal
      if (!owned) {
        this.log(`[winController] Skipping unpin for ${t}/32: no owned NetSwitch route record found`);
        continue;
      }

      // 2. Validate interface identity if recorded
      if (owned.guid || owned.mac) {
        const hw = await this.queryAdapterIdentity(owned.index).catch(() => null);
        if (!hw) {
          unpinErrors.push(`Adapter identity query failed for interface ${owned.index} on ${t}/32`);
          this.log(`[winController] WARNING: unpin aborted for ${t}/32: adapter ${owned.index} identity unavailable`);
          continue;
        }
        if (owned.guid && (!hw.guid || hw.guid.toLowerCase() !== owned.guid.toLowerCase())) {
          unpinErrors.push(`Adapter GUID changed for interface ${owned.index} on ${t}/32 (expected ${owned.guid}, actual ${hw.guid || 'null'})`);
          this.log(`[winController] WARNING: unpin aborted for ${t}/32: adapter ${owned.index} GUID mismatch`);
          continue;
        }
        if (owned.mac && hw.mac && hw.mac.toLowerCase() !== owned.mac.toLowerCase()) {
          unpinErrors.push(`Adapter MAC changed for interface ${owned.index} on ${t}/32 (expected ${owned.mac}, actual ${hw.mac})`);
          this.log(`[winController] WARNING: unpin aborted for ${t}/32: adapter ${owned.index} MAC mismatch`);
          continue;
        }
      }

      // 3. Query existing routes with fail-closed check
      let existingRoutes;
      try {
        existingRoutes = await this.queryRoute(t);
      } catch (qErr) {
        unpinErrors.push(`Failed to query routes for ${t}/32: ${qErr.message}`);
        this.log(`[winController] WARNING: queryRoute failed for ${t}/32: ${qErr.message}`);
        continue;
      }

      if (existingRoutes === null || !Array.isArray(existingRoutes)) {
        unpinErrors.push(`Route query returned unverifiable result for ${t}/32`);
        this.log(`[winController] WARNING: unpin aborted for ${t}/32: queryRoute returned null or invalid result`);
        continue;
      }

      if (existingRoutes.length === 0) {
        // Route is already absent from the OS routing table: clean up state record
        st.pinned = st.pinned.filter((p) => p.ip !== t);
        this.#write(st);
        continue;
      }

      // 4. Verify exact owned route identity (destination, interface, nextHop)
      const matches = existingRoutes.filter((r) => {
        const prefixMatches = r.DestinationPrefix === `${t}/32`;
        const ifMatches = Number(r.InterfaceIndex) === Number(owned.index);
        const gwMatches = !owned.gateway || !r.NextHop || r.NextHop === owned.gateway;
        return prefixMatches && ifMatches && gwMatches;
      });

      if (matches.length === 0) {
        this.log(`[winController] Preserving unrelated routes for ${t}/32 (none match owned index ${owned.index} and gateway ${owned.gateway})`);
        continue;
      }

      if (matches.length > 1) {
        unpinErrors.push(`Ambiguous route ownership for ${t}/32: multiple matching routes found on interface ${owned.index}`);
        this.log(`[winController] WARNING: unpin aborted for ${t}/32: ambiguous route ownership`);
        continue;
      }

      const match = matches[0];

      // 5. Execute exact deletion (NEVER destination-only)
      let removeCmd = `Remove-NetRoute -DestinationPrefix "${t}/32" -InterfaceIndex ${match.InterfaceIndex}`;
      if (match.NextHop && match.NextHop !== '0.0.0.0') {
        removeCmd += ` -NextHop "${match.NextHop}"`;
      }
      removeCmd += ` -Confirm:$false -ErrorAction SilentlyContinue`;
      await this.runPs(removeCmd).catch(() => {});

      // 6. Independent verification: confirm exact route is absent
      let remaining;
      try {
        remaining = await this.queryRoute(t);
      } catch {
        remaining = null;
      }

      if (remaining === null || !Array.isArray(remaining)) {
        unpinErrors.push(`Verification query failed for ${t}/32 after removal`);
        continue;
      }

      const stillOwned = remaining.find((r) => Number(r.InterfaceIndex) === Number(owned.index));
      if (stillOwned) {
        unpinErrors.push(`Route ${t}/32 still present on interface ${stillOwned.InterfaceIndex} after removal attempt`);
        this.log(`[winController] WARNING: unpin verification failed: ${t}/32 still present on interface ${stillOwned.InterfaceIndex}`);
        continue; // Preserve in state file if route cannot be verified absent
      }

      // Confirmed absent: remove from state file
      st.pinned = st.pinned.filter((p) => p.ip !== t);
      this.#write(st);
    }

    return {
      ok: unpinErrors.length === 0,
      verified: unpinErrors.length === 0,
      errors: unpinErrors,
    };
  }

  async routeInterface(ip) {
    ip4(ip);
    const out = await this.runPs(
      `Find-NetRoute -RemoteIPAddress ${ip} | Select-Object -First 1 -ExpandProperty InterfaceIndex`
    );
    return Number(out);
  }

  // ---- transaction-safe active adapter switching ----

  async #rollback(modifiedStack) {
    const toRevert = [...modifiedStack].reverse();
    const applyErrors = [];
    for (const item of toRevert) {
      // Re-query and validate adapter identity before each rollback metric restoration
      const hw = await this.queryAdapterIdentity(item.index).catch(() => null);
      if (!hw) {
        applyErrors.push(`Rollback refused for index ${item.index} (${item.alias || item.index}): identity query failed or adapter unavailable`);
        continue;
      }
      if (item.guid && (!hw.guid || hw.guid.toLowerCase() !== item.guid.toLowerCase())) {
        applyErrors.push(`Rollback refused for index ${item.index} (${item.alias || item.index}): GUID mismatch (expected ${item.guid}, actual ${hw.guid || 'null'})`);
        continue;
      }
      if (item.mac && hw.mac && hw.mac.toLowerCase() !== item.mac.toLowerCase()) {
        applyErrors.push(`Rollback refused for index ${item.index} (${item.alias || item.index}): MAC mismatch (expected ${item.mac}, actual ${hw.mac})`);
        continue;
      }

      try {
        await this.#setMetric(item.index, item.metric, item.autoMetric);
      } catch (err) {
        applyErrors.push(`Index ${item.index}: ${err.message}`);
      }
    }

    // Independent verification of the rollback state
    const verifyErrors = [];
    for (const item of toRevert) {
      try {
        const cur = await this.queryInterface(item.index);
        if (cur) {
          const autoMatches = cur.autoMetric === !!item.autoMetric;
          const metricMatches = item.autoMetric ? true : cur.metric === item.metric;
          if (!autoMatches || !metricMatches) {
            verifyErrors.push(
              `Index ${item.index} mismatch: expected metric=${item.metric} auto=${item.autoMetric}, actual metric=${cur.metric} auto=${cur.autoMetric}`
            );
          }
        }
      } catch (vErr) {
        verifyErrors.push(`Verify error on index ${item.index}: ${vErr.message}`);
      }
    }

    const failed = applyErrors.length > 0 || verifyErrors.length > 0;
    return {
      ok: !failed,
      verified: !failed,
      applyErrors,
      verifyErrors,
      note: failed
        ? `Rollback failed or unverified (${[...applyErrors, ...verifyErrors].join('; ')})`
        : 'Rolled back and independently verified',
    };
  }

  async setActive(adapters, id) {
    if (!this.failoverEnabled) return { ok: false, note: 'failover disabled by configuration (monitor-only mode)' };
    if (!this.canControl) return { ok: false, note: 'not administrator: control disabled' };
    if (this.lock) return { ok: false, note: 'switch already in progress', busy: true };
    this.lock = true;
    const t0 = Date.now();

    try {
      const target = adapters.find((a) => a.id === id && a.up !== false);
      if (!target) {
        return { ok: false, note: `adapter ${id} not available` };
      }
      this.assertEligible(target);

      // Revalidate hardware identity before OS mutation
      if (target.mac || target.guid) {
        const hw = await this.queryAdapterIdentity(target.index).catch(() => null);
        if (!hw) {
          return {
            ok: false,
            note: `hardware identity query failed or adapter unavailable on interface ${target.index}`,
          };
        }
        if (target.guid && (!hw.guid || hw.guid.toLowerCase() !== target.guid.toLowerCase())) {
          return {
            ok: false,
            note: `hardware identity mismatch on interface ${target.index}: expected GUID ${target.guid}, actual ${hw.guid || 'null'}`,
          };
        }
        if (target.mac && (!hw.mac || hw.mac.toLowerCase() !== target.mac.toLowerCase())) {
          return {
            ok: false,
            note: `hardware identity mismatch on interface ${target.index}: expected MAC ${target.mac}, actual ${hw.mac || 'null'}`,
          };
        }
      }

      // Filter only managed eligible physical adapters
      const managed = adapters.filter(
        (a) =>
          (a.kind === 'wifi' || a.kind === 'usb') &&
          !isVirtualOrExcluded(a.description || '', a.alias || '') &&
          a.up !== false
      );

      // Snapshot original configurations before any modification, including MAC and GUID
      const st = this.#read();
      for (const a of managed) {
        if (!st.originals.find((o) => o.index === a.index)) {
          st.originals.push({
            index: a.index,
            alias: a.alias,
            guid: a.guid || null,
            mac: a.mac || null,
            metric: a.currentMetric ?? a.metric,
            autoMetric: !!a.autoMetric,
          });
        }
      }
      this.#write(st);

      // Record exact previous state for rollback
      const previous = managed.map((a) => ({
        index: a.index,
        alias: a.alias,
        guid: a.guid || null,
        mac: a.mac || null,
        metric: a.currentMetric ?? a.metric,
        autoMetric: !!a.autoMetric,
      }));

      // Modification loop with tracking for reverse-order rollback
      const modifiedStack = [];
      let modificationError = null;

      for (const a of managed) {
        const desiredMetric = a.id === id ? this.cfg.activeMetric : this.cfg.standbyMetric;
        const prev = previous.find((p) => p.index === a.index);

        // Re-query InterfaceGuid immediately before every Set-NetIPInterface operation
        const hw = await this.queryAdapterIdentity(a.index).catch(() => null);
        if (!hw) {
          modificationError = new Error(`Identity query failed on interface index ${a.index} (${a.alias || a.id})`);
          break;
        }
        if (a.guid) {
          if (!hw.guid || hw.guid.toLowerCase() !== a.guid.toLowerCase()) {
            modificationError = new Error(`GUID mismatch on interface index ${a.index} (${a.alias || a.id}): expected ${a.guid}, actual ${hw.guid || 'null'}`);
            break;
          }
        }
        if (a.mac && hw.mac && hw.mac.toLowerCase() !== a.mac.toLowerCase()) {
          modificationError = new Error(`MAC mismatch on interface index ${a.index} (${a.alias || a.id}): expected ${a.mac}, actual ${hw.mac}`);
          break;
        }

        try {
          await this.#setMetric(a.index, desiredMetric, false);
          modifiedStack.push(prev);
        } catch (setErr) {
          modificationError = setErr;
          break;
        }
      }

      const tSet = Date.now();

      // If any metric modification failed, execute reverse-order rollback
      if (modificationError) {
        const rb = await this.#rollback(modifiedStack);
        return {
          ok: false,
          verified: false,
          rolledBack: rb.ok,
          verifiedRollback: rb.verified,
          note: `metric switch failed (${modificationError.message}); ${rb.note}`,
        };
      }

      // Verification: route lookup AND unbound TCP connect from OS-chosen source
      const idx = await this.routeInterface(this.cfg.verifyTarget);
      const c = await this.connectUnbound(this.cfg.verifyTarget, 443, 3000);
      const verified = idx === target.index && c.ok && c.localAddress === target.ip;

      if (!verified) {
        const rb = await this.#rollback(modifiedStack);
        return {
          ok: false,
          verified: false,
          rolledBack: rb.ok,
          verifiedRollback: rb.verified,
          note: `verification failed (route if ${idx}, local ${c.localAddress}); ${rb.note}`,
          setMs: tSet - t0,
          verifyMs: Date.now() - t0,
        };
      }

      return {
        ok: true,
        verified: true,
        note: 'route and source address verified',
        setMs: tSet - t0,
        verifyMs: Date.now() - t0,
      };
    } catch (e) {
      return { ok: false, note: `switch error: ${e.message}`, rolledBack: false };
    } finally {
      this.lock = false;
    }
  }

  // ---- safe recovery from state file ----

  async restoreFromStateFile(why) {
    if (this.lock) return { ok: false, busy: true, note: 'controller is locked' };
    this.lock = true;
    try {
      const st = this.#read();
      if (!st.originals.length && !st.pinned.length) {
        return { restored: 0, verified: true };
      }

      // Startup Recovery Guard: if startup recovery in monitor-only mode, DO NOT MUTATE OS
      if (why === 'startup' && !this.failoverEnabled) {
        this.log(
          `[control] Startup recovery pending: state file exists (${st.originals.length} originals, ${st.pinned.length} pinned), but failover is disabled (monitor-only mode). Preserving state file without mutation.`
        );
        return {
          restored: 0,
          verified: false,
          pending: true,
          preserved: true,
          note: 'recovery pending: failover disabled (monitor-only mode)',
          state: { originals: st.originals.length, pinned: st.pinned.length },
        };
      }

      let restoredCount = 0;
      const verifyErrors = [];

      if (this.canControl) {
        // 1. Restore metrics for managed physical interfaces only with strict identity validation
        for (const o of st.originals) {
          if (isVirtualOrExcluded(o.alias || '', '')) {
            this.log(`[control] Skipping virtual adapter in recovery: ${o.alias} (index ${o.index})`);
            continue;
          }

          // Validate adapter identity before restoring metric
          const hw = await this.queryAdapterIdentity(o.index).catch(() => null);
          if (!hw) {
            verifyErrors.push(`Recovery refused on index ${o.index} (${o.alias}): identity query failed or adapter unavailable`);
            this.log(`[control] Recovery refused on index ${o.index} (${o.alias}): adapter identity unavailable`);
            continue;
          }
          if (o.guid && (!hw.guid || hw.guid.toLowerCase() !== o.guid.toLowerCase())) {
            verifyErrors.push(`Recovery refused on index ${o.index} (${o.alias}): GUID mismatch (expected ${o.guid}, actual ${hw.guid || 'null'})`);
            this.log(`[control] Recovery refused on index ${o.index} (${o.alias}): GUID mismatch`);
            continue;
          }
          if (o.mac && hw.mac && hw.mac.toLowerCase() !== o.mac.toLowerCase()) {
            verifyErrors.push(`Recovery refused on index ${o.index} (${o.alias}): MAC mismatch (expected ${o.mac}, actual ${hw.mac})`);
            this.log(`[control] Recovery refused on index ${o.index} (${o.alias}): MAC mismatch`);
            continue;
          }

          try {
            await this.#setMetric(o.index, o.metric, o.autoMetric);
            restoredCount++;
          } catch (e) {
            verifyErrors.push(`Failed to set metric on index ${o.index}: ${e.message}`);
            this.log(`[control] restore metric failed for index ${o.index}: ${e.message}`);
          }
        }

        // 2. Remove pinned probe routes and independently verify absence (FAIL-CLOSED)
        for (const p of st.pinned) {
          const targetIp = p.ip || (p.prefix ? p.prefix.split('/')[0] : null);
          if (!targetIp || !p.index) {
            verifyErrors.push(`Invalid route record in state: missing target IP or interface index`);
            continue;
          }

          // Validate adapter identity if recorded
          if (p.guid || p.mac) {
            const hw = await this.queryAdapterIdentity(p.index).catch(() => null);
            if (!hw) {
              verifyErrors.push(`Route cleanup refused for ${targetIp}/32 on index ${p.index}: adapter identity query failed`);
              continue;
            }
            if (p.guid && (!hw.guid || hw.guid.toLowerCase() !== p.guid.toLowerCase())) {
              verifyErrors.push(`Route cleanup refused for ${targetIp}/32 on index ${p.index}: GUID mismatch (expected ${p.guid}, actual ${hw.guid || 'null'})`);
              continue;
            }
            if (p.mac && hw.mac && hw.mac.toLowerCase() !== p.mac.toLowerCase()) {
              verifyErrors.push(`Route cleanup refused for ${targetIp}/32 on index ${p.index}: MAC mismatch (expected ${p.mac}, actual ${hw.mac})`);
              continue;
            }
          }

          // Query routes with fail-closed check
          let existingRoutes;
          try {
            existingRoutes = await this.queryRoute(targetIp);
          } catch (qErr) {
            verifyErrors.push(`Route query failed for ${targetIp}/32: ${qErr.message}`);
            continue;
          }

          if (existingRoutes === null || !Array.isArray(existingRoutes)) {
            verifyErrors.push(`Route query returned unverifiable result for ${targetIp}/32`);
            continue;
          }

          if (existingRoutes.length === 0) {
            // Route already absent
            continue;
          }

          // Verify exact owned route identity (NEVER destination-only)
          const matches = existingRoutes.filter((r) => {
            const ifMatch = Number(r.InterfaceIndex) === Number(p.index);
            const gwMatch = !p.gateway || !r.NextHop || r.NextHop === p.gateway;
            const prefixMatch = r.DestinationPrefix === `${targetIp}/32`;
            return ifMatch && gwMatch && prefixMatch;
          });

          if (matches.length === 0) {
            this.log(`[control] Skipping unrelated route for ${targetIp}/32 during recovery (no owned match)`);
            continue;
          }
          if (matches.length > 1) {
            verifyErrors.push(`Route ownership ambiguous for ${targetIp}/32: multiple matching routes found on index ${p.index}`);
            continue;
          }

          const match = matches[0];
          let removeCmd = `Remove-NetRoute -DestinationPrefix "${ip4(targetIp)}/32" -InterfaceIndex ${match.InterfaceIndex}`;
          if (match.NextHop && match.NextHop !== '0.0.0.0') {
            removeCmd += ` -NextHop "${match.NextHop}"`;
          }
          removeCmd += ` -Confirm:$false -ErrorAction SilentlyContinue`;
          await this.runPs(removeCmd).catch(() => {});

          // Independent verification: confirm route is absent
          const remaining = await this.queryRoute(targetIp).catch(() => null);
          if (remaining && remaining.some((r) => Number(r.InterfaceIndex) === Number(p.index))) {
            verifyErrors.push(`Route ${targetIp}/32 still present in routing table on interface ${p.index} after recovery cleanup`);
          }
        }

        // 3. Independently verify the restored configuration
        for (const o of st.originals) {
          if (isVirtualOrExcluded(o.alias || '', '')) continue;
          try {
            const cur = await this.queryInterface(o.index);
            if (cur) {
              const autoMatches = cur.autoMetric === !!o.autoMetric;
              const metricMatches = o.autoMetric ? true : cur.metric === o.metric;
              if (!autoMatches || !metricMatches) {
                verifyErrors.push(
                  `Verification mismatch on index ${o.index}: expected metric=${o.metric} auto=${o.autoMetric}, got metric=${cur.metric} auto=${cur.autoMetric}`
                );
              }
            }
          } catch (qErr) {
            verifyErrors.push(`Verification query failed on index ${o.index}: ${qErr.message}`);
          }
        }

        // 4. Delete state file ONLY if independently verified
        if (verifyErrors.length === 0) {
          try {
            fs.unlinkSync(this.stateFile);
            this.log(`[control] State file verified and removed (${why})`);
          } catch { /* already gone */ }
        } else {
          this.log(
            `[control] WARNING: State file NOT removed because recovery verification failed: ${verifyErrors.join('; ')}`
          );
        }
      }

      this.log(`[control] restore (${why}): ${restoredCount} metrics, verified=${verifyErrors.length === 0}`);
      return {
        restored: restoredCount,
        verified: verifyErrors.length === 0,
        verifyErrors,
      };
    } finally {
      this.lock = false;
    }
  }

  restoreAll() {
    return this.restoreFromStateFile('manual');
  }
}
