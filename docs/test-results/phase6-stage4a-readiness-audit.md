# NetSwitch Phase 6 Stage 4A: Read-Only Architecture & Physical Failover Safety Audit

**Audit Date:** 2026-11-08T18:55:00+05:30  
**Target Environment:** Lenovo Legion 5 (Windows 11 Home, Node.js v24.14.0, Native MySQL 8.0)  
**Hardware Interfaces Inspected:**
- Wi-Fi: Intel(R) Wi-Fi 6 AX203 160MHz (Interface Index 12, `10.97.128.167/24`, Gateway `10.97.128.135`)
- USB Tethering: Remote NDIS based Internet Sharing Device (`Ethernet 2`, Interface Index 17, `10.41.171.54/24`, Gateway `10.41.171.250`)
- Shared Upstream: Moto g64 5G smartphone cellular uplink (single common-mode upstream provider)
**Audit Type:** Strictly Read-Only Architecture, Safety Boundary, and Transaction Audit  
**Codebase Branch:** `development`  
**Current Safety Status:** `NETSWITCH_FAILOVER_ENABLED=false`, `NETSWITCH_PROBE_ROUTE_PINNING=false`  
**Executive Verdict:** **CONDITIONAL PASS — PHYSICAL FAILOVER NOT READY**

---

## 1. Executive Summary

This audit evaluated the readiness of the NetSwitch architecture, Windows controller, recovery mechanisms, route management, and test suite for a future physical interface failover test.

The audit confirmed that the explicit monitor-only architecture implemented in Phase 6 Stage 2 is **100% robust and impermeable**: neither automatic evaluation loops, manual API requests, direct controller invocations, nor runtime configuration updates can trigger a Windows network mutation while `NETSWITCH_FAILOVER_ENABLED=false`. Furthermore, the transaction rollback architecture in [`winController.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js) features proper reverse-order rollback, atomic state persistence, and independent metric verification.

However, physical failover is **NOT YET READY** for execution on physical hardware due to four specific safety and architectural gaps identified during this inspection:
1. **Unverified Route Cleanup:** Route unpinning (`unpin()`) and recovery scripts issue `Remove-NetRoute` with `-ErrorAction SilentlyContinue` but never independently verify route absence using `Get-NetRoute`.
2. **Volatile Adapter Identity:** Discovery relies solely on transient interface indexes, string aliases, and descriptions. It does not extract or anchor against immutable hardware properties (MAC address, Interface GUID, or PnP Device ID), introducing risks if a USB device is reconnected under a different index or if multiple USB adapters are attached.
3. **Unconditional Startup Recovery:** `WinController.init()` automatically restores metrics from `netswitch-state.json` on startup without checking `NETSWITCH_FAILOVER_ENABLED`, creating a latent mutation vector if a stale state file exists in monitor-only mode.
4. **Undocumented Common-Mode Upstream:** Project documentation (`BRINGUP.md`, `ARCHITECTURE.md`, `README.md`) does not document that both physical laptop interfaces terminate at the same phone, sharing the same cellular uplink and failing simultaneously upon WAN outage.

---

## 2. Components & Files Inspected

| Component | Files Inspected |
|---|---|
| **Discovery & Identity** | [`backend/src/windows/discovery.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/windows/discovery.js), [`backend/src/agent.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/agent.js) |
| **Windows Controller & State** | [`backend/src/control/winController.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js), [`backend/src/control/simController.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/simController.js) |
| **Probing & Sockets** | [`backend/src/probes/driver.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/probes/driver.js), [`backend/src/probes/udp.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/probes/udp.js), [`backend/src/probes/tcp.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/probes/tcp.js), [`backend/src/probes/icmp.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/probes/icmp.js) |
| **Diagnostics & Recovery** | [`backend/scripts/check-windows.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/scripts/check-windows.js), [`restore.ps1`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/restore.ps1), [`scripts/restore.ps1`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/scripts/restore.ps1) |
| **Configuration & Safety** | [`backend/src/config.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/config.js), [`backend/.env.example`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/.env.example), [`backend/.env`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/.env) |
| **API & Server Surface** | [`backend/src/server.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/server.js) |
| **Automated Tests** | [`backend/test/controller.test.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/test/controller.test.js), [`backend/test/monitor_safety.test.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/test/monitor_safety.test.js), [`backend/test/core.test.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/test/core.test.js) |
| **Project Documentation** | [`docs/BRINGUP.md`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/docs/BRINGUP.md), [`docs/ARCHITECTURE.md`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/docs/ARCHITECTURE.md), [`README.md`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/README.md) |

---

## 3. Findings by Audit Area

### Area 1: Adapter Discovery and Identity — Verdict: PARTIAL

1. **Virtual & VMware Exclusion (`PASS`):**
   - [`discovery.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/windows/discovery.js) applies a dual-layer filter: the PowerShell query filters `InterfaceAlias` and `InterfaceDescription` against `VMware|VMnet|VirtualBox|vEthernet|Hyper-V|Loopback`, and `isVirtualOrExcluded()` applies regular expression filtering covering `Npcap`, `TAP-`, `VPN`, `Tailscale`, `WireGuard`, and `Bluetooth`.
   - [`WinController.assertEligible()`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L46-L56) throws a hard exception if an adapter description or alias matches virtual adapters.
   - Tested by Tests 7 & 8 in `controller.test.js`.

2. **USB Disconnection and Stale Adapter References (`PARTIAL`):**
   - In [`agent.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/agent.js#L95-L120) (`#refreshDiscovery()`), when a USB adapter is unplugged, it is omitted from `discover()`. `foundIds` does not contain `'usb'`, and the agent sets `a.up = false`.
   - **Gap:** When an adapter goes down, its `RealProbeDriver` is **not stopped immediately**. The background timers continue firing UDP, TCP, and ICMP probes against the disconnected interface IP until re-discovery detects an address/index change upon reconnection or the process is stopped.

3. **Dynamic Reconnection & Index Changes (`PARTIAL`):**
   - If the USB tethering connection is re-established, Windows frequently allocates a new interface index (e.g. index 17 becomes 22) and potentially a new local IP.
   - In [`agent.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/agent.js#L103-L110):
     ```javascript
     if (a.ip !== d.ip || a.gateway !== d.gateway || a.index !== d.index) {
       a.driver.stop();
       if (this.probeRoutePinning && this.canControl) {
         await this.controller.unpin(this.#targets(a)).catch(() => {});
       }
       this.adapters.delete(d.id);
       await this.#addAdapter(d);
     }
     ```
   - The agent detects the index/IP delta, stops the old driver, unpins old routes, deletes the adapter entry, and re-adds the new adapter.
   - **Gap:** The teardown and unpinning occur only *after* the new adapter is plugged in, not at the moment of disconnection.

4. **Hardware Identity Validation (`FAIL`):**
   - [`discovery.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/windows/discovery.js#L11-L15) queries only: `alias`, `index`, `description`, `ip`, `prefix`, `gateway`, `metric`, `autoMetric`.
   - It **does not extract** `MACAddress`, `InterfaceGuid`, or `PnPDeviceID` from `Get-NetIPConfiguration` / `Get-NetAdapter`.
   - Identifier assignment in `toAdapters()` relies on `classify()` and array position (`id = seen[kind] > 1 ? `${kind}${r.index}` : kind`).
   - If a second USB network interface (e.g. a USB-to-Ethernet dongle) is attached while the phone is disconnected, it will be assigned `id: 'usb'`, inheriting the configuration slot of the phone tether.

---

### Area 2: Route Pinning and Cleanup — Verdict: PARTIAL

1. **State Snapshot & Pre-Mutation Tracking (`PASS`):**
   - In [`winController.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L148-L154) (`pin()`), route intent is recorded in `netswitch-state.json` (`st.pinned`) *prior* to executing `New-NetRoute`.
   - Route creation specifies `-PolicyStore ActiveStore`, ensuring routes reside in memory only and cannot survive a Windows system reboot.

2. **Pre-Existing Route Protection (`PARTIAL`):**
   - `pin()` unconditionally issues `Remove-NetRoute -DestinationPrefix "${t}/32"` before creating the route.
   - If the host machine had a pre-existing `/32` route to any target address (`1.1.1.1`, `8.8.8.8`, etc.) before NetSwitch started, that pre-existing route is destroyed without recording original ownership.

3. **Behavior After Index Changes (`PASS`):**
   - `unpin()` and cleanup scripts remove routes by `DestinationPrefix` (`"${t}/32"`) without specifying `-InterfaceIndex`. This successfully removes orphaned routes even if the adapter index has changed.

4. **Independent Verification of Route Removal (`FAIL`):**
   - Neither [`unpin()`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L165-L175), [`restoreFromStateFile()`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L364-L372), nor [`scripts/restore.ps1`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/scripts/restore.ps1#L75-L89) verifies that routes were successfully removed.
   - All three execute `Remove-NetRoute` with `-ErrorAction SilentlyContinue` and assume deletion succeeded. None issue `Get-NetRoute -DestinationPrefix "${t}/32"` to independently confirm that the route table is clean.

5. **Diagnostic Script Safety (`PARTIAL`):**
   - [`backend/scripts/check-windows.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/scripts/check-windows.js) pins routes and probes for 12 seconds, then calls `ctl.restoreAll()` at line 37.
   - **Gap:** `check-windows.js` lacks a `try / finally` block and contains no `SIGINT` / `SIGTERM` handlers. If the user presses `Ctrl+C` during the 12-second probe window, the script terminates immediately without running `restoreAll()`, leaving pinned `/32` routes active in the Windows routing table until `restore.ps1` is run manually.

---

### Area 3: Failover Transaction and Rollback — Verdict: PASS

1. **State Snapshot Prior to Mutation (`PASS`):**
   - In [`winController.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L251-L263) (`setActive()`), original metrics and `AutomaticMetric` states for all managed adapters are read and committed to `netswitch-state.json` via atomic file write (`.tmp` + rename) before any `Set-NetIPInterface` command is issued.

2. **Transaction Ordering & Reverse-Order Rollback (`PASS`):**
   - In [`winController.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L273-L300), each adapter metric mutation is pushed to `modifiedStack`.
   - If an error occurs on any adapter, the modification loop halts immediately, and `#rollback(modifiedStack)` reverses the stack (`[...modifiedStack].reverse()`), restoring previously modified interfaces in exact reverse sequence. Tested by Tests 1 & 2 in `controller.test.js`.

3. **Independent Verification of Rollback State (`PASS`):**
   - `#rollback()` queries each reverted interface using `queryInterface(item.index)` (`Get-NetIPInterface`).
   - If the observed metric or `AutomaticMetric` does not match the target state, `verifyErrors` is populated and `rb.verified = false`.

4. **Verification of Egress Path Before Switch Confirmation (`PASS`):**
   - After applying metric changes, [`winController.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L303-L318) validates:
     1. `routeInterface('9.9.9.9')` returns the target adapter index (`Find-NetRoute`).
     2. An unbound TCP connect to `9.9.9.9:443` succeeds and its `localAddress` matches `target.ip`.
   - If verification fails, full reverse rollback is executed immediately, returning `{ ok: false, verified: false, rolledBack: true }`. Tested by Test 3 in `controller.test.js`.

5. **State File Retention on Failure (`PASS`):**
   - If rollback fails or cannot be verified, `netswitch-state.json` is preserved on disk to enable post-mortem recovery. Tested by Tests 4 & 6 in `controller.test.js`.

6. **Concurrency Locking (`PASS`):**
   - Both Agent (`this.switching`) and Controller (`this.lock`) enforce mutexes. Overlapping calls return `{ ok: false, busy: true, note: 'switch already in progress' }`. Tested by Test 10 in `controller.test.js`.

7. **Handling of Adapter Disappearance During Transaction (`PASS`):**
   - If an adapter drops offline mid-mutation, PowerShell fails, the mutation loop breaks, rollback restores all prior adapters, verification fails, and the state file is retained.

---

### Area 4: Startup Recovery — Verdict: PARTIAL

1. **Idempotence & State Preservation (`PASS`):**
   - [`restoreFromStateFile()`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L336-L414) safely handles empty or missing state files (`{ restored: 0, verified: true }`).
   - Multiple invocations produce the same final network state.
   - State file is unlinked (`fs.unlinkSync`) **only if** all interface metrics are independently verified by `queryInterface()`.

2. **Corrupted State File Protection (`PASS`):**
   - If `netswitch-state.json` contains malformed JSON, [`#read()`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L74-L83) creates a timestamped copy (`netswitch-state.json.corrupted.<timestamp>`) and logs a warning. The corrupt file is never overwritten. Tested by Test 5 in `controller.test.js`.

3. **Monitor-Only Startup Mutation Risk (`PARTIAL`):**
   - In [`winController.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L38) (`init()`):
     ```javascript
     await this.restoreFromStateFile('startup');
     ```
   - `init()` invokes recovery unconditionally whenever `this.canControl` is true (running as Administrator).
   - **Gap:** It does not check `if (!this.failoverEnabled)`. If an operator starts the backend in explicit monitor-only mode (`NETSWITCH_FAILOVER_ENABLED=false`) in an elevated shell, and a stale state file exists from an earlier crash, `init()` will attempt to modify Windows network metrics during startup without explicit user consent.

4. **Explicit User Recovery (`PASS`):**
   - Dedicated manual recovery is available via [`scripts/restore.ps1`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/scripts/restore.ps1). The dangerous `-AutoAll` flag has been disabled; recovery operates solely on managed adapters recorded in the state file.

---

### Area 5: Monitor-Only Safety — Verdict: PASS

1. **Configuration Defaults & Safe Parsing (`PASS`):**
   - [`config.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/config.js#L43-L61): `DEFAULTS.failoverEnabled = false`, `DEFAULTS.probeRoutePinning = false`.
   - `parseAppEnv()` defaults both flags to `false`. Missing or invalid environment strings resolve to `false`.

2. **Layered Defense-in-Depth (`PASS`):**
   - **REST API Boundary:** `POST /api/control/switch` throws `HTTP 422 Unprocessable Entity` when `!agent.failoverEnabled`.
   - **Agent Boundary:** `agent.#evaluate()` locks agent phase to `'MONITOR_ONLY'`; `agent.#doSwitch()` returns `{ ok: false }`; `agent.switchTo()` returns `{ ok: false }`.
   - **Controller Boundary:** `winController.setActive()` returns `{ ok: false, note: 'failover disabled by configuration (monitor-only mode)' }`; `winController.pin()` throws `'probe route pinning disabled by configuration'`.
   - **SimController Boundary:** Matches `winController` guards.

3. **Configuration Tamper Resistance (`PASS`):**
   - `PUT /api/config` restricts edits strictly to `EDITABLE` groups (`decide` and `score`). Safety flags cannot be modified via REST API.

4. **Empirical Verification (`PASS`):**
   - 10 automated safety boundary tests pass in [`backend/test/monitor_safety.test.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/test/monitor_safety.test.js).
   - Validated live in Phase 6 Stage 3B (browser test confirmed `POST /api/control/switch` returned HTTP 422, buttons remained disabled, and zero metric changes occurred).

---

### Area 6: Shared Upstream Limitation — Verdict: PARTIAL

1. **Hardware Independence vs Upstream Redundancy:**
   - Wi-Fi (Intel AX203 PCIe) and USB Tethering (Remote NDIS USB) represent two distinct physical network controllers on the laptop.
   - However, in the current validation testbed, both interfaces connect to the same smartphone (Moto g64 5G) and route through the same cellular carrier uplink.

2. **Demonstration Scope:**
   - **What this validates:** Physical network stack handling, local-link metric manipulation, Windows Weak Host routing behavior, multi-interface socket binding, degradation detection, and failover mechanics.
   - **What this does NOT validate:** Independent ISP or WAN path diversity. A carrier-level outage or cellular signal loss will impair both connections simultaneously (common-mode failure).

3. **Documentation Gaps (`FAIL`):**
   - Project documentation ([`BRINGUP.md`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/docs/BRINGUP.md), [`ARCHITECTURE.md`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/docs/ARCHITECTURE.md), [`README.md`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/README.md)) does not document this shared upstream topology.
   - Documentation must be updated to clearly state that local tethering tests validate link-level failover, whereas true WAN redundancy requires connecting Wi-Fi to a dedicated ISP router while USB tethering remains on cellular.

---

### Area 7: Test Coverage — Verdict: PARTIAL

1. **Existing Passing Test Coverage (30 Unit Tests in `backend/test/`):**
   - [`controller.test.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/test/controller.test.js) (10 tests):
     - Partial transaction failure & reverse-order rollback (Tests 1 & 2)
     - Verification failure handling (Test 3)
     - Rollback failure & lock release (Test 4)
     - Corrupted state file detection & backup (Test 5)
     - State file retention on failed recovery (Test 6)
     - VMware & virtual adapter exclusion (Tests 7 & 8)
     - Startup recovery from state file (Test 9)
     - Mutex locking against concurrent operations (Test 10)
   - [`monitor_safety.test.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/test/monitor_safety.test.js) (10 tests):
     - Agent, Controller, and API monitor-only guards (Tests 1–4)
     - Route pinning disabled boundaries & cleanup (Tests 5–7)
     - Privilege decoupling & non-admin behavior (Tests 8–10)
   - [`core.test.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/test/core.test.js) (10 decide tests):
     - Hysteresis, degradation counters, hold-down timer, hard failure, adapter down, switch-back.

2. **Missing Test Coverage (`NOT VERIFIED` / Required for Physical Failover):**
   - **T1: Dynamic USB Disconnection:** Test simulating adapter removal from `discover()`, asserting probe driver stops and `a.up` transitions cleanly.
   - **T2: Dynamic Reconnection with Index Shift:** Test simulating an adapter reconnecting under a new `InterfaceIndex` (e.g. 17 -> 22), verifying old route removal and new route binding.
   - **T3: Independent Route Verification:** Test verifying that unpinning confirms route deletion via `Get-NetRoute`.
   - **T4: Mid-Transaction Process Crash Simulation:** Test terminating execution between adapter 1 and adapter 2 metric updates, verifying recovery on subsequent startup.
   - **T5: Monitor-Only Startup Safety:** Test verifying that `init()` does not run metric restore if `NETSWITCH_FAILOVER_ENABLED=false`.
   - **T6: Dual Common-Mode Outage:** Integration test verifying that simultaneous degradation of both adapters transitions correctly to `NO_INTERNET` without thrashing.

---

## 4. Safety-Critical Issues

The following four issues represent safety or reliability risks that must be resolved prior to authorizing physical failover:

> [!CAUTION]
> **Issue 1: Unverified Route Removal**  
> `winController.unpin()`, `winController.restoreFromStateFile()`, and `scripts/restore.ps1` execute `Remove-NetRoute` with `-ErrorAction SilentlyContinue` but never query `Get-NetRoute` to verify that routes were actually deleted. If Windows fails to remove an active route, traffic to target DNS IPs (`1.1.1.1`, `8.8.8.8`) remains silently pinned to an offline or standby adapter.

> [!WARNING]
> **Issue 2: Volatile Interface Identification**  
> NetSwitch identifies adapters by string descriptions and transient interface indexes. If a USB tether is unplugged and reconnected, Windows may allocate a different index. If multiple USB network devices exist, index-based mapping can misidentify the target. Hardware MAC address, Interface GUID, or PnP Device ID must be queried and matched.

> [!WARNING]
> **Issue 3: Unconditional Startup Recovery in Monitor-Only Mode**  
> `WinController.init()` automatically calls `restoreFromStateFile('startup')` whenever running as Administrator, regardless of `NETSWITCH_FAILOVER_ENABLED`. If a state file was left behind from a previous session, starting the backend in monitor-only mode will unexpectedly execute `Set-NetIPInterface` on startup.

> [!NOTE]
> **Issue 4: Lack of Signal Handling in Diagnostic Script**  
> `backend/scripts/check-windows.js` pins routes and probes for 12 seconds without `try / finally` or `process.on('SIGINT')`. Interrupting `check-windows.js` leaves temporary routes in the Windows routing table.

---

## 5. Physical Failover Readiness Assessment

| Evaluation Dimension | Status | Notes |
|---|---|---|
| **Monitor-Only Boundaries** | **READY** | Impenetrable multi-layer guards prevent accidental switching |
| **Failover Transaction Logic** | **READY** | Reverse-order rollback and pre-mutation persistence verified |
| **Virtual Adapter Isolation** | **READY** | VMware, VirtualBox, and Hyper-V strictly excluded |
| **Route Cleanup Verification** | **NOT READY** | Route deletion is unverified; relies on silent continuation |
| **USB Hotplug & Reconnect** | **NOT READY** | Lacks hardware MAC/GUID anchoring; driver persists while unplugged |
| **Startup Safety Guarding** | **NOT READY** | Recovery in `init()` lacks `failoverEnabled` check |
| **Test Coverage Completeness** | **NOT READY** | Missing dynamic USB index change and mid-transaction crash tests |
| **WAN Redundancy Topology** | **NOT READY** | Upstream cellular connection is shared; common-mode failure domain |

---

## 6. Distinction Between Verified, Inferred, and Unverified Behavior

- **Verified (Direct Empirical / Test Evidence):**
  - Monitor-only mode blocks all switching paths (`/api/control/switch`, `#doSwitch`, `setActive`).
  - `Set-NetIPInterface` is never executed when `failoverEnabled=false`.
  - Transaction rollback executes in reverse order and verifies restored metrics via `Get-NetIPInterface`.
  - VMware (`VMnet1`, `VMnet8`) and virtual adapters are strictly excluded from all mutations.
  - Corrupted state files are backed up and never silently deleted.
- **Inferred (Code Inspection):**
  - An unplugged USB adapter leaves its probe driver running until reconnection or process stop.
  - A pre-existing `/32` route to `1.1.1.1` would be removed and replaced without saving pre-existing state.
  - `check-windows.js` interrupted with Ctrl+C will leave pinned routes in the routing table.
- **Unverified (Requires Testing in Next Stages):**
  - Behavior of Windows routing table when USB adapter index changes while routes are pinned.
  - Complete recovery behavior if host power is cut during active `Set-NetIPInterface` execution.
  - User experience and failover stability when Wi-Fi and USB are connected to genuinely distinct WAN providers.

---

## 7. Recommended Next Stages

### Stage 4B: Safety Architecture Hardening (Authorized Implementation Only)
1. Add explicit route absence verification (`Get-NetRoute`) to `winController.unpin()`, `restoreFromStateFile()`, and `scripts/restore.ps1`.
2. Anchor adapter identity using `MACAddress` and `InterfaceGuid` from `Get-NetIPConfiguration`.
3. Stop adapter probe drivers immediately upon disconnect in `#refreshDiscovery()`.
4. Wrap `check-windows.js` in `try / finally` with `SIGINT` cleanup handlers.
5. Guard `restoreFromStateFile('startup')` so it requires `failoverEnabled=true` or an explicit user flag.
6. Add unit tests for dynamic USB lifecycle, index shifts, and mid-transaction crash recovery.

### Stage 4C: Independent WAN Decoupling & Read-Only Audit
1. Connect Wi-Fi to a dedicated Wi-Fi AP / home broadband router.
2. Keep USB tethering on cellular.
3. Validate independent public IP egress (`curl -4 icanhazip.com` per interface) in read-only mode.
4. Document the multi-WAN architecture in [`docs/BRINGUP.md`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/docs/BRINGUP.md).

---

## 8. Audit Conclusion

Physical failover testing must remain **BLOCKED** until Stage 4B (safety hardening) and Stage 4C (independent WAN topology) are completed and authorized.

