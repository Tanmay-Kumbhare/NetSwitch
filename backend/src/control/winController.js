import fs from 'node:fs';
import path from 'node:path';
import { runPs as defaultRunPs, int, ip4 } from '../windows/ps.js';
import { discoverWindows, isVirtualOrExcluded } from '../windows/discovery.js';
import { connectUnbound as defaultConnectUnbound } from '../probes/tcp.js';

export class WinController {
  constructor({
    stateFile,
    cfg,
    log = console.log,
    runPs = defaultRunPs,
    connectUnbound = defaultConnectUnbound,
  } = {}) {
    this.stateFile = stateFile;
    this.cfg = cfg;
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
    await this.restoreFromStateFile('startup'); // Recover from any previous crash
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

  // ---- route pinning ----

  async pin(adapter, targets) {
    if (!this.canControl) throw new Error('not administrator');
    this.assertEligible(adapter);
    int(adapter.index, 1, 100000);
    ip4(adapter.gateway);

    for (const t of targets) {
      ip4(t);
      // Persist intent before executing OS modification
      const st = this.#read();
      st.pinned = st.pinned.filter((p) => p.ip !== t).concat({
        ip: t,
        index: adapter.index,
        gateway: adapter.gateway,
      });
      this.#write(st);

      await this.runPs(
        `Remove-NetRoute -DestinationPrefix "${t}/32" -Confirm:$false -ErrorAction SilentlyContinue`
      ).catch(() => {});
      await this.runPs(
        `New-NetRoute -DestinationPrefix "${t}/32" -InterfaceIndex ${adapter.index} -NextHop "${adapter.gateway}" -PolicyStore ActiveStore -ErrorAction Stop | Out-Null`
      );
    }
  }

  async unpin(targets) {
    for (const t of targets) {
      ip4(t);
      await this.runPs(
        `Remove-NetRoute -DestinationPrefix "${t}/32" -Confirm:$false -ErrorAction SilentlyContinue`
      ).catch(() => {});
      const st = this.#read();
      st.pinned = st.pinned.filter((p) => p.ip !== t);
      this.#write(st);
    }
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

      // Filter only managed eligible physical adapters
      const managed = adapters.filter(
        (a) =>
          (a.kind === 'wifi' || a.kind === 'usb') &&
          !isVirtualOrExcluded(a.description || '', a.alias || '') &&
          a.up !== false
      );

      // Snapshot original configurations before any modification
      const st = this.#read();
      for (const a of managed) {
        if (!st.originals.find((o) => o.index === a.index)) {
          st.originals.push({
            index: a.index,
            alias: a.alias,
            metric: a.currentMetric ?? a.metric,
            autoMetric: !!a.autoMetric,
          });
        }
      }
      this.#write(st);

      // Record exact previous state for rollback
      const previous = managed.map((a) => ({
        index: a.index,
        metric: a.currentMetric ?? a.metric,
        autoMetric: !!a.autoMetric,
      }));

      // Modification loop with tracking for reverse-order rollback
      const modifiedStack = [];
      let modificationError = null;

      for (const a of managed) {
        const desiredMetric = a.id === id ? this.cfg.activeMetric : this.cfg.standbyMetric;
        const prev = previous.find((p) => p.index === a.index);
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

      let restoredCount = 0;
      const verifyErrors = [];

      if (this.canControl) {
        // 1. Restore metrics for managed physical interfaces only
        for (const o of st.originals) {
          if (isVirtualOrExcluded(o.alias || '', '')) {
            this.log(`[control] Skipping virtual adapter in recovery: ${o.alias} (index ${o.index})`);
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

        // 2. Remove pinned probe routes
        for (const p of st.pinned) {
          try {
            await this.runPs(
              `Remove-NetRoute -DestinationPrefix "${ip4(p.ip)}/32" -Confirm:$false -ErrorAction SilentlyContinue`
            ).catch(() => {});
          } catch { /* ignore route removal error */ }
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
