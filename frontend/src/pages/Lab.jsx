import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Form, Tab, Table, Tabs } from 'react-bootstrap';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

const Err = ({ e }) => (e ? <Alert variant="danger" className="py-1 small">{e}</Alert> : null);
function useCall() {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const call = useCallback(async (path, body, method = 'POST') => { setBusy(true); setErr(''); try { return await api(path, { method, body }); } catch (e) { setErr(e.message); return null; } finally { setBusy(false); } }, []);
  return { busy, err, call };
}
const Card = ({ title, children, className = '' }) => <div className={`ns-card p-3 mb-3 ${className}`}>{title && <h6>{title}</h6>}{children}</div>;
const Why = ({ children }) => <div className="ns-muted small mb-2">{children}</div>;

/* ---------- Sockets: TCP + UDP client/server ---------- */
function Sockets() {
  const { user } = useAuth();
  const [status, setStatus] = useState(null);
  const [cmds, setCmds] = useState('HELLO Tanmay\nLIST\nGET notice.txt\nPRIME 1000000');
  const [tcp, setTcp] = useState(null); const [udp, setUdp] = useState(null); const [msg, setMsg] = useState('sin 30');
  const t = useCall(); const u = useCall();
  useEffect(() => { const load = () => api('/api/lab/status').then(setStatus).catch(() => {}); load(); const i = setInterval(load, 2000); return () => clearInterval(i); }, []);
  const s = status?.sockets;
  return (
    <>
      <Card title="Server status (running inside the NetSwitch agent)">
        {s && <div className="d-flex flex-wrap gap-4 small">
          <div><b>TCP server</b> 127.0.0.1:{s.tcp.port}<br />active {s.tcp.active} · peak {s.tcp.peakActive} · total {s.tcp.total} · commands {s.tcp.commands}</div>
          <div><b>UDP server</b> 127.0.0.1:{s.udp.port}<br />received {s.udp.received} · replied {s.udp.replied} · dropped (simulated) {s.udp.dropped}</div>
          <div><b>Worker threads</b><br />{s.pool.threads} threads · busy {s.pool.busy} · queued {s.pool.queued} · done {s.pool.completed}</div>
        </div>}
        {s && <details className="mt-2 small"><summary>Server event log</summary><div className="ns-mono">{s.events.slice(0, 8).map((e, i) => <div key={i}>{new Date(e.t).toLocaleTimeString()} [{e.proto}] {e.text}</div>)}</div></details>}
      </Card>
      <div className="row g-3">
        <div className="col-lg-6"><Card title="TCP client → TCP server (Berkeley sockets, connection-oriented)">
          <Why>Practical 3a: hello and file transfer. TCP is used here because every command needs a reliable, ordered reply, and a file must arrive complete.</Why>
          <Form.Control as="textarea" rows={4} className="ns-mono mb-2" value={cmds} onChange={(e) => setCmds(e.target.value)} />
          <Button size="sm" disabled={t.busy} onClick={async () => setTcp(await t.call('/api/lab/tcp', { commands: cmds.split('\n').map((x) => x.trim()).filter(Boolean) }))}>Run on one connection</Button>
          <Err e={t.err} />
          {tcp && <><div className="small mt-2">client port <b>{tcp.local.port}</b> → server <b>{tcp.server.port}</b> · connect() took <b>{tcp.connectMs} ms</b> (3-way handshake) · total {tcp.totalMs} ms</div>
            <Table size="sm" className="ns-table mt-2"><thead><tr><th>Primitive</th><th>t (ms)</th><th>Detail</th></tr></thead><tbody>{tcp.trace.map((x, i) => <tr key={i}><td className="ns-mono">{x.step}</td><td>{x.ms}</td><td className="ns-mono">{x.note}</td></tr>)}</tbody></Table>
            {tcp.replies.filter((r) => r.body).map((r, i) => <pre key={i} className="ns-pre">{r.body}</pre>)}</>}
        </Card></div>
        <div className="col-lg-6"><Card title="UDP client → UDP server (connectionless datagrams)">
          <Why>Practical 3b: trigonometric calculator. UDP is used because one small request needs one small reply, with no handshake. If a datagram is lost, nobody retransmits.</Why>
          <div className="d-flex gap-2 mb-2"><Form.Control size="sm" className="ns-mono" value={msg} onChange={(e) => setMsg(e.target.value)} />
            <Button size="sm" disabled={u.busy} onClick={async () => setUdp(await u.call('/api/lab/udp', { message: msg }))}>Send</Button></div>
          <div className="d-flex gap-1 flex-wrap mb-2">{['sin 30', 'cos 60', 'tan 45', 'sqrt 144', 'log 1000', 'hello Tanmay', 'primes 2000000'].map((x) => <Button key={x} size="sm" variant="outline-dark" onClick={() => setMsg(x)}>{x}</Button>)}</div>
          <Err e={u.err} />
          {udp && <div className="small">{udp.lost ? <span className="ns-pill bad">LOST</span> : <span className="ns-pill ok">reply in {udp.rttMs} ms</span>} <span className="ns-mono">{udp.reply}</span><div className="ns-muted mt-1">{udp.note}</div><div className="ns-muted">client port {udp.local.port} → server port {udp.server.port}</div></div>}
          {user.role === 'admin' && <div className="mt-3 small"><b>Simulate a lossy network</b> (server ignores datagrams): <span className="ms-2">
            {[0, 30, 70].map((p) => <Button key={p} size="sm" variant="outline-secondary" className="me-1" onClick={() => api('/api/lab/udp-drop', { method: 'POST', body: { pct: p } })}>{p}%</Button>)}</span></div>}
        </Card></div>
      </div>
      <Card title="What Node's calls do (Berkeley socket primitives)">
        <Table size="sm" className="ns-table mb-0"><thead><tr><th>Berkeley primitive</th><th>TCP server / client in Node</th><th>UDP in Node</th></tr></thead><tbody>
          <tr><td>socket() + bind() + listen()</td><td className="ns-mono">net.createServer().listen(port)</td><td className="ns-mono">dgram.createSocket('udp4').bind(port)</td></tr>
          <tr><td>accept()</td><td className="ns-mono">'connection' event</td><td>(none: no connections)</td></tr>
          <tr><td>connect()</td><td className="ns-mono">net.connect() — the 3-way handshake</td><td>(none)</td></tr>
          <tr><td>send() / recv()</td><td className="ns-mono">socket.write() / 'data' event</td><td className="ns-mono">socket.send() / 'message' (sendto/recvfrom)</td></tr>
          <tr><td>close()</td><td className="ns-mono">socket.end() — FIN handshake</td><td className="ns-mono">socket.close()</td></tr></tbody></Table>
      </Card>
    </>
  );
}

/* ---------- Concurrency / threads ---------- */
function Threads() {
  const [n, setN] = useState(5); const [cmd, setCmd] = useState('SLEEP 400'); const [r, setR] = useState(null); const c = useCall();
  return (
    <>
      <Card title="Concurrent clients (the 'multithreaded server' question)">
        <Why>Node runs JavaScript on one thread, but the operating system multiplexes many sockets (epoll/IOCP) so many clients are served at the same time. CPU-heavy work (PRIME) is sent to real worker threads, so one heavy request cannot freeze the others.</Why>
        <div className="d-flex gap-2 align-items-end flex-wrap">
          <Form.Group><Form.Label className="small mb-0">Clients</Form.Label><Form.Select size="sm" value={n} onChange={(e) => setN(Number(e.target.value))}>{[1, 2, 3, 5, 8, 10].map((x) => <option key={x}>{x}</option>)}</Form.Select></Form.Group>
          <Form.Group><Form.Label className="small mb-0">Each client sends</Form.Label><Form.Select size="sm" value={cmd} onChange={(e) => setCmd(e.target.value)}>{['SLEEP 400', 'SLEEP 1000', 'PRIME 5000000', 'PRIME 20000000', 'TIME'].map((x) => <option key={x}>{x}</option>)}</Form.Select></Form.Group>
          <Button size="sm" disabled={c.busy} onClick={async () => setR(await c.call('/api/lab/concurrency', { clients: n, command: cmd }))}>Run {n} clients at once</Button>
        </div>
        <Err e={c.err} />
        {r && <div className="mt-3"><div className="d-flex gap-4 mb-2"><div className="ns-stat"><span className="v">{r.wallClockMs} ms</span><span className="k">wall clock (parallel)</span></div><div className="ns-stat"><span className="v">{r.sumOfIndividualMs} ms</span><span className="k">sum if served one by one</span></div><div className="ns-stat"><span className="v">{r.peakActiveConnections}</span><span className="k">peak open connections</span></div></div>
          <Table size="sm" className="ns-table mb-0"><thead><tr><th>Client</th><th>Finished at</th><th>Own time</th><th>Reply</th></tr></thead><tbody>{r.runs.map((x) => <tr key={x.client}><td>#{x.client}</td><td>{x.finishedAtMs} ms</td><td>{x.ownMs} ms</td><td className="ns-mono">{x.reply}</td></tr>)}</tbody></Table></div>}
      </Card>
      <Card title="Where each kind of concurrency is used in NetSwitch">
        <Table size="sm" className="ns-table mb-0"><thead><tr><th>Mechanism</th><th>Used for</th><th>Why</th></tr></thead><tbody>
          <tr><td>Event loop + async I/O (libuv)</td><td>Probes on both adapters, WebSocket clients, REST requests, the TCP/UDP lab servers</td><td>Work is I/O-bound: threads would mostly sleep waiting for packets</td></tr>
          <tr><td>worker_threads (OS threads)</td><td>PRIME and trigonometry in the lab servers</td><td>CPU-bound work must not block the event loop</td></tr>
          <tr><td>Child processes</td><td>ping.exe, PowerShell, netsh, tracert</td><td>Reuse trusted OS tools; separate address space</td></tr>
          <tr><td>Mutex-style lock</td><td>Only one adapter switch at a time</td><td>Prevents a race on the routing table (critical section)</td></tr></tbody></Table>
      </Card>
    </>
  );
}

/* ---------- Routing: Dijkstra / link state ---------- */
const SAMPLE = '[["A","B",7],["A","C",9],["A","F",14],["B","C",10],["B","D",15],["C","D",11],["C","F",2],["D","E",6],["E","F",9]]';
function Steps({ r }) {
  if (!r) return null;
  return (<div className="mt-2">
    <div className="mb-2">{r.reachable ? <>Shortest path <b>{r.path.join(' → ')}</b>, total cost <b>{r.distance}</b></> : 'Destination unreachable'}</div>
    <Table size="sm" className="ns-table mb-0"><thead><tr><th>Step</th><th>Visit (smallest tentative distance)</th><th>Relaxed edges</th></tr></thead><tbody>{r.steps.map((s, i) => <tr key={i}><td>{i + 1}</td><td><b>{s.visit}</b> (d={s.distance})</td><td className="ns-mono">{s.relaxed.length ? s.relaxed.map((x) => `${x.to}: ${x.old}→${x.new} via ${x.via}`).join(' · ') : '—'}</td></tr>)}</tbody></Table></div>);
}
function GraphSvg({ edges, path }) {
  const gws = [...new Set(edges.flatMap((e) => [e[0], e[1]]).filter((n) => n !== 'Laptop' && n !== 'Internet'))];
  const pos = { Laptop: [60, 110], Internet: [540, 110] }; gws.forEach((g, i) => { pos[g] = [300, 40 + i * 140 / Math.max(1, gws.length - 1 || 1) * (gws.length > 1 ? 1 : 0) + (gws.length > 1 ? 0 : 70)]; });
  const on = (a, b) => path?.some((p, i) => (p === a && path[i + 1] === b) || (p === b && path[i + 1] === a));
  return (<svg viewBox="0 0 600 220" className="w-100" role="img" aria-label="link state graph">
    {edges.map(([a, b, w], i) => { const [x1, y1] = pos[a]; const [x2, y2] = pos[b]; return <g key={i}><line x1={x1} y1={y1} x2={x2} y2={y2} stroke={on(a, b) ? '#0d9488' : '#94a3b8'} strokeWidth={on(a, b) ? 4 : 2} /><text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} fontSize="12" textAnchor="middle" fill="#0f172a">cost {w}</text></g>; })}
    {Object.entries(pos).map(([n, [x, y]]) => <g key={n}><circle cx={x} cy={y} r="8" fill={path?.includes(n) ? '#0d9488' : '#64748b'} /><text x={x} y={y + 24} fontSize="11" textAnchor="middle" fill="#0f172a">{n}</text></g>)}
  </svg>);
}
function Routing() {
  const [live, setLive] = useState(null); const [edges, setEdges] = useState(SAMPLE); const [src, setSrc] = useState('A'); const [dst, setDst] = useState('E'); const [r, setR] = useState(null); const c = useCall();
  useEffect(() => { const load = () => api('/api/lab/routing-graph').then(setLive).catch(() => {}); load(); const i = setInterval(load, 3000); return () => clearInterval(i); }, []);
  return (
    <>
      <Card title="Link-state view of this laptop (live)">
        <Why>OSPF routers flood link costs and each runs Dijkstra on the resulting graph. NetSwitch does the same locally: the link cost is the measured RTT plus 10 × loss%, and Dijkstra picks the cheapest way from the laptop to the Internet.</Why>
        {live?.result ? <><GraphSvg edges={live.edges} path={live.result.path} /><Steps r={live.result} />
          <div className="small ns-muted mt-2">OSPF interface cost = 100 Mbps ÷ bandwidth: {live.ospfExample.map((o) => `${o.mbps} Mbps → ${o.cost}`).join(' · ')}. Windows derives its automatic interface metric from link speed in the same spirit (the USB RNDIS adapter reports 0 bps, which is why we set metrics by hand).</div></> : <div className="ns-muted">Waiting for adapters…</div>}
      </Card>
      <Card title="Practical 2: Dijkstra on a graph given by the instructor">
        <Why>Edit the edge list as JSON: [from, to, cost]. Links are bidirectional. Costs must not be negative.</Why>
        <Form.Control as="textarea" rows={3} className="ns-mono mb-2" value={edges} onChange={(e) => setEdges(e.target.value)} />
        <div className="d-flex gap-2 align-items-center"><Form.Control size="sm" style={{ width: 90 }} value={src} onChange={(e) => setSrc(e.target.value)} /> → <Form.Control size="sm" style={{ width: 90 }} value={dst} onChange={(e) => setDst(e.target.value)} />
          <Button size="sm" disabled={c.busy} onClick={async () => { try { setR(await c.call('/api/lab/dijkstra', { edges: JSON.parse(edges), src, dst })); } catch { setR(null); alert('Edges must be valid JSON'); } }}>Run Dijkstra</Button></div>
        <Err e={c.err} /><Steps r={r} />
      </Card>
    </>
  );
}

/* ---------- Packets ---------- */
function Packets() {
  const [p, setP] = useState(null);
  useEffect(() => { api('/api/lab/packet').then(setP).catch(() => {}); }, []);
  if (!p) return null;
  return (
    <>
      <Card title="Practical 3c: anatomy of NetSwitch's UDP/DNS probe">
        <Why>Frame size {p.totalFrameBytes} bytes. Capture with Wireshark using the filter <code>{p.wiresharkFilter}</code> and compare every field below with your capture.</Why>
        {p.layers.map((l) => (<div key={l.layer} className="border rounded p-2 mb-2"><b>{l.layer}</b> <span className="ns-pill ms-1">{l.size} bytes</span>
          <Table size="sm" className="ns-table mb-0 mt-1"><tbody>{l.fields.map(([k, sz, v], i) => <tr key={i}><td style={{ width: '24%' }}>{k}</td><td style={{ width: '8%' }}>{sz}</td><td className="ns-mono">{v}</td></tr>)}</tbody></Table></div>))}
        <div className="small ns-muted">DNS payload bytes: <span className="ns-mono">{p.dnsHex}</span></div><div className="small ns-muted mt-1">{p.note}</div>
      </Card>
    </>
  );
}

/* ---------- Mail ---------- */
function Mail() {
  const [subject, setSubject] = useState('NetSwitch test: failover alert'); const [text, setText] = useState('Hello from the SMTP client.\nThis message travelled over TCP port 25 style dialog.');
  const [tr, setTr] = useState(null); const [pop, setPop] = useState(null); const [box, setBox] = useState([]); const c = useCall();
  const load = useCallback(() => api('/api/lab/mail').then((x) => setBox(x.messages)).catch(() => {}), []);
  useEffect(() => { load(); const i = setInterval(load, 3000); return () => clearInterval(i); }, [load]);
  return (
    <div className="row g-3">
      <div className="col-lg-6"><Card title="SMTP client → SMTP server (send)">
        <Why>Every real failover also sends an alert mail through this server. SMTP is a text dialog over TCP; MIME headers describe the content type and encoding.</Why>
        <Form.Control size="sm" className="mb-2" value={subject} onChange={(e) => setSubject(e.target.value)} />
        <Form.Control as="textarea" rows={3} className="mb-2" value={text} onChange={(e) => setText(e.target.value)} />
        <Button size="sm" disabled={c.busy} onClick={async () => { const r = await c.call('/api/lab/mail/send', { subject, text }); if (r) { setTr(r.transcript); load(); } }}>Send mail</Button>
        <Err e={c.err} />{tr && <pre className="ns-pre mt-2" style={{ maxHeight: 260 }}>{tr.join('\n')}</pre>}
      </Card></div>
      <div className="col-lg-6"><Card title="Mailbox (POP3 retrieve)">
        <Button size="sm" variant="outline-dark" className="mb-2" onClick={async () => setPop((await c.call('/api/lab/mail/pop3', undefined, 'GET'))?.transcript)}>Fetch with POP3</Button>
        {pop && <pre className="ns-pre mb-2" style={{ maxHeight: 200 }}>{pop.join('\n')}</pre>}
        <Table size="sm" className="ns-table mb-0"><thead><tr><th>#</th><th>Subject</th><th>MIME</th></tr></thead><tbody>{box.map((m) => <tr key={m.id}><td>{m.id}</td><td>{m.subject}<div className="ns-muted small">{new Date(m.receivedAt).toLocaleTimeString()}</div></td><td className="ns-mono small">{m.mime.type}<br />{m.mime.encoding}</td></tr>)}</tbody></Table>
      </Card></div>
    </div>
  );
}

/* ---------- Tools ---------- */
const NEEDS_HOST = ['ping', 'tracert', 'nslookup', 'tls'];
function Tools() {
  const [tool, setTool] = useState('ping'); const [target, setTarget] = useState('1.1.1.1'); const [r, setR] = useState(null); const c = useCall();
  return (
    <Card title="Practical 1b: network commands (fixed, whitelisted, no shell)">
      <Why>ping/tracert = ICMP · arp = address resolution · netstat = sockets · route = routing table · ipconfig = addresses · nslookup = DNS over UDP 53 · tls = HTTPS handshake with ALPN (HTTP/2 negotiation).</Why>
      <div className="d-flex gap-2 flex-wrap mb-2">
        <Form.Select size="sm" style={{ width: 150 }} value={tool} onChange={(e) => { setTool(e.target.value); setR(null); }}>{['ping', 'tracert', 'arp', 'netstat', 'route', 'ipconfig', 'nbtstat', 'nslookup', 'tls'].map((x) => <option key={x}>{x}</option>)}</Form.Select>
        {NEEDS_HOST.includes(tool) && <Form.Control size="sm" style={{ width: 220 }} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="host or IPv4" />}
        <Button size="sm" disabled={c.busy} onClick={async () => setR(await c.call('/api/lab/tool', { tool, target }))}>{c.busy ? 'Running…' : 'Run'}</Button>
      </div>
      <Err e={c.err} />
      {r?.what && <div className="small ns-muted mb-1">{r.what}</div>}{r?.command && <div className="ns-mono small mb-1">&gt; {r.command}</div>}
      {r && (r.output ? <pre className="ns-pre" style={{ maxHeight: 360 }}>{r.output}</pre> : <pre className="ns-pre">{JSON.stringify(r, null, 2)}</pre>)}
    </Card>
  );
}

export default function Lab() {
  return (<><h4 className="mb-1">Lab: the syllabus concepts, running live</h4><p className="ns-muted">Each tab maps to a practical or unit. Everything here uses real sockets, real protocols and the real database-backed agent.</p>
    <Tabs defaultActiveKey="sockets" className="mb-3" mountOnEnter unmountOnExit>
      <Tab eventKey="sockets" title="TCP / UDP sockets"><Sockets /></Tab><Tab eventKey="threads" title="Threads & concurrency"><Threads /></Tab><Tab eventKey="routing" title="Routing (Dijkstra)"><Routing /></Tab>
      <Tab eventKey="packets" title="Packets (Wireshark)"><Packets /></Tab><Tab eventKey="mail" title="Mail (SMTP/POP3)"><Mail /></Tab><Tab eventKey="tools" title="Network tools"><Tools /></Tab>
    </Tabs></>);
}
