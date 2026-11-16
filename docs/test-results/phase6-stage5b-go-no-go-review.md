# NetSwitch Phase 6 Stage 5B: Final Go/No-Go Review Report

**Review Date:** 2026-11-08T20:17:30+05:30  
**Host Environment:** Lenovo Legion 5 (Windows 11 Home, Node.js v24.14.0, Native MySQL 8.0)  
**Target Branch:** `development` (Clean working tree, zero commits, zero pushes)  
**Safety Flags:** `NETSWITCH_FAILOVER_ENABLED=false`, `NETSWITCH_PROBE_ROUTE_PINNING=false`  
**Review Type:** READ-ONLY Verification of Safety Architecture & Test Plan  
**Final Verdict:** **GO (CONDITIONAL UPON EXPLICIT USER AUTHORIZATION)**  

---

## 1. Executive Summary

This Go/No-Go review conducts an exhaustive, read-only architectural verification of NetSwitch's switching, rollback, state persistence, identity verification, and recovery mechanisms prior to authorizing the first physical manual switch test.

Every core safety guarantee introduced in Stage 4B and Stage 4B.1 has been verified against the actual source code and tested against the 89-test regression suite:
1. **Decoupled Architecture:** Manual metric switching functions independently of probe route pinning. Setting `NETSWITCH_FAILOVER_ENABLED=true` and `NETSWITCH_PROBE_ROUTE_PINNING=false` permits safe metric failover without creating any `/32` host routes.
2. **Fail-Closed Hardware Anchoring:** Interface `InterfaceGuid` and `MacAddress` are validated immediately prior to every `Set-NetIPInterface` call in forward mutation, reverse-order rollback, and recovery.
3. **Pre-Mutation State Persistence:** `netswitch-state.json` is committed to disk via atomic write/rename *before* the first OS modification is executed.
4. **Independent Rollback Identity Check:** Rollback independently queries `Get-NetAdapter` and refuses to mutate any adapter with a mismatched or missing identity.
5. **Exact Metric & AutomaticMetric Restoration:** Original integer metric values and `AutomaticMetric: Disabled` settings are strictly preserved and restored.
6. **Verified Cleanup:** State files are deleted *only* after independent post-restoration query confirms expected metrics and route deletion.
7. **End-to-End API Security:** The `POST /api/control/switch` endpoint cannot bypass any controller safety check; all authorization, eligibility, identity, and verification rules are strictly enforced.

---

## 2. Core Safety & Architectural Verifications

### 2.1 Manual Switching with Probe Route Pinning Disabled
- **Verification:** [`backend/src/control/winController.js:440–560`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L440-L560) and [`backend/src/agent.js:255–269`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/agent.js#L255-L269).
- **Finding:** Probe route pinning (`this.probeRoutePinning`) is checked **only** within `ctl.pin()`. It is **not** required for `ctl.setActive()`.
- **Operational Reality:** When `NETSWITCH_FAILOVER_ENABLED=true` and `NETSWITCH_PROBE_ROUTE_PINNING=false`:
  - Background probe drivers run unpinned (`pathVerified: false`), measuring live traffic via standard OS routing.
  - Manual switching (`POST /api/control/switch`) executes transaction-safe metric modifications (`activeMetric: 5`, `standbyMetric: 75`) without creating, modifying, or deleting any `/32` routes.
  - **Status: PASS.**

### 2.2 Hardware Identity Verification Before Every Metric Mutation
- **Verification:** [`backend/src/control/winController.js:455–471`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L455-L471) & [`lines 512–530`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L512-L530).
- **Pre-Flight Target Check:** Prior to modifying any interface, `setActive()` queries `queryAdapterIdentity(target.index)`. If query fails, returns null, lacks recorded GUID, or mismatches either GUID or MAC, the switch is refused before any OS mutation.
- **Per-Adapter Pre-Mutation Re-Query:** Inside the modification loop, `queryAdapterIdentity(a.index)` is queried immediately before each `this.#setMetric(a.index, ...)` call. If query fails or identity mismatches, the loop terminates with `modificationError`, triggering immediate rollback.
- **Status: PASS.**

### 2.3 Transaction State Persisted Before OS Changes
- **Verification:** [`backend/src/control/winController.js:482–501`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L482-L501) & [`lines 87–101`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L87-L101).
- **Snapshot Execution:** `st.originals` records `index`, `alias`, `guid`, `mac`, `metric`, and `autoMetric` for all managed adapters.
- **Atomic Persistence:** `this.#write(st)` writes the payload to `.tmp-<timestamp>-<rand>` and renames it synchronously to `netswitch-state.json`.
- **Ordering:** `#write(st)` finishes before the `for (const a of managed)` metric loop executes. If power or the process fails during switching, `netswitch-state.json` is already persistent on disk.
- **Status: PASS.**

### 2.4 Rollback Validates Adapter Identity Independently
- **Verification:** [`backend/src/control/winController.js:319–347`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L319-L347).
- **Identity Check in Rollback:** `#rollback(modifiedStack)` reverses the modified stack. For each item, it re-queries `queryAdapterIdentity(item.index)` before calling `#setMetric`.
- **Refusal on Mismatch:** If identity query fails or GUID/MAC mismatches, the mutation is refused, error is pushed to `applyErrors`, and `rolledBack: false` is reported to keep the state file on disk.
- **Metric Verification:** Rollback queries `queryInterface(item.index)` post-restoration to confirm metrics returned to original values.
- **Status: PASS.**

### 2.5 Restoration of Original Metrics and AutomaticMetric Settings
- **Verification:** [`backend/src/control/winController.js:103–114`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L103-L114) & [`scripts/restore.ps1:59–68`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/scripts/restore.ps1#L59-L68).
- **Implementation:**
  ```javascript
  if (auto) {
    return this.runPs(`Set-NetIPInterface -InterfaceIndex ${index} -AddressFamily IPv4 -AutomaticMetric Enabled`);
  }
  return this.runPs(`Set-NetIPInterface -InterfaceIndex ${index} -AddressFamily IPv4 -AutomaticMetric Disabled -InterfaceMetric ${metric}`);
  ```
- **Fidelity:** Original `autoMetric` boolean and integer `metric` (e.g. 5 or 75) are restored identically.
- **Status: PASS.**

### 2.6 State File Deletion Only After Successful Independent Verification
- **Verification:** [`backend/src/control/winController.js:699–709`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L699-L709) & [`scripts/restore.ps1:171–177`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/scripts/restore.ps1#L171-L177).
- **Logic:** `fs.unlinkSync(this.stateFile)` is called **only** if `verifyErrors.length === 0`.
- **Verification Criteria:** Both interface metrics must match recorded original values (`queryInterface`), and all pinned routes must be confirmed absent (`queryRoute`). Any mismatch preserves `netswitch-state.json`.
- **Status: PASS.**

### 2.7 Emergency Restore Scripts Compatibility with Current State Format
- **Verification:** [`scripts/restore.ps1:52–90`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/scripts/restore.ps1#L52-L90).
- **Schema Match:**
  - `originals`: Reads `$o.index`, `$o.alias`, `$o.guid`, `$o.mac`, `$o.metric`, `$o.autoMetric` (exact 1:1 match with `WinController`).
  - `pinned`: Reads `$p.ip`, `$p.prefix`, `$p.index`, `$p.gateway`, `$p.guid`, `$p.mac`.
- **Zero-State Handling:** If `netswitch-state.json` does not exist, `scripts/restore.ps1` reports `"Zero network changes made."` and exits cleanly.
- **Status: PASS.**

### 2.8 Manual Switch Endpoint Cannot Bypass Controller Safety Checks
- **Verification:** [`backend/src/server.js:64–70`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/server.js#L64-L70), [`backend/src/agent.js:255–269`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/agent.js#L255-L269), & [`backend/src/control/winController.js:440–475`](file:///d:/TY%20(5th%20Sem)/CNT/CP/NetSwitch/backend/src/control/winController.js#L440-L475).
- **Enforcement Stack:**
  1. `admin` middleware enforces valid JWT with `role === 'admin'`.
  2. Server check `if (!agent.failoverEnabled) throw httpErr(422, 'failover disabled...')`.
  3. Body parameter validation `to` (regex `/^[a-z0-9]{1,40}$/`).
  4. `agent.switchTo()` validates `canControl`, `!this.switching`, and `target.eligible` (blocks virtual/VMware).
  5. `ctl.setActive()` enforces controller `failoverEnabled`, `canControl`, target GUID/MAC hardware query, pre-mutation state save, and per-adapter mutation query.
- **Status: PASS.**

---

## 3. Exact Verification Commands

These exact, read-only PowerShell commands must be used to verify host network state before, during, and after the switch test:

### 1. Interface Metrics & AutomaticMetric
```powershell
Get-NetIPInterface -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -in @('Ethernet 2', 'Wi-Fi') } | Select-Object InterfaceAlias, InterfaceIndex, AutomaticMetric, InterfaceMetric | Format-Table -AutoSize
```

### 2. IPv4 Default Routes (`0.0.0.0/0`)
```powershell
Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Select-Object DestinationPrefix, NextHop, RouteMetric, InterfaceIndex, InterfaceAlias | Format-Table -AutoSize
```

### 3. Active Route Lookup for `9.9.9.9` (Windows Route Selection)
```powershell
Find-NetRoute -RemoteIPAddress 9.9.9.9 | Select-Object InterfaceIndex, InterfaceAlias, NextHop
```

### 4. Source IP of TCP Connection to `9.9.9.9:443`
```powershell
$client = New-Object System.Net.Sockets.TcpClient
$client.Connect('9.9.9.9', 443)
$localEp = $client.Client.LocalEndPoint.ToString()
$client.Close()
Write-Host "TCP Egress Source Endpoint: $localEp"
```

### 5. Transaction State Cleanup Check
```powershell
Test-Path 'd:\TY (5th Sem)\CNT\CP\NetSwitch\netswitch-state.json'
```

---

## 4. Expected Values & Stop Conditions

### Direction 1: USB (`Ethernet 2`) -> Wi-Fi (`Wi-Fi`)

**Action:** `POST /api/control/switch { "to": "wifi" }`

| Metric / Check | Expected Value | Stop Condition (Immediate Abort) |
| :--- | :--- | :--- |
| **API Response** | HTTP 200 `{ ok: true, verified: true }` | HTTP 422, 500, or `verified: false` |
| **State File** | Created at `netswitch-state.json` | Not created, or corrupt JSON |
| **Wi-Fi InterfaceMetric** | **5** (`AutomaticMetric: Disabled`) | Metric != 5 or `AutomaticMetric: Enabled` |
| **USB InterfaceMetric** | **75** (`AutomaticMetric: Disabled`) | Metric != 75 or `AutomaticMetric: Enabled` |
| **Wi-Fi Default Route (Total)** | Total Metric = **10** (5 interface + 5 route) | Total Metric > 150 |
| **USB Default Route (Total)** | Total Metric = **80** (75 interface + 5 route) | Total Metric < 10 |
| **Find-NetRoute 9.9.9.9** | **Index 12 (`Wi-Fi`)** | Returns Index 17, 15, 21, or null |
| **TCP Connect 9.9.9.9:443** | Local IP = `10.97.128.167` (`Wi-Fi`) | Sourced from `10.41.171.54` or timed out |
| **VMware Adapters (15, 21)** | Metrics **35 / 35** (Unchanged) | Any change to VMware adapters |

---

### Direction 2: Wi-Fi (`Wi-Fi`) -> USB (`Ethernet 2`) [Switchback]

**Action:** `POST /api/control/switch { "to": "usb" }` *(or `POST /api/control/restore`)*

| Metric / Check | Expected Value | Stop Condition (Immediate Abort) |
| :--- | :--- | :--- |
| **API Response** | HTTP 200 `{ ok: true, verified: true }` | HTTP 422, 500, or `verified: false` |
| **State File** | **Deleted** (`Test-Path: False`) | File remains on disk after 3 s |
| **USB InterfaceMetric** | **5** (`AutomaticMetric: Disabled`) | Metric != 5 or `AutomaticMetric: Enabled` |
| **Wi-Fi InterfaceMetric** | **75** (`AutomaticMetric: Disabled`) | Metric != 75 or `AutomaticMetric: Enabled` |
| **USB Default Route (Total)** | Total Metric = **10** (5 interface + 5 route) | Total Metric > 80 |
| **Wi-Fi Default Route (Total)** | Total Metric = **150** (75 interface + 75 route) | Total Metric < 10 |
| **Find-NetRoute 9.9.9.9** | **Index 17 (`Ethernet 2`)** | Returns Index 12, 15, 21, or null |
| **TCP Connect 9.9.9.9:443** | Local IP = `10.41.171.54` (`Ethernet 2`) | Sourced from `10.97.128.167` or timed out |
| **VMware Adapters (15, 21)** | Metrics **35 / 35** (Unchanged) | Any change to VMware adapters |

---

## 5. Emergency Rollback Runbook

If any stop condition is triggered, or if the process terminates abnormally during the test:

1. **Do not modify files or kill adapters.**
2. Open an elevated **Administrator PowerShell** console.
3. Execute the emergency recovery script:
   ```powershell
   cd 'd:\TY (5th Sem)\CNT\CP\NetSwitch'
   .\scripts\restore.ps1
   ```
4. Verify output confirms:
   ```
   Restored Ethernet 2 (index 17) -> InterfaceMetric=5, AutomaticMetric=Disabled
   Restored Wi-Fi (index 12) -> InterfaceMetric=75, AutomaticMetric=Disabled
   All restored configurations independently verified. State file removed.
   ```
5. Confirm baseline restoration with:
   ```powershell
   Get-NetIPInterface -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -in @('Ethernet 2', 'Wi-Fi') }
   ```

---

## 6. Final Go/No-Go Verdict

```
┌─────────────────────────────────────────────────────────────┬─────────┐
│ Evaluation Check                                            │ Verdict │
├─────────────────────────────────────────────────────────────┼─────────┤
│ 1. Switching Works with failoverEnabled=true & pinning=false│ GO      │
│ 2. GUID / MAC Identity Validation on Every Mutation Path    │ GO      │
│ 3. State Persistence Precedes All OS Modifications          │ GO      │
│ 4. Rollback Independently Validates Identity & Metrics      │ GO      │
│ 5. Exact Metric & AutoMetric Restoration Preserved          │ GO      │
│ 6. State File Unlinked ONLY on Independent Verification     │ GO      │
│ 7. Emergency Restore Scripts Compatible with State Format   │ GO      │
│ 8. Manual Switch Endpoint Enforces Controller Boundaries    │ GO      │
│ 9. Verification Commands Defined & Tested                   │ GO      │
│ 10. Expected Values & Stop Conditions Documented            │ GO      │
├─────────────────────────────────────────────────────────────┼─────────┤
│ OVERALL STAGE 5B VERDICT                                    │ GO      │
└─────────────────────────────────────────────────────────────┴─────────┘
```

**Recommendation:** The implementation is hardened, transaction-safe, and ready for the controlled Stage 5B physical switch test.

**Current Safety State:** Both safety flags remain explicitly `false`. Execution is **STOPPED**. Awaiting explicit user authorization before launching Stage 5B.

