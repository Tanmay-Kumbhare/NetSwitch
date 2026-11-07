// Windows bring-up check. Run from an ADMINISTRATOR PowerShell:  npm run check
// 1) admin? 2) adapters discovered? 3) pin probe routes, probe each adapter alone for 12 s, print stats, unpin.
// This validates the S1/S2 behaviour through the real code paths before you start the full app.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/config.js';
import { WinController } from '../src/control/winController.js';
import { RealProbeDriver } from '../src/probes/driver.js';
import { windowStats } from '../src/core/stats.js';
import { computeScore } from '../src/core/score.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ctl = new WinController({ stateFile: path.resolve(here, '..', '..', 'netswitch-state.json'), cfg: DEFAULTS });
console.log('Administrator:', await ctl.init());
if (!ctl.canControl) { console.log('Re-run in an Administrator PowerShell.'); process.exit(1); }
const adapters = await ctl.discover();
console.table(adapters.map(({ id, alias, index, ip, prefix, gateway, metric, autoMetric }) => ({ id, alias, index, ip: `${ip}/${prefix}`, gateway, metric, autoMetric })));
if (adapters.length < 2) console.log('WARNING: fewer than two adapters with a default gateway. Connect Wi-Fi and the USB tether.');

const drivers = [];
for (const a of adapters) {
  const targets = DEFAULTS.targets[a.kind] ?? DEFAULTS.targets.other;
  await ctl.pin(a, targets);
  console.log(`pinned ${targets.join(', ')} via ${a.id} (if ${a.index}, gw ${a.gateway}); Windows says: if ${await ctl.routeInterface(targets[0])}`);
  const d = new RealProbeDriver(a, targets, DEFAULTS); d.start(); drivers.push({ a, d, targets });
}
console.log('probing for 12 s ...');
await new Promise((r) => setTimeout(r, 12000));
const now = Date.now();
for (const { a, d } of drivers) {
  const r = d.read(); const st = windowStats(r.udp, now, DEFAULTS.probe.windowMs);
  const tcp = r.tcp ? { ok: r.tcp.ok, ms: r.tcp.ms, ageMs: now - r.tcp.at } : null;
  const sc = computeScore(st, tcp, DEFAULTS.score, { minSamples: DEFAULTS.probe.minSamples, tcpMaxAgeMs: DEFAULTS.probe.tcpMaxAgeMs });
  console.log(a.id.padEnd(5), `udp sent=${st.sent} loss=${st.lossPct?.toFixed(0)}% rtt=${st.medianRtt?.toFixed(0)}ms jitter=${st.jitter?.toFixed(1)}ms`, `| tcp=${tcp?.ok ? tcp.ms.toFixed(0) + 'ms' : 'FAIL'}`, `| icmp ok=${r.icmp.filter((x) => x.ok).length}/${r.icmp.length}`, `| score=${sc.score} (${sc.band})`);
  d.stop();
}
await ctl.restoreAll();
console.log('Done. Routes removed. If udp sent=0 or loss=100% on one adapter, send me this output.');
process.exit(0);
