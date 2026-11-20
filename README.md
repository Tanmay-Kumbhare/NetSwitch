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
| Scoring, `decide()`, stats, subnet maths, parsers, DNS packets, PS argument validators | Automated tests (`npm test`, 28 tests) |
| REST + JWT + roles + WebSocket + sim failover end to end | Automated test + browser walkthrough |
| MySQL repository (schema, aggregation query, failover log) | Run against a real MariaDB 10.11 |
| Windows control (metrics, pinned routes, route lookup, verification) | Commands match your manual spikes S1–S6; **the Node wrapper itself must be validated on your laptop with `npm run check`** |
| Real probes (UDP-DNS, TCP, ICMP via `ping -S`) | Same: validate with `npm run check` |

## Folder map
```
backend/src/core      pure logic: stats, score, decide, subnet           (unit-tested)
backend/src/probes    UDP-DNS, TCP, ICMP probes + sim driver
backend/src/windows   PowerShell runner (validated args only), discovery, Wi-Fi scan
backend/src/control   WinController (metrics, pinned routes, verify, rollback, state file), SimController
backend/src/db        schema.sql, MysqlRepo, MemoryRepo
backend/src/agent.js  orchestrator: probes -> score -> decide -> switch -> persist -> broadcast
backend/src/server.js REST + WebSocket
frontend/src          6 pages: Login, Dashboard, History, Control, Interface detail, Learn
scripts/restore.ps1   manual recovery
docs/                 ARCHITECTURE, BRINGUP, CALIBRATION, test-results (S1–S6 evidence)
```

## Known limits (state these in the viva)
- Windows only for real control. IPv4 only. No bring-up of a disabled adapter: Windows removes its routes itself and Wi-Fi needs a manual reconnect (spike S3).
- Public IP is the same on both paths when both come from one phone, so path proof uses route lookup, source address and Wireshark, not an IP-echo service.
- If Wi-Fi and USB are both from the *same phone*, the phone is a shared uplink. Failover then protects against laptop-side link problems and demonstrates the mechanism; Clumsy is used to impair one path.
- Failover time is measured, not promised. See `docs/CALIBRATION.md`.

---

## How to Run (Choose Method 1 or Method 2)

> **Important:** Always open PowerShell using **Run as Administrator** so Windows permits kernel route pinning (`New-NetRoute`) and interface metric modification (`Set-NetIPInterface`). This ensures the dashboard displays green **`PATH VERIFIED`** badges.

---

### Method 1: Two Separate Terminals (Development & Live Viva Presentation)

Open **two separate Administrator PowerShell windows**:

#### Terminal 1 — Backend (API & Telemetry Agent)
```powershell
cd "d:\TY (5th Sem)\CNT\CP\NetSwitch\backend"
npm start
```
* **Port:** `http://127.0.0.1:4000`
* Discovers adapters, pins `/32` test routes, measures live link telemetry, and manages MySQL database logging.

#### Terminal 2 — Frontend (Vite Dev Server)
```powershell
cd "d:\TY (5th Sem)\CNT\CP\NetSwitch\frontend"
npm run dev
```
* **Dashboard URL:** `http://localhost:5173`
* Live React UI with hot-reloading (automatically proxies REST API calls and WebSocket connections to port 4000).

---

### Method 2: Single All-in-One Administrator Script (Production / Single-Window Demo)

To run the entire system (compiled frontend + backend agent) in **a single Administrator PowerShell window**:

```powershell
cd "d:\TY (5th Sem)\CNT\CP\NetSwitch"
.\scripts\start-admin.ps1
```

* **Dashboard URL:** `http://127.0.0.1:4000`
* **What it does:**
  1. Checks and verifies Administrator elevation.
  2. Builds the optimized frontend bundle (`frontend/dist`) if not already present.
  3. Launches the backend Express server, which serves both the REST/WebSocket API and the production React dashboard from `http://127.0.0.1:4000`.
  4. Automatically pins `/32` routes to physical adapters, displaying the green **`PATH VERIFIED`** badge.

