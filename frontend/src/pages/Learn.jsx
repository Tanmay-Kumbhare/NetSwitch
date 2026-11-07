import React, { useEffect, useState } from 'react';
import { Button, Table } from 'react-bootstrap';
import { useLive } from '../live.jsx';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

async function acceptFor(key) {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(key + GUID));
  return btoa(String.fromCharCode(...new Uint8Array(d)));
}

function HandshakeInspector() {
  const { hello, status } = useLive();
  const [check, setCheck] = useState(null);
  const key = hello?.handshake.request.find((l) => /^sec-websocket-key:/i.test(l))?.split(': ')[1];
  const accept = hello?.handshake.response.find((l) => /^sec-websocket-accept:/i.test(l))?.split(': ')[1];
  useEffect(() => { if (key && accept && crypto?.subtle) acceptFor(key).then((c) => setCheck({ computed: c, ok: c === accept })); }, [key, accept]);
  return (
    <div className="ns-card p-3 mb-3">
      <h6>WebSocket handshake inspector <span className={`ns-pill ms-2 ${status === 'open' ? 'ok' : 'bad'}`}>{status}</span></h6>
      <p className="ns-muted small">HTTP/1.1 upgrade on the same TCP connection (port 4000 or your dev port). After <code>101 Switching Protocols</code> the connection carries WebSocket frames: the agent pushes a snapshot every second, so the dashboard never polls.</p>
      {hello ? (
        <div className="row g-3">
          <div className="col-md-6"><div className="small fw-semibold mb-1">Client request</div><pre className="ns-pre">{hello.handshake.request.join('\n')}</pre></div>
          <div className="col-md-6"><div className="small fw-semibold mb-1">Server response</div><pre className="ns-pre">{hello.handshake.response.join('\n')}</pre></div>
          <div className="col-12 small">
            <code>Sec-WebSocket-Accept = base64( SHA-1( Sec-WebSocket-Key + "{GUID}" ) )</code>
            {check && <div className="mt-1">Computed in this browser: <span className="ns-mono">{check.computed}</span> {check.ok ? <span className="ns-pill ok">matches the server</span> : <span className="ns-pill bad">mismatch</span>}</div>}
          </div>
        </div>
      ) : <div className="ns-muted">Waiting for the connection…</div>}
    </div>
  );
}

const LAYERS = [
  ['Application', 'REST (HTTP/1.1 + JSON + JWT), WebSocket push, DNS query inside the UDP probe', 'Express routes, ws server, hand-built DNS packet'],
  ['Transport', 'TCP connect time to :443 (3-way handshake); UDP datagrams to :53 for loss, RTT and jitter', 'net.createConnection({ localAddress }), dgram socket bound to the adapter IP'],
  ['Network', 'IPv4 addressing and subnets, ICMP echo, routing table, route metrics, pinned /32 host routes', 'ping.exe -S, New-NetRoute, Set-NetIPInterface, Find-NetRoute'],
  ['Link', 'Wi-Fi (802.11) and USB tethering (Remote NDIS) as two separate interfaces', 'Get-NetIPConfiguration, netsh wlan show networks'],
];

function LayerMap() {
  return (
    <div className="ns-card p-3 mb-3"><h6>Where each protocol appears in NetSwitch</h6>
      <Table size="sm" responsive className="ns-table align-middle mb-0"><thead><tr><th>Layer</th><th>What NetSwitch does there</th><th>How</th></tr></thead>
        <tbody>{LAYERS.map(([l, w, h]) => <tr key={l}><td><b>{l}</b></td><td>{w}</td><td className="ns-mono">{h}</td></tr>)}</tbody></Table>
    </div>
  );
}

function LoopStepper() {
  const { snapshot: s } = useLive();
  const [i, setI] = useState(0);
  const a = s?.adapters.find((x) => x.id === s.activeId) ?? s?.adapters[0];
  const p = a?.parts ?? {};
  const f = (v, d = 2) => (v == null ? '—' : Number(v).toFixed(d));
  const steps = [
    ['1. Probe', `Every 200 ms a UDP DNS query goes to a pinned target through ${a?.alias ?? 'the adapter'}. A reply gives an RTT; no reply within 1 s counts as lost (never as 0 ms). TCP :443 and ICMP run every 2 s.`],
    ['2. Window', `The last 10 s of probes form the window: ${a?.samples ?? '—'} probes, loss ${f(a?.lossPct, 0)}%, median RTT ${f(a?.rttMs, 0)} ms, jitter ${f(a?.jitterMs, 1)} ms (mean absolute difference of consecutive RTTs).`],
    ['3. Penalties', `p = min(1, value / limit). Loss ${f(p.loss)}, latency ${f(p.latency)}, jitter ${f(p.jitter)}, TCP ${p.tcp == null ? 'missing (weight redistributed)' : f(p.tcp)}.`],
    ['4. Score', `S = 100 × (1 − Σ weight × p) = ${a?.score ?? 'not available yet'} → ${a?.band ?? '—'}. Fewer than 20 probes means no score, and no score means no switching.`],
    ['5. Decide', `decide(state, inputs, now, config) is a pure function. Hard failure (15 lost probes in a row and a failed TCP connect) switches immediately. Degradation needs a 20-point lead for 5 evaluations. Hold-down is 30 s. Current phase: ${s?.phase ?? '—'}.`],
    ['6. Switch and verify', 'The controller sets the target adapter metric to 5 and the others to 75, asks Windows which interface it would use for an unpinned address, then opens a TCP connection and checks the source address. If anything disagrees, it rolls back.'],
  ];
  return (
    <div className="ns-card p-3"><h6>One pass of the control loop (live numbers)</h6>
      <div className="d-flex gap-2 mb-3"><Button size="sm" variant="outline-dark" disabled={i === 0} onClick={() => setI(i - 1)}>Previous</Button><Button size="sm" disabled={i === steps.length - 1} onClick={() => setI(i + 1)}>Next</Button></div>
      {steps.map(([t, d], k) => <div key={t} className={`ns-step mb-2 ${k === i ? 'on' : ''}`} style={{ opacity: k === i ? 1 : 0.45 }}><b>{t}</b><div className="small">{k === i ? d : ''}</div></div>)}
    </div>
  );
}

export default function Learn() {
  return (<><h4 className="mb-3">How NetSwitch works</h4><LayerMap /><HandshakeInspector /><LoopStepper /></>);
}
