# NetSwitch

Multi-interface network monitoring, selection and failover for Windows (Wi-Fi + USB tether).
It probes each adapter separately, scores every link, and changes the Windows interface metric when a
clearly better adapter exists or the active one fails. Everything is verified before it is trusted and rolled back if it fails.

**Stack:** Node.js 22+ (Express, ws, mysql2, JWT) · MySQL 8 · React 18 + Vite + React-Bootstrap + Recharts · PowerShell (fixed commands only).

## Quick start

### A) Anywhere, no Windows needed: simulation (UI, API, DB-less)
```
npm run install:all
npm run sim            # builds the frontend, starts the agent in SIM mode on http://127.0.0.1:4000
```
Register (first user = admin), open **Control**, click **Blackhole** on the active adapter, and watch the failover.

### B) Real demo on Windows (Wi-Fi + USB tether)
1. Install Node 22+, MySQL 8, and start MySQL. Copy `backend/.env.example` to `backend/.env` and set `MYSQL_PASSWORD`.
2. `npm run install:all`
3. Open **PowerShell as Administrator**, then `cd backend` and `npm run check`. Fix anything it reports first (see `docs/BRINGUP.md`).
4. `.\scripts\start-admin.ps1` (builds the frontend, starts the agent), open http://127.0.0.1:4000
5. Impair a link with Clumsy (filter is shown on the Control page).
6. If anything is left in a strange state: `.\scripts\restore.ps1`

## What is verified where
| Piece | Verified |
| --- | --- |
| Scoring, `decide()`, stats, subnet maths, parsers, DNS packets, PS argument validators | Automated tests (`npm test`, 112 tests across 8 suites) |
| Protocol Lab (TCP/UDP sockets, worker threads, Dijkstra, SMTP/POP3, packet anatomy, tools) | Automated unit tests (`lab.test.js`, 13 tests) |
| REST + JWT + roles + WebSocket + sim failover end to end | Automated test + browser walkthrough |
| MySQL repository (schema, aggregation query, failover log) | Run against real MySQL 8 / MariaDB |
| Windows control (metrics, pinned routes, route lookup, verification) | Commands match manual spikes S1–S6; verified with identity revalidation and reverse-order rollback |
| Real probes (UDP-DNS, TCP, ICMP via `ping -S`) | Validated end-to-end against live physical adapters |

## Folder map
```
backend/src/core      pure logic: stats, score, decide, subnet           (unit-tested)
backend/src/probes    UDP-DNS, TCP, ICMP probes + sim driver
backend/src/windows   PowerShell runner (validated args only), discovery, Wi-Fi scan
backend/src/control   WinController (metrics, pinned routes, verify, rollback, state file), SimController
backend/src/db        schema.sql, MysqlRepo, MemoryRepo
backend/src/lab       Protocol Lab: sockets, mail, worker pool, Dijkstra, packet dissection, tools
backend/src/agent.js  orchestrator: probes -> score -> decide -> switch -> persist -> broadcast
backend/src/server.js REST + WebSocket + Lab routes
frontend/src          7 pages: Login, Dashboard, History, Control, Interface detail, Learn, Lab
scripts/restore.ps1   manual recovery
docs/                 ARCHITECTURE, BRINGUP, CALIBRATION, test-results, postman
```

## Protocol & Networking Lab (CNT Syllabus Integration)

The project includes an interactive **Lab** page (`/lab`) that demonstrates the syllabus protocols running live on local loopback sockets alongside the failover engine:

| Tab | Protocols & Ports | Syllabus Unit | Demonstration in NetSwitch |
| --- | --- | --- | --- |
| **TCP / UDP Sockets** | TCP `5051`, UDP `5052` | Unit-III (Transport Layer, Practical 3a & 3b) | Berkeley socket primitives: TCP 3-way handshake measurement, reliable command session & file transfer (`notice.txt`); UDP connectionless datagram calculator (`sin 30`) with simulated packet loss toggle (0%, 30%, 70%). |
| **Threads & Concurrency** | Node event loop + `worker_threads` | Unit-VI (Node.js & OS Concurrency) | Demonstrates I/O multiplexing vs real parallel execution: 5 concurrent client requests sleeping 400 ms complete in ~400 ms wall-clock time; CPU-heavy prime calculation runs on worker threads without blocking the event loop. |
| **Routing (Dijkstra)** | OSPF Link-State Metric | Unit-II (Network Layer, Practical 2) | Live link-state graph of active adapters with dynamic edge cost = RTT + 10 × loss%; runs Dijkstra shortest path from laptop to internet. Also supports custom instructor graph evaluation. |
| **Packets (Wireshark)** | Ethernet II / IPv4 / UDP / DNS | Unit-I, II & III (Protocol Stack, Practical 3c) | Field-by-field packet anatomy matching Wireshark capture of NetSwitch's 71-byte UDP/DNS probe (14B Ethernet + 20B IPv4 + 8B UDP + 29B DNS). |
| **Mail (SMTP / POP3)** | SMTP `5025`, POP3 `5110` | Unit-III (Application Layer) | Interactive SMTP client/server with text-based dialog, MIME base64 encoding, and POP3 mail retrieval. Automatic alert emails are dispatched on adapter failover events. |
| **Network Tools** | ICMP, ARP, DNS, TLS ALPN | Unit-I & II (Practical 1b) | Fixed whitelist of system diagnostics (`ping`, `tracert`, `arp`, `netstat`, `route`, `ipconfig`, `nslookup`, `tls`) executed via `child_process.execFile` (no shell, validated inputs, SSRF-guarded). |

*All lab servers bind strictly to `127.0.0.1` and automatically fall back to ephemeral ports if default ports are occupied.*

## Known limits (state these in the viva)
- Windows only for real control. IPv4 only. No bring-up of a disabled adapter: Windows removes its routes itself and Wi-Fi needs a manual reconnect (spike S3).
- Public IP is the same on both paths when both come from one phone, so path proof uses route lookup, source address and Wireshark, not an IP-echo service.
- If Wi-Fi and USB are both from the *same phone*, the phone is a shared uplink. Failover then protects against laptop-side link problems and demonstrates the mechanism; Clumsy is used to impair one path.
- Failover time is measured, not promised. See `docs/CALIBRATION.md`.
