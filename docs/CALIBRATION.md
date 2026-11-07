# Calibration and measurements (fill in on Day 8; quote these numbers in the report)

| Test | Procedure | Result |
| --- | --- | --- |
| Baseline | Both adapters healthy 60 s | score range, RTT, loss |
| Clumsy 150 ms + 10% drop | Wi-Fi only (your S4: 0%→20% loss, 37→378 ms) | score, band, time to degraded |
| Hard failure ×5 | Disable active adapter / cut phone data | detect, switch, total for each run |
| Degradation failover ×3 | Clumsy on the active adapter | time until switch; if > 15 s lower `degradeChecks` to 3–4 |
| Switch-back | Remove Clumsy | time until switch back |
| False-switch soak | 10 min, no faults | number of switches (target 0) |

Tune only via `backend/src/config.js` (or the Control page) and re-run the 10 `decide` tests after any change.
