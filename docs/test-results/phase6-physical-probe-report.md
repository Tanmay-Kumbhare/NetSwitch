# NetSwitch Phase 6: Controlled Physical Probe Validation Report

- **Date & Time:** 2026-11-07 13:22:30 IST
- **Environment:** Windows 11 Home (x64), Lenovo Legion 5
- **Runtime:** Node.js v24.14.0
- **Test Script:** `backend/scripts/check-windows.js` (`npm run check`)
- **Execution Context:** Elevated Administrator PowerShell

---

## 1. Scope & Objective

Phase 6 validates the physical hardware integration of NetSwitch on Windows 11 prior to enabling any switching or failover logic.

### In Scope for this Validation
- Verification of administrative privileges (`ctl.init()`).
- Adapter enumeration and physical classification (Wi-Fi vs USB tethering).
- Explicit exclusion of virtual adapters (VMware `VMnet1`, `VMnet8`).
- Temporary `/32` host route creation (pinning) via `New-NetRoute`.
- OS routing table confirmation via `Find-NetRoute`.
- Concurrent multi-protocol probing (UDP, TCP handshake, ICMP ping) bound to specific physical interfaces.
- Real-time windowed statistical aggregation and health scoring.
- Controlled route unpinning and cleanup via `ctl.restoreAll()`.

### Out of Scope (Strictly Prohibited & Untested)
- Changing Windows interface metrics (`Set-NetIPInterface`).
- Manual or automatic adapter switching / failover.
- Altering default gateway routes (`0.0.0.0/0`).
- Enabling or disabling physical network adapters.
- Synthetic network impairment (Clumsy, WinDivert packet dropping/lag).

---

## 2. Adapter Configuration & Baseline Routing

Prior to running the probe validation, baseline routing and adapter metrics were recorded:

| Adapter Alias | Classification | Hardware Description | Interface Index | IPv4 Address | Gateway | Metric | AutoMetric |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **Ethernet 2** | `usb` | Remote NDIS based Internet Sharing Device | **17** | `10.41.171.54/24` | `10.41.171.250` | **5** | Disabled |
| **Wi-Fi** | `wifi` | Intel(R) Wi-Fi 6 AX203 160MHz | **12** | `10.97.128.167/24` | `10.97.128.135` | **75** | Disabled |

### Baseline Default Route (`0.0.0.0/0`)
- **Primary Route:** `0.0.0.0/0` via `10.41.171.250` on `Ethernet 2` (RouteMetric: 5)
- **Secondary Route:** `0.0.0.0/0` via `10.97.128.135` on `Wi-Fi` (RouteMetric: 75)
- **Baseline Target Routes:** No `/32` routes existed for `1.1.1.1`, `1.0.0.1`, `8.8.8.8`, or `8.8.4.4`.
- **Virtual Adapters:** VMware Workstation adapters `VMnet1` (index 21) and `VMnet8` (index 15) were correctly ignored by discovery filters.

---

## 3. Route Pinning & Windows Kernel Routing Verification

To isolate probe traffic through specific physical adapters without altering global default routes, `/32` target routes were pinned:

```
pinned 8.8.8.8, 8.8.4.4 via usb (if 17, gw 10.41.171.250); Windows says: if 17
pinned 1.1.1.1, 1.0.0.1 via wifi (if 12, gw 10.97.128.135); Windows says: if 12
```

### Verification Findings
- `Find-NetRoute -RemoteIPAddress 8.8.8.8` resolved to **Interface 17 (`Ethernet 2`)**.
- `Find-NetRoute -RemoteIPAddress 1.1.1.1` resolved to **Interface 12 (`Wi-Fi`)**.
- Confirmed that Windows IP routing directs traffic to the correct physical adapter based on pinned host routes, preventing traffic leakage across adapters.

---

## 4. Hardware Probe Measurement Results (12-Second Window)

| Measurement | USB Tethering (`Ethernet 2` / if 17) | Wi-Fi (`Wi-Fi` / if 12) |
| :--- | :---: | :---: |
| **Pinned Targets** | `8.8.8.8`, `8.8.4.4` | `1.1.1.1`, `1.0.0.1` |
| **UDP Probes Sent** | **47** | **48** |
| **Packet Loss** | **0%** | **0%** |
| **Median RTT** | **53 ms** | **108 ms** |
| **Jitter** | **60.3 ms** | **154.9 ms** |
| **TCP Connect Latency** | **45 ms** | **248 ms** |
| **ICMP Ping Ratio** | **10 / 10 (100%)** | **6 / 6 (100%)** |
| **Composite Score (0–100)**| **78.4** | **66.8** |
| **Evaluated Health Band** | **healthy** | **degraded** |

### Analysis of Probe Telemetry
1. **USB Tethering Performance:**
   - Low round-trip latency (`53 ms`) and rapid TCP handshake (`45 ms`).
   - Steady UDP packet arrival (47 packets in 12s, 0% loss).
   - Evaluated as `healthy` with a score of `78.4 / 100`.
2. **Wi-Fi Performance:**
   - 100% packet delivery (0% loss on 48 UDP probes; 6/6 ICMP echo replies).
   - Higher jitter (`154.9 ms`) and elevated TCP handshake latency (`248 ms`).
   - Evaluated as `degraded` with a score of `66.8 / 100`.
3. **Scoring Engine Validation:**
   - The multi-factor scoring algorithm accurately differentiated the lower-latency physical USB link from the more variable physical Wi-Fi connection without false negatives or missing samples.

---

## 5. Safety, Cleanup & Post-Execution Verification

Immediately after probe sampling completed, cleanup was executed and independently audited:

```
[control] State file verified and removed (manual)
[control] restore (manual): 0 metrics, verified=true
Done. Routes removed.
```

### Independent Post-Test Verification
1. **Host Routes Cleaned Up:**
   - Query: `Get-NetRoute -DestinationPrefix '1.1.1.1/32','1.0.0.1/32','8.8.8.8/32','8.8.4.4/32'`
   - Result: **0 routes found.** All four temporary routes were cleanly deleted.
2. **Interface Metrics Unchanged:**
   - Interface 17 (`Ethernet 2`): IPv4 Metric **5** (Disabled AutoMetric).
   - Interface 12 (`Wi-Fi`): IPv4 Metric **75** (Disabled AutoMetric).
   - Delta: **0**.
3. **Default Routes Unchanged:**
   - Primary `0.0.0.0/0` via `10.41.171.250` (metric 5).
   - Secondary `0.0.0.0/0` via `10.97.128.135` (metric 75).
4. **State File:**
   - `netswitch-state.json` was deleted and verified absent from the filesystem.

---

## 6. Architectural Distinction: Physical Probing vs Untested Physical Failover

To maintain absolute clarity regarding system readiness, the operational boundaries of this test are categorized below:

```
+---------------------------------------------------------------------------------+
|                                 PHASE 6 STATUS                                  |
+-----------------------------------------------------+---------------------------+
| [DEMONSTRATED & VERIFIED]                           | [UNTESTED & UNVERIFIED]   |
|                                                     |                           |
| 1. Physical adapter discovery & identification      | 1. Physical metric swap   |
| 2. Virtual/VMware adapter exclusion                 |    (5 <-> 75 on Windows)  |
| 3. /32 host route pinning per adapter               | 2. Default gateway swap   |
| 4. Windows kernel egress routing verification       | 3. Active TCP connection  |
| 5. UDP socket binding & RTT measurement             |    survivability          |
| 6. TCP handshake latency measurement                | 4. Synthetic impairment   |
| 7. ICMP echo reply verification                     |    failover via Clumsy    |
| 8. Composite health scoring under real physics      | 5. Hardware disconnection |
| 9. Safe route unpinning & metric restoration        |    (cable unplug/Wi-Fi off|
|                                                     | 6. Crash recovery under   |
|                                                     |    swapped physical state |
+-----------------------------------------------------+---------------------------+
```

> **Important:** While individual component drivers and host route manipulation operate as intended, **no physical switching event has occurred on this machine**. NetSwitch has not yet altered the active primary network adapter.

---

## 7. Phase 6 Completion Status & Proposed Next Safe Testing Stages

### Phase 6 Status
- **Physical Probe Hardware Validation:** **COMPLETE (PASS)**
- **Working Tree:** Clean (`development` branch).
- **Git Commit / Push:** None performed (in adherence to restrictions).

### Proposed Next Stages (In Increasing Order of Risk)

1. **Stage 6.2 — Single Controlled Manual Metric Swap & Immediate Rollback:**
   - *Goal:* Validate that `ctl.switchTo(wifi)` successfully changes interface metrics (`12` -> 5, `17` -> 75), verifies route change via `Find-NetRoute 0.0.0.0`, and immediately restores original metrics (`17` -> 5, `12` -> 75).
   - *Duration:* < 5 seconds.
   - *Verification:* Check metrics before, during, and after; confirm state file write and delete.

2. **Stage 6.3 — Read-Only Application Bring-Up (Monitoring Mode Only):**
   - *Goal:* Launch backend (`node src/server.js`) and frontend dashboard with failover disabled (`NETSWITCH_FAILOVER_ENABLED=false` or monitor-only mode).
   - *Goal:* Confirm live charts, telemetry updates, and database persistence in MySQL without executing any network modifications.

3. **Stage 6.4 — Controlled Impairment & Failover:**
   - *Goal:* Execute live failover under monitored conditions (Clumsy packet drop or phone tether toggle).
   - *Prerequisite:* User explicit approval of rollback scripts (`scripts/restore.ps1`).