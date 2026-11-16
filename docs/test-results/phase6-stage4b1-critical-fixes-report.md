# NetSwitch Phase 6 Stage 4B.1: Critical Safety Corrections Report

**Date:** 2026-11-08T19:30:00+05:30  
**Target Host:** Lenovo Legion 5 (Windows 11 Home, Node.js v24.14.0, Native MySQL 8.0)  
**Branch:** `development` (Clean working tree, zero commits, zero pushes)  
**Safety Environment:** `NETSWITCH_FAILOVER_ENABLED=false`, `NETSWITCH_PROBE_ROUTE_PINNING=false`  
**Backend Test Suite:** **89 / 89 Tests Passing (100% Pass Rate)**  
**Frontend Build:** **Production Bundle Built Cleanly (`vite build` in 7.06s)**  
**Host Network State:** **Zero Network Modifications (Metrics, Default Routes, and Routing Table Untouched)**  

---

## 1. Executive Summary

Phase 6 Stage 4B.1 addressed and resolved the critical safety and architectural gaps identified during the Stage 4B verification review. Specifically, NetSwitch's route management and hardware identity anchoring systems have been upgraded from permissive heuristics to a **strictly fail-closed, transaction-safe architecture**:

1. **Fail-Closed Route Ownership (Task 1, P0):** Every route deletion now requires positive ownership identification across destination prefix, interface index, gateway next hop, and hardware adapter identity (GUID and MAC). If route query fails, returns null, or yields ambiguous matches, deletion is aborted. All destination-only wildcard `Remove-NetRoute` commands in [`winController.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js) and [`scripts/restore.ps1`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/scripts/restore.ps1) have been permanently eradicated.
2. **Protect Pre-existing Routes (Task 2, P0):** [`pin()`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js) now queries the OS routing table *before* attempting creation. Blind route pre-deletion has been removed. If any pre-existing or unrelated route conflicts with the requested probe target, pinning is immediately aborted with an error, preserving the pre-existing route.
3. **Fail-Closed Hardware Identity Anchoring (Task 3, P0):** `InterfaceGuid` and `MacAddress` are now re-queried immediately before every single `Set-NetIPInterface` operation across `setActive()`, `#rollback()`, and `restoreFromStateFile()`. If identity query fails, returns null, lacks recorded GUID, or mismatches the hardware anchor, OS mutation is refused, the error is recorded, and the recovery state file is preserved on disk.
4. **Comprehensive Test Suite (Task 4):** 12 dedicated mocked tests were added asserting that no unsafe PowerShell mutation command (`Remove-NetRoute` or `Set-NetIPInterface`) is executed under failure or mismatch conditions. The total backend test suite expanded to **89 tests**, achieving a 100% pass rate.

---

## 2. Task 1: Fail-Closed Route Ownership (P0)

### Implementation Corrections

#### 1. In `unpin(targets, adapter)` ([`winController.js:209–309`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L209-L309))
- **Ownership Verification:** Verifies that NetSwitch recorded the route in `st.pinned`. If unowned, logs and skips.
- **Hardware Identity Cross-Check:** If `owned.guid` or `owned.mac` was recorded, calls `queryAdapterIdentity(owned.index)`. If query fails, returns null, or identity mismatches, aborts unpinning, records verification error, and leaves state file intact.
- **Fail-Closed Route Query:** Calls `this.queryRoute(t)`. If query throws or returns `null` or non-array, aborts cleanup and preserves route.
- **Exact Owned Route Match:** Filters existing routes requiring exact destination prefix, matching interface index, and matching gateway next hop (`r.NextHop === owned.gateway`).
- **Ambiguity Guard:** If more than one route matches, flags ownership ambiguity, logs warning, and skips deletion.
- **Exact Deletion Command:** Executes `Remove-NetRoute -DestinationPrefix "${t}/32" -InterfaceIndex ${match.InterfaceIndex}` with `-NextHop "${match.NextHop}"`. Zero destination-only commands exist.
- **Independent Absence Verification:** Re-queries `queryRoute(t)`. If the route is still present on `owned.index`, flags verification failure and leaves route in `st.pinned`.

#### 2. In `restoreFromStateFile(why)` ([`winController.js:639–709`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L639-L709))
- **Permanent Elimination of Destination-Only Deletion:** The previous fallback `Remove-NetRoute -DestinationPrefix "${ip4(targetIp)}/32" -Confirm:$false` has been completely deleted.
- **Identity & Gateway Verification:** Matches routes against recorded `p.index` and `p.gateway`, validates adapter GUID/MAC, rejects ambiguous matches, and independently verifies absence via `Get-NetRoute`.

#### 3. In `scripts/restore.ps1` ([`scripts/restore.ps1:75–124`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/scripts/restore.ps1#L75-L124))
- **Eradication of Blind Probe Route Deletions:** Removed global `$probeIps` loop and destination-only commands.
- **Fail-Closed Ownership Check:** Queries `Get-NetAdapter` to cross-check `InterfaceGuid` and `MacAddress` before unpinning.
- **NextHop Matching:** Filters routes matching `$p.gateway`. If multiple matches exist, warns of ambiguity and preserves routes.
- **No-State Safeguard:** If no state file exists, prints `"No state file found at $StateFile. Zero network changes made."` and executes zero PowerShell commands.

---

## 3. Task 2: Protect Pre-existing Routes (P0)

### Implementation Corrections in `pin()` ([`winController.js:175–249`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L175-L249))

1. **Pre-Creation Route Query:** Queries `this.queryRoute(t)` before any route creation.
2. **Conflict Detection & Abort:** If an existing route is found for `${t}/32` that was not created by the current NetSwitch transaction (different interface, different gateway, or absent from `st.pinned`), `pin()` throws:
   ```javascript
   throw new Error(`Conflicting pre-existing route found for ${t}/32 on interface index ${er.InterfaceIndex} (NextHop: ${er.NextHop || 'none'}); aborting pinning`);
   ```
3. **Preservation of Pre-existing Routes:** Zero unrelated routes are deleted or overwritten.
4. **Partial Pin State Retention:** Route metadata is committed to `st.pinned` and saved to `netswitch-state.json` via atomic `.tmp` rename as each route is registered. If a subsequent route creation fails, previously created routes remain recorded for safe cleanup by `unpin()` or `restoreFromStateFile()`.

---

## 4. Task 3: Fail-Closed Hardware Identity Anchoring (P0)

### Implementation Corrections

#### 1. In `setActive(adapters, id)` ([`winController.js:440–566`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L440-L566))
- **Target Pre-Validation:** Queries `queryAdapterIdentity(target.index)`. If query fails, returns null, lacks recorded GUID, or has mismatched GUID/MAC, exits immediately with `{ ok: false, note: '...' }` before modifying any interface.
- **Rich State Snapshot:** Stores `guid: a.guid || null` and `mac: a.mac || null` in both `st.originals` (state file) and `previous` (in-memory rollback stack).
- **Per-Adapter Pre-Mutation Query:** Re-queries `queryAdapterIdentity(a.index)` immediately before every single `Set-NetIPInterface` call in the loop. If identity query fails or GUID/MAC mismatches, breaks out with `modificationError` and triggers rollback.

#### 2. In `#rollback(modifiedStack)` ([`winController.js:319–378`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L319-L378))
- **Identity Re-Validation Before Rollback Mutation:** Queries `queryAdapterIdentity(item.index)` before each rollback `Set-NetIPInterface`.
- **Refusal on Mismatch:** If query fails, returns null, or GUID/MAC mismatches, records error in `applyErrors`, refuses to execute `#setMetric`, and reports `rolledBack: false` to ensure state is preserved.

#### 3. In `restoreFromStateFile(why)` ([`winController.js:600–637`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L600-L637))
- **Pre-Restoration Identity Validation:** Queries `queryAdapterIdentity(o.index)` before each `Set-NetIPInterface`.
- **Refusal & State Preservation:** If the adapter at index `o.index` has changed GUID or MAC, records `verifyErrors.push(...)`, logs refusal, skips `#setMetric()`, and keeps `netswitch-state.json` preserved on disk.

---

## 5. Inspection of All `Remove-NetRoute` and `Set-NetIPInterface` Call Sites

A full-codebase scan across `backend/src/`, `backend/scripts/`, and `scripts/` identified all call sites and confirmed universal fail-closed guards:

| File | Line | Command | Context | Safety Guards Enforced |
| :--- | :--- | :--- | :--- | :--- |
| `winController.js` | 107 | `Set-NetIPInterface` | `#setMetric(index, ..., auto: true)` | Validates integer index; called ONLY after identity check in `setActive`, `#rollback`, or `restoreFromStateFile`. |
| `winController.js` | 112 | `Set-NetIPInterface` | `#setMetric(index, metric, auto: false)` | Validates integer index and metric (1–9999); preceded by identity checks in all call paths. |
| `winController.js` | 240 | `Remove-NetRoute` | `pin()` route refresh | Executes ONLY if route was already recorded in `st.pinned` with matching interface and gateway. Never touches unrelated routes. |
| `winController.js` | 288 | `Remove-NetRoute` | `unpin()` route cleanup | Target checked in `st.pinned`; adapter identity verified; route queried; exact interface and next hop specified. |
| `winController.js` | 688 | `Remove-NetRoute` | `restoreFromStateFile()` | Owned state required; adapter identity verified; query verified; exact interface index and next hop specified; independent post-verification. |
| `restore.ps1` (scripts) | 61 | `Set-NetIPInterface` | Metric restoration (auto) | `Get-NetAdapter` verified for GUID/MAC matching; virtual adapters excluded; verification query follows. |
| `restore.ps1` (scripts) | 64 | `Set-NetIPInterface` | Metric restoration (manual) | `Get-NetAdapter` verified for GUID/MAC matching; virtual adapters excluded; verification query follows. |
| `restore.ps1` (scripts) | 88 | `Remove-NetRoute` | Pinned route cleanup | Target checked in `$s.pinned`; adapter GUID/MAC verified; NextHop matched; ambiguity rejected; independent verification follows. |

**Zero** destination-only `Remove-NetRoute` commands remain in any source or script file.

---

## 6. Test Evidence (Task 4)

All 12 required test scenarios were added to [`backend/test/safety_hardening.test.js`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/test/safety_hardening.test.js) and verified asserting that **zero unsafe PowerShell mutation commands were issued**:

| Test ID | Test Name | Assertion Highlights | Result |
| :--- | :--- | :--- | :--- |
| **4B.1-1** | `Route query failure prevents deletion` | `Get-NetRoute` throws error -> `unpinRes.verified === false`, `commandLog.filter(Remove-NetRoute).length === 0`, route preserved in state. | **PASS** |
| **4B.1-2** | `Route query returning null prevents deletion` | `queryRoute` returns `null` -> `unpinRes.verified === false`, `commandLog.filter(Remove-NetRoute).length === 0`. | **PASS** |
| **4B.1-3** | `Destination-only Remove-NetRoute is never executed` | `Remove-NetRoute` commands verified during pin/unpin -> 100% of commands contain `-InterfaceIndex`; 0 destination-only calls. | **PASS** |
| **4B.1-4** | `Pre-existing route on the same interface is preserved` | Pre-existing route on index 12 unowned by NetSwitch -> `unpin()` executes 0 `Remove-NetRoute` commands; route preserved. | **PASS** |
| **4B.1-5** | `Existing route with a different gateway is preserved` | NextHop in OS differs from recorded gateway -> 0 `Remove-NetRoute` commands; route preserved. | **PASS** |
| **4B.1-6** | `Changed interface GUID prevents route deletion` | Interface 12 GUID changed in OS -> `unpinRes.verified === false`, 0 `Remove-NetRoute` commands executed; state preserved. | **PASS** |
| **4B.1-7** | `Pinning aborts when a conflicting pre-existing route exists` | Conflicting route exists on host -> `pin()` throws `/Conflicting pre-existing route found/`, 0 `New-NetRoute` and 0 `Remove-NetRoute` executed. | **PASS** |
| **4B.1-8** | `Identity query failure blocks setActive` | `Get-NetAdapter` throws -> `setActive()` returns `ok: false`, `commandLog.filter(Set-NetIPInterface).length === 0`. | **PASS** |
| **4B.1-9** | `Missing GUID blocks setActive when GUID was recorded` | OS returns `null` GUID -> `setActive()` returns `ok: false`, 0 `Set-NetIPInterface` commands executed. | **PASS** |
| **4B.1-10** | `Rollback refuses to mutate a mismatched adapter` | Interface GUID changes during switch transaction -> Rollback checks identity, refuses mutation on index 12, returns `rolledBack: false`. | **PASS** |
| **4B.1-11** | `Startup recovery refuses to restore metrics to a mismatched adapter` | Interface 12 has mismatched GUID -> `restoreFromStateFile()` skips index 12, executes 0 `Set-NetIPInterface`, state preserved. | **PASS** |
| **4B.1-12** | `Failed recovery preserves the state file` | Metric query verification fails -> `restoreFromStateFile()` returns `verified: false`, `netswitch-state.json` preserved on disk. | **PASS** |

---

## 7. Full Test Suite & Build Verification Results

### Backend Suite (89 Tests)
```
✔ core.test.js                  (19 tests)  ->  PASS
✔ db.test.js                    (12 tests)  ->  PASS
✔ controller.test.js            (10 tests)  ->  PASS
✔ monitor_safety.test.js        (10 tests)  ->  PASS
✔ safety_hardening.test.js      (26 tests)  ->  PASS
✔ api.test.js                   (5 tests)   ->  PASS
✔ phase4_api_ws.test.js         (7 tests)   ->  PASS
────────────────────────────────────────────────────
TOTAL: 89 passed, 0 failed, 0 cancelled, 0 skipped (100% pass rate)
```

### Frontend Production Build
```bash
> vite build
✓ 937 modules transformed.
dist/index.html                   0.39 kB │ gzip:   0.26 kB
dist/assets/index-4jsqOIMj.css  233.14 kB │ gzip:  31.55 kB
dist/assets/index-Bn5eRqGl.js   643.74 kB │ gzip: 188.51 kB
✓ built in 7.06s
```

---

## 8. Physical Host Invariance Verification

Independently confirmed on Windows host:
- `Ethernet 2` (USB Tethering, index 17): Route metric = **10** (interface metric 5 + route metric 5, unchanged)
- `Wi-Fi` (Intel AX203, index 12): Route metric = **150** (interface metric 75 + route metric 75, unchanged)
- Routing Table: Zero persistent routes, zero `/32` routes.
- State File: `netswitch-state.json` does not exist on disk (`Test-Path: False`).
- Wi-Fi association unchanged.

---

## 9. Safety Configuration & Current Posture

```env
NETSWITCH_FAILOVER_ENABLED=false
NETSWITCH_PROBE_ROUTE_PINNING=false
```

Execution is **STOPPED** per user instructions. Awaiting review and explicit direction before any future phase or physical testing.

