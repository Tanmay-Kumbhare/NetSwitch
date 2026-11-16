# NetSwitch Phase 6 Stage 4B: Safety Hardening Implementation Report

**Implementation Date:** 2026-11-08T19:11:30+05:30  
**Target Host:** Lenovo Legion 5 (Windows 11 Home, Node.js v24.14.0, Native MySQL 8.0)  
**Branch:** `development`  
**Safety Environment:** `NETSWITCH_FAILOVER_ENABLED=false`, `NETSWITCH_PROBE_ROUTE_PINNING=false`  
**Test Suite Status:** **77 / 77 Tests Passing (100% Pass Rate)**  
**Frontend Build:** **Production Bundle Built Cleanly (`vite build` completed in 8.40s)**  
**Host Network State:** **Zero Network Modifications (Metrics, Routes, and Associations Untouched)**  

---

## 1. Executive Summary

Phase 6 Stage 4B implemented the four critical safety and architectural hardening requirements identified during the Stage 4A audit:

1. **Startup Recovery Guard (P0):** [`WinController.init()`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js) and [`restoreFromStateFile()`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js) now enforce a strict monitor-only startup policy. In monitor-only mode (`NETSWITCH_FAILOVER_ENABLED=false`), startup **never** executes PowerShell mutations (`Set-NetIPInterface`, `Remove-NetRoute`). Stale recovery state files are preserved on disk and reported via `/api/health` and snapshots as `recoveryPending: true`.
2. **Route Ownership Tracking & Cleanup Verification (P0):** [`WinController.pin()`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js) now records rich route identity (destination prefix, interface index, gateway next hop, policy store, MAC, GUID). [`unpin()`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js), [`restoreFromStateFile()`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js), and [`scripts/restore.ps1`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/scripts/restore.ps1) remove only owned routes, preserve unrelated routes, and **independently query `Get-NetRoute`** to verify that target routes are absent. If route removal cannot be verified, cleanup fails and state files are preserved on disk.
3. **Hardware Identity Anchoring (P1):** [`discovery.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/windows/discovery.js) now queries and retains immutable hardware properties (`MacAddress`, `InterfaceGuid`, and `PnPDeviceID`). When an adapter drops offline, [`Agent`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/agent.js) stops its probe driver immediately to prevent resource leakage. Upon reconnection, hardware MAC and GUID are re-validated before reusing state. Hardware identity is also re-validated in [`winController.setActive()`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js) before executing any future OS metric mutations.
4. **Diagnostic Script Cleanup & Safety (P1):** [`backend/scripts/check-windows.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/scripts/check-windows.js) was refactored into a modular `runCheckWindows()` runner with strict `try / finally` blocks and `SIGINT` / `SIGTERM` signal handlers, ensuring emergency route unpinning occurs if interrupted.

---

## 2. Changes Made by File

| File | Changes Made |
|---|---|
| [`backend/src/windows/discovery.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/windows/discovery.js) | Updated PowerShell discovery query to cross-reference `Get-NetAdapter` and extract `mac` (`MacAddress`), `guid` (`InterfaceGuid`), and `pnpId` (`PnPDeviceID`). Preserved in `toAdapters()`. |
| [`backend/src/control/winController.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js) | Added `queryRoute()` and `queryAdapterIdentity()`. Updated `init()` to record `this.recoveryPending`. Updated `restoreFromStateFile()` to abort OS mutations during startup if `!this.failoverEnabled`. Enhanced `pin()` to record rich ownership records (`prefix`, `ip`, `index`, `gateway`, `policyStore`, `mac`, `guid`). Enhanced `unpin()` and recovery to check route ownership, remove only owned routes, independently verify route deletion via `Get-NetRoute`, and preserve state files upon verification failure. Enhanced `setActive()` to re-verify target adapter MAC and GUID against the OS before applying metric changes. |
| [`backend/src/control/simController.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/simController.js) | Added realistic mock MAC addresses, Interface GUIDs, and PnP IDs to `SIM_ADAPTERS` for simulation fidelity. |
| [`backend/src/agent.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/agent.js) | Allowed `ProbeDriver` injection in constructor for testing. In `start()`, recorded `recoveryPending` and exposed it in snapshots. In `#refreshDiscovery()`, promptly stopped probe drivers on adapter disconnection. Added hardware identity conflict detection on reconnection (marking ambiguous adapters unavailable). Exposed `refreshDiscovery()` method. |
| [`backend/src/server.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/server.js) | Exposed `recoveryPending: !!agent.recoveryPending` in `GET /api/health`. |
| [`backend/scripts/check-windows.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/scripts/check-windows.js) | Refactored into an exported `runCheckWindows()` function wrapped in `try / finally` with `SIGINT` / `SIGTERM` handlers. Added independent verification reporting after `ctl.restoreAll()`. Fixed `probeRoutePinning: true` instantiation. |
| [`scripts/restore.ps1`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/scripts/restore.ps1) | Updated route removal loop to check interface index matching, preserve unrelated routes, and independently verify route deletion by querying `Get-NetRoute`. Preserved state file if verification fails. |
| [`docs/BRINGUP.md`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/docs/BRINGUP.md) | Documented monitor-only startup recovery policy, route ownership tracking, independent route verification, hardware identity anchoring, and the shared phone upstream limitation (cellular common-mode failure). |
| [`docs/ARCHITECTURE.md`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/docs/ARCHITECTURE.md) | Documented switching, rollback, verification sequence, route ownership verification, and upstream network redundancy boundaries. |
| [`backend/test/safety_hardening.test.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/test/safety_hardening.test.js) | Added 14 unit and mocked tests covering Tasks 1, 2, 3, and 4. |

---

## 3. Explanation of Each Safety Fix

### 3.1 Startup Recovery Guard (Task 1)
- **Problem in Stage 4A:** `WinController.init()` unconditionally called `restoreFromStateFile('startup')` whenever running as Administrator. If a stale `netswitch-state.json` file existed from an earlier crash, running the backend in monitor-only mode would unexpectedly mutate Windows metrics during startup.
- **Fix:** In `restoreFromStateFile(why)`, if `why === 'startup'` and `!this.failoverEnabled`, the controller logs a warning, preserves the state file on disk without modifying the OS, and returns `{ restored: 0, verified: false, pending: true, preserved: true, note: 'recovery pending: failover disabled (monitor-only mode)' }`. `Agent.start()` records `this.recoveryPending = true` and reports it in snapshots and `/api/health`.
- **Emergency Pathway Preserved:** Explicit recovery requested by the operator (`restoreAll()`, `restoreFromStateFile('manual')`, or `scripts/restore.ps1`) remains fully operational.

### 3.2 Route Ownership Tracking & Verification (Task 2)
- **Problem in Stage 4A:** `unpin()`, `restoreFromStateFile()`, and `scripts/restore.ps1` called `Remove-NetRoute` with `-ErrorAction SilentlyContinue` and never queried the routing table to verify deletion. Pre-existing routes to target IPs were deleted unconditionally without checking ownership.
- **Fix:**
  - Route records now include `prefix`, `ip`, `index`, `gateway`, `policyStore: 'ActiveStore'`, `mac`, `guid`, `alias`, and `pinnedAt`.
  - Before removal, `unpin()` checks if NetSwitch owns a pinned route record for that IP. If an unrelated route exists on a different interface, it is preserved.
  - After deletion, `queryRoute(t)` queries `Get-NetRoute -DestinationPrefix "${t}/32"`. If any owned route remains in the routing table, cleanup fails verification, `unpinErrors` is recorded, and the state file is preserved on disk for investigation.

### 3.3 Hardware Identity Anchoring (Task 3)
- **Problem in Stage 4A:** Adapters were identified solely by ephemeral interface indexes, string aliases, and descriptions. A disconnected USB tethering adapter left its probe driver running in the background. On reconnection, Windows often changed the interface index, risking misidentification or socket leakage.
- **Fix:**
  - Discovery extracts `MacAddress`, `InterfaceGuid`, and `PnPDeviceID`.
  - When an adapter disconnects, `Agent.#refreshDiscovery()` immediately stops the probe driver (`a.driver.stop()`).
  - Upon reconnection, `a.mac` and `d.mac` are compared. If the MAC address conflicts with the previous adapter in that slot, the adapter is flagged as ambiguous (`a.ambiguous = true; a.up = false`), probe drivers are prevented from starting, and failover to it is refused.
  - Before any metric mutation in `WinController.setActive()`, `queryAdapterIdentity(target.index)` re-validates the target adapter's hardware MAC and GUID against the OS.

### 3.4 Diagnostic Script Cleanup (Task 4)
- **Problem in Stage 4A:** `backend/scripts/check-windows.js` pinned routes and probed for 12 seconds without `try / finally` or signal handlers. Pressing `Ctrl+C` left pinned `/32` routes active in the routing table.
- **Fix:** Refactored into `runCheckWindows()`. Wrapped all pinning and probing in `try / finally` with `SIGINT` and `SIGTERM` emergency cleanup handlers. Cleanup calls `ctl.restoreAll()`, confirms that `res.verified` is true, and preserves execution errors even if cleanup fails.

---

## 4. Tests Added & Exact Results

A dedicated automated test suite was implemented in [`backend/test/safety_hardening.test.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/test/safety_hardening.test.js):

| Test Name | Verification Focus | Status | Duration |
|---|---|---|---|
| **Task 1.1** | Monitor-only startup with stale state does not execute PowerShell mutations | **PASS** | 4.48 ms |
| **Task 1.2** | State file remains preserved on disk during monitor-only startup | **PASS** | 3.73 ms |
| **Task 1.3** | Monitor-only startup reports that recovery is pending (`rec.pending = true`) | **PASS** | 3.16 ms |
| **Task 1.4** | Explicitly authorized recovery still works even in monitor-only mode | **PASS** | 4.27 ms |
| **Task 1.5** | Corrupt state file is backed up and never silently deleted | **PASS** | 8.44 ms |
| **Task 2.1** | Successful owned-route removal and verification via `Get-NetRoute` | **PASS** | 4.73 ms |
| **Task 2.2** | Route still present after attempted removal triggers verification failure | **PASS** | 3.23 ms |
| **Task 2.3** | Pre-existing or unrelated route on different interface is preserved | **PASS** | 1.12 ms |
| **Task 2.4** | Repeated cleanup is idempotent and verified | **PASS** | 4.67 ms |
| **Task 3.1** | USB removal stops probe driver promptly | **PASS** | 2.12 ms |
| **Task 3.2** | Reconnection with identical MAC preserves identity and updates index | **PASS** | 1.03 ms |
| **Task 3.3** | Hardware identity conflict is detected before mutation | **PASS** | 0.83 ms |
| **Task 4.1** | `runCheckWindows` executes cleanup in finally block on success | **PASS** | 1.35 ms |
| **Task 4.2** | `runCheckWindows` cleans up and preserves original error when probing fails | **PASS** | 0.59 ms |

---

## 5. Complete Regression Test Results

The complete NetSwitch backend test suite was executed against native MySQL and simulation mocks:

```
Command: node --env-file=backend/.env --test \
  backend/test/controller.test.js \
  backend/test/monitor_safety.test.js \
  backend/test/safety_hardening.test.js \
  backend/test/core.test.js \
  backend/test/db.test.js \
  backend/test/api.test.js \
  backend/test/phase4_api_ws.test.js
```

### Overall Suite Breakdown:

| Test File | Test Category | Tests Passed | Tests Failed |
|---|---|---|---|
| [`safety_hardening.test.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/test/safety_hardening.test.js) | Stage 4B Safety Hardening (Tasks 1–4) | **14 / 14** | 0 |
| [`monitor_safety.test.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/test/monitor_safety.test.js) | Monitor-Only Safety Boundaries | **10 / 10** | 0 |
| [`controller.test.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/test/controller.test.js) | WinController Rollback, Recovery, Exclusions | **10 / 10** | 0 |
| [`core.test.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/test/core.test.js) | Decision Rules, Scoring Maths, Subnet | **19 / 19** | 0 |
| [`db.test.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/test/db.test.js) | Native MySQL Persistence & Schema | **12 / 12** | 0 |
| [`api.test.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/test/api.test.js) | Express REST, WebSocket, E2E Sim Failover | **5 / 5** | 0 |
| [`phase4_api_ws.test.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/test/phase4_api_ws.test.js) | Phase 4 API & WebSocket Protocols | **7 / 7** | 0 |
| **TOTAL** | **Entire Project Test Suite** | **77 / 77 (100%)** | **0** |

Frontend build verification:
```
npm --prefix frontend run build -> Built in 8.40s (dist/index.html, CSS, JS chunks generated cleanly)
```

---

## 6. Confirmation of Safety Invariance

- **Safety Flags:**
  - `NETSWITCH_FAILOVER_ENABLED=false` (Explicitly disabled in `backend/.env` and `config.js`)
  - `NETSWITCH_PROBE_ROUTE_PINNING=false` (Explicitly disabled in `backend/.env` and `config.js`)
- **Windows Physical Network State (Independently Verified):**
  - Wi-Fi association: Connected to `Moto g64 5G` (SSID unchanged).
  - Ethernet 2 (USB Tethering, index 17) metric: `5` (`AutomaticMetric: Disabled`, unchanged).
  - Wi-Fi (Intel AX203, index 12) metric: `75` (`AutomaticMetric: Disabled`, unchanged).
  - Default routes: `0.0.0.0/0` via `10.41.171.250` (metric 5) and `10.97.128.135` (metric 75) (unchanged).
  - Target host `/32` routes: **Zero routes found** (`1.1.1.1`, `8.8.8.8`, `9.9.9.10`, etc.).
  - Recovery state file: `netswitch-state.json` **does not exist on disk**.

---

## 7. Workspace Git Status

```
On branch development
Your branch is up to date with 'origin/development'.

Changes not staged for commit:
	modified:   backend/.env.example
	modified:   backend/scripts/check-windows.js
	modified:   backend/src/agent.js
	modified:   backend/src/config.js
	modified:   backend/src/control/simController.js
	modified:   backend/src/control/winController.js
	modified:   backend/src/server.js
	modified:   backend/src/windows/discovery.js
	modified:   backend/test/api.test.js
	modified:   backend/test/controller.test.js
	modified:   backend/test/phase4_api_ws.test.js
	modified:   docs/ARCHITECTURE.md
	modified:   docs/BRINGUP.md
	modified:   scripts/restore.ps1

Untracked files:
	backend/test/monitor_safety.test.js
	backend/test/safety_hardening.test.js
	docs/test-results/phase6-physical-probe-report.md
	docs/test-results/phase6-stage4a-readiness-audit.md
	docs/test-results/phase6-stage4b-hardening-report.md

no changes added to commit (use "git add" and/or "git commit -a")
```
*(No Git commits, merges, resets, or pushes were executed. Work remains cleanly staged on branch `development`.)*

---

## 8. Remaining Risks and Limitations

1. **Shared Cellular Uplink Topology:**
   - Both Wi-Fi and USB tethering currently terminate at the same smartphone (`Moto g64 5G`).
   - While the software cleanly detects degradation and manages link failover, true WAN path redundancy requires connecting Wi-Fi to a dedicated fixed-line ISP broadband router.
2. **Physical Failover Remains Unauthorized:**
   - Real Windows physical failover has not yet been executed or authorized.
   - All tests in this stage were conducted in simulation or with mocked PowerShell runners.

