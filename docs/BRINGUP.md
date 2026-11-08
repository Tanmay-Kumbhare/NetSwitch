# Windows bring-up checklist (do in order; stop at the first failure and send me the output)

## Safety & Operational Modes

NetSwitch includes explicit safety controls to prevent accidental network disruption:

1. **`NETSWITCH_FAILOVER_ENABLED` (default: `false` / Monitor-Only Mode)**
   - When `false`, automatic failover decisions, `#doSwitch()`, and manual API switching (`POST /api/control/switch`) are strictly blocked across the Agent and Controller layers.
   - Zero `Set-NetIPInterface` commands execute on Windows.
   - Physical adapter discovery, real-time health telemetry, WebSocket push, and MySQL data logging continue in read-only mode.
   - **Startup Recovery Guard (Phase 6 Stage 4B Hardened):** If a stale `netswitch-state.json` file is present from a previous interrupted run, startup in monitor-only mode will **NOT** automatically mutate Windows metrics or routes. The state file is safely preserved, logged, and reported via `/api/health` and snapshots as `recoveryPending: true`.
   - Explicit recovery remains available on demand via `restoreAll()` or `.\scripts\restore.ps1`.
   - Elevated administrator privileges alone do **not** enable failover unless explicitly authorized by setting `NETSWITCH_FAILOVER_ENABLED=true`.

2. **`NETSWITCH_PROBE_ROUTE_PINNING` (default: `false`)**
   - Controls whether temporary `/32` host routes (`1.1.1.1`, `8.8.8.8`, etc.) are created in the Windows routing table.
   - **Why this matters under Windows:** Windows implements the Weak Host Model. When a socket binds to a local IP without a specific host route, Windows sends outbound packets through the network adapter associated with the lowest-metric default gateway (`0.0.0.0/0`). As a result, unpinned probes bound to a secondary adapter's IP can leak through the primary adapter.
   - When `false`, zero route modifications (`New-NetRoute`) occur on Windows. Telemetry reports unpinned status.
   - When `true` (and running with Administrator privileges), narrow temporary `/32` routes are pinned exclusively to their respective physical adapters, enabling independent link telemetry.
   - **Route Ownership & Cleanup Verification (Phase 6 Stage 4B Hardened):** NetSwitch records rich ownership records for each pinned route (destination prefix, interface index, gateway, policy store, MAC, GUID). Route unpinning and recovery scripts remove only owned routes, preserve unrelated routes, and **independently query the routing table via `Get-NetRoute`** to verify that the route is absent before considering cleanup successful.

3. **Hardware Identity Anchoring (Phase 6 Stage 4B Hardened):**
   - NetSwitch does not treat transient interface indexes as permanent identities.
   - Discovery queries immutable hardware properties: `MacAddress`, `InterfaceGuid`, and `PnPDeviceID`.
   - When a USB adapter drops offline, its background probe driver is stopped immediately to prevent socket leakage.
   - Upon reconnection, hardware identity is re-matched against the previous MAC/GUID. If a different hardware device is detected, it is flagged as ambiguous and marked unavailable.
   - Hardware identity is re-verified before any future metric mutation (`setActive()`).

4. **Shared Upstream Limitation (Single Cellular Uplink):**
   - **Physical Interfaces:** Wi-Fi (Intel AX203 PCIe) and USB Tethering (Remote NDIS USB) are two distinct physical laptop network interfaces with independent network drivers, MAC addresses, and IP stacks.
   - **Upstream Uplink:** In the current testbed, both physical interfaces connect to the same smartphone (Moto g64 5G) and share a single cellular carrier uplink.
   - **Demonstration Scope:** This topology demonstrates and validates host-level multi-interface monitoring, local-link degradation detection, Windows metric failover, and TCP verification. It **does NOT** provide true ISP/WAN path redundancy: a cellular tower outage or mobile data loss will degrade or disconnect both interfaces simultaneously (common-mode failure).
   - **Full WAN Redundancy:** Validating independent WAN redundancy requires connecting Wi-Fi to a dedicated fixed-line ISP router while USB tethering remains on cellular.

---

## Step-by-Step Bring-up Checklist

0. Wi-Fi and the USB tether both connected, both showing a default gateway. MySQL running.
1. `npm run install:all` (root folder).
2. Administrator PowerShell → `cd backend` → `npm run check`.
   Expect: Administrator: true; a table with two adapters (Wi-Fi idx 12, Ethernet 2 idx 17 on your laptop);
   "Windows says: if <index>" equal to each adapter's own index for its pinned target; then per adapter `udp sent≈50`, loss ≈ 0%, `tcp=…ms`, `icmp ok=…`, a score.
   - If UDP shows loss 100% but TCP and ICMP work: the network blocks UDP :53 (the app falls back to ICMP and shows a badge).
   - If one adapter shows `udp sent=0`: the UDP socket could not bind to that IP. Send the output.
3. **Monitor-Only Bring-up (Phase 6 Stage 2):**
   Run with `NETSWITCH_FAILOVER_ENABLED=false` (in `.env`). Open Dashboard (`http://127.0.0.1:4000`). Confirm live telemetry updates, phase is `MONITOR_ONLY`, and switching is disabled.
4. **Active Failover Bring-up (Phase 6 Stage 3+):**
   When authorized, set `NETSWITCH_FAILOVER_ENABLED=true` and start via `.\scripts\start-admin.ps1`.
   Control page → **Make active** on the other adapter. Expect "route and source address verified". Run `Get-NetIPInterface -AddressFamily IPv4` to see metrics 5/75 swapped.
5. Clumsy on the active adapter (Lag 150, Drop 10, both directions, filter from the Control page): the score should fall; with the other adapter healthy, a degradation failover happens after roughly 8–15 s.
6. Hard failure: disable the active adapter in Windows or switch off the phone's data. Failover should be a few seconds. Write the measured numbers down (Dashboard timeline shows detect / switch / total).
7. Crash test: kill the Node process (Task Manager) after a switch, then start the agent again. Metrics must return to the originals. Also try `.\scripts\restore.ps1`.
8. Wireshark on both adapters while the unpinned `Test-NetConnection 9.9.9.9 -Port 443` runs: SYN only on the active adapter. Save screenshots to `docs/test-results/`.
