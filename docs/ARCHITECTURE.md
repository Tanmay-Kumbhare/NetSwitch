# Architecture and reference

## Control loop (once per second)
probe samples (UDP-DNS 5/s, TCP 0.5/s, ICMP 0.5/s per adapter, each bound to the adapter IP and sent to /32-pinned targets)
→ 10 s window statistics (`core/stats.js`) → score 0–100 (`core/score.js`)
→ `decide(state, inputs, now, cfg)` (`core/decide.js`, pure) → optional switch (`control/*Controller.js`) → verify or roll back
→ persist every 5 s (MySQL) → broadcast snapshot over WebSocket.

## Score
S = 100 · (1 − Σ wᵢ·pᵢ / Σ wᵢ), pᵢ = min(1, xᵢ / Lᵢ). Loss 10 % / 0.40, median RTT 300 ms / 0.30, jitter 50 ms / 0.15 (mean absolute difference of consecutive RTTs), TCP connect 500 ms / 0.15.
Fewer than 20 probes → no score (UNVERIFIED). Fewer than 3 replies → latency and jitter count as worst. Stale (>5 s) TCP result → missing, weight redistributed. Failed TCP → worst.

## Decision rules (`config.js` → `decide`)
Hard failure (15 lost probes in a row + failed TCP) or adapter down → immediate switch, ignores hold-down.
Degradation → candidate leads by ≥20 points for 5 evaluations. Hold-down 30 s. Switch-back to the preferred adapter → +5 for 10 evaluations and score ≥ 60.
No eligible candidate → NO_INTERNET, never switch. Null score → never switch.

## Switching, Rollback and Verification
1. **Hardware Identity Revalidation:** Query `Get-NetAdapter` to verify the target interface still matches its recorded `MacAddress` and `InterfaceGuid` before any mutation.
2. **State Snapshot & Atomic Persistence:** Save original metrics to `netswitch-state.json` via atomic `.tmp` + rename before executing OS changes.
3. **Modification & Reverse-Order Rollback:** Active adapter metric = 5, others = 75 (`Set-NetIPInterface`). If any adapter modification fails, `modifiedStack` is reversed and prior interfaces are restored and verified.
4. **Dual Verification Before Switch Confirmation:** `Find-NetRoute 9.9.9.9` (never pinned) must return the new interface, AND an unbound TCP connect to `9.9.9.9:443` must succeed from the target adapter's source IP.
5. **Route Ownership & Cleanup Verification:** Pinned `/32` routes are recorded with prefix, index, gateway, and hardware identity. Deletion is independently verified by querying `Get-NetRoute`; state files are preserved on disk if cleanup verification fails.
6. **Monitor-Only Startup Guard:** When `NETSWITCH_FAILOVER_ENABLED=false`, startup does NOT execute recovery mutations; any stale state file is preserved and exposed as `recoveryPending: true`.
7. **Emergency Recovery:** `scripts/restore.ps1` provides out-of-band manual restoration for recorded managed interfaces.

## Topology & Upstream Network Redundancy Boundaries
- **Physical Multi-Interface:** NetSwitch operates across distinct physical laptop adapters (Intel Wi-Fi 6 PCIe vs Remote NDIS USB).
- **Single Phone Shared Uplink:** When both interfaces connect to the same smartphone (e.g. Moto g64 5G), they share a single cellular uplink. This demonstrates local-link failover and metric prioritization, but does NOT provide independent WAN redundancy. Carrier-level outages represent a common-mode failure. Genuine multi-WAN redundancy requires connecting Wi-Fi to a separate fixed-line ISP.

## REST (JWT bearer, except health/register/login)
POST /api/auth/register · POST /api/auth/login · GET /api/auth/me · GET /api/health · GET /api/interfaces · GET /api/interfaces/:key ·
GET /api/readings?interface=&minutes= · GET /api/failovers · POST /api/control/switch {to} (admin) · POST /api/control/restore (admin) ·
GET /api/config · PUT /api/config (admin). Extra: GET /api/wifi/scan (read-only); sim mode: POST /api/sim/impair, /api/sim/reset.
Lab endpoints (requireAuth): GET /api/lab/status · POST /api/lab/tcp · POST /api/lab/udp · POST /api/lab/udp-drop (admin) · POST /api/lab/concurrency · POST /api/lab/dijkstra · GET /api/lab/routing-graph · GET /api/lab/packet · POST /api/lab/tool · GET /api/lab/mail · POST /api/lab/mail/send · GET /api/lab/mail/pop3.

## Protocol Lab Subsystem (`backend/src/lab/`)
The Lab is a self-contained pedagogical subsystem that provides interactive protocol testing mapped to the Computer Network Technology (CNT) syllabus:
- **Server Ports (127.0.0.1 only):**
  - **TCP Server:** Port `5051` (custom Berkeley command protocol: HELLO, ECHO, LIST, GET file transfer, TIME, PRIME)
  - **UDP Server:** Port `5052` (connectionless datagram calculator: sin, cos, tan, sqrt, log, with simulated drop toggle)
  - **SMTP Server:** Port `5025` (text protocol dialog, 354 handling, base64 MIME encoding)
  - **POP3 Server:** Port `5110` (maildrop retrieval, RETR command dialog)
  - *Dynamic Port Fallback:* If a port is already bound, `SocketLab` and `MailLab` automatically select an ephemeral free port.
- **Worker Thread Concurrency (`pool.js` + `calc.worker.js`):** A fixed pool of `worker_threads` handles CPU-bound mathematical operations (`PRIME`, trigonometry) without blocking the Node.js event loop.
- **Link-State Dijkstra (`dijkstra.js`):** Generates dynamic graph from `agent.lastSnapshot` with edge cost = RTT + 10 × loss%, calculating the shortest path from laptop to internet.
- **Packet Dissector (`packet.js`):** Breaks down the NetSwitch 71-byte UDP/DNS probe into Layer 2 (Ethernet II 14B), Layer 3 (IPv4 20B), Layer 4 (UDP 8B), and Application Layer (DNS 29B).
- **Network Tool Diagnostics (`tools.js`):** Safe, fixed whitelist of diagnostic tools (`ping`, `tracert`, `arp`, `netstat`, `route`, `ipconfig`, `nbtstat`, `nslookup`, `tls`) using `child_process.execFile` (no shell invocation, strict hostname/IPv4 regex validation, SSRF guard blocking private IP probes for TLS).
- **Failover Integration:** When an adapter failover occurs, `agent.on('failover')` automatically calls `lab.onFailover(event)` to send an alert email to the local SMTP maildrop.
- **Graceful Shutdown:** `lab.close()` terminates all worker threads, stops socket listeners, and closes client connections after `agent.stop()`.

## WebSocket `/ws?token=<JWT>`
Server → client: `hello` (mode, user, handshake request/response lines), `snapshot` every 1 s, `failover` events, `pong`. Client → server: `{type:"ping"}`.

## Database (MySQL, `backend/src/db/schema.sql`)
users · interfaces · readings (indexed by interface_id, ts) · failover_events (detect/switch/total ms) · config.

## Security rules
Server binds to 127.0.0.1. PowerShell runs fixed scripts with validated integers/IPv4 only. Passwords bcrypt-hashed. Control endpoints need the admin role. Wi-Fi scan is read-only. Lab tools avoid shell execution and enforce argument whitelisting.
