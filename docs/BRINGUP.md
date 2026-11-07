# Windows bring-up checklist (do in order; stop at the first failure and send me the output)

0. Wi-Fi and the USB tether both connected, both showing a default gateway. MySQL running.
1. `npm run install:all` (root folder).
2. Administrator PowerShell → `cd backend` → `npm run check`.
   Expect: Administrator: true; a table with two adapters (Wi-Fi idx 12, Ethernet 2 idx 17 on your laptop);
   "Windows says: if <index>" equal to each adapter's own index for its pinned target; then per adapter `udp sent≈50`, loss ≈ 0%, `tcp=…ms`, `icmp ok=…`, a score.
   - If UDP shows loss 100% but TCP and ICMP work: the network blocks UDP :53 (the app falls back to ICMP and shows a badge).
   - If one adapter shows `udp sent=0`: the UDP socket could not bind to that IP. Send the output.
3. `.\scripts\start-admin.ps1`, register the first user (admin), open the Dashboard: both cards leave "Warming up" after about 10 s.
4. Control page → **Make active** on the other adapter. Expect "route and source address verified". Run `Get-NetIPInterface -AddressFamily IPv4` to see metrics 5/75 swapped.
5. Clumsy on the active adapter (Lag 150, Drop 10, both directions, filter from the Control page): the score should fall; with the other adapter healthy, a degradation failover happens after roughly 8–15 s.
6. Hard failure: disable the active adapter in Windows or switch off the phone's data. Failover should be a few seconds. Write the measured numbers down (Dashboard timeline shows detect / switch / total).
7. Crash test: kill the Node process (Task Manager) after a switch, then start the agent again. Metrics must return to the originals. Also try `.\scripts\restore.ps1`.
8. Wireshark on both adapters while the unpinned `Test-NetConnection 9.9.9.9 -Port 443` runs: SYN only on the active adapter. Save screenshots to `docs/test-results/`.
