import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Col, Form, Row, Table } from 'react-bootstrap';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts';
import { api } from '../api.js';
import { subnetInfo, isIPv4 } from '../subnet.js';

function Calculator({ initIp, initPrefix }) {
  const [ip, setIp] = useState(initIp); const [prefix, setPrefix] = useState(initPrefix);
  useEffect(() => { setIp(initIp); setPrefix(initPrefix); }, [initIp, initPrefix]);
  let info = null; try { info = subnetInfo(ip, Number(prefix)); } catch { /* invalid input */ }
  return (
    <div className="ns-card p-3 h-100">
      <h6>Subnet calculator (computed in your browser)</h6>
      <Row className="g-2 mb-3">
        <Col xs={8}><Form.Control size="sm" value={ip} onChange={(e) => setIp(e.target.value)} isInvalid={!isIPv4(ip)} /></Col>
        <Col xs={4}><Form.Control size="sm" type="number" min={0} max={32} value={prefix} onChange={(e) => setPrefix(e.target.value)} /></Col>
      </Row>
      {info ? (
        <Table size="sm" className="mb-0"><tbody>
          {[['Network', info.network], ['Mask', info.mask], ['Wildcard', info.wildcard], ['Broadcast', info.broadcast], ['First host', info.firstHost], ['Last host', info.lastHost], ['Usable hosts', info.hosts]].map(([k, v]) => <tr key={k}><td className="ns-muted">{k}</td><td className="ns-mono">{v}</td></tr>)}
        </tbody></Table>
      ) : <div className="text-danger small">Enter a valid IPv4 address and a prefix from 0 to 32.</div>}
    </div>
  );
}

function WifiScan() {
  const [res, setRes] = useState(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const scan = async () => { setBusy(true); setErr(''); try { setRes(await api('/api/wifi/scan')); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  return (
    <div className="ns-card p-3 mt-3">
      <div className="d-flex justify-content-between align-items-center"><h6 className="mb-0">Nearby Wi-Fi networks (read-only scan)</h6><Button size="sm" variant="outline-dark" onClick={scan} disabled={busy}>{busy ? 'Scanning…' : 'Scan'}</Button></div>
      <p className="ns-muted small mt-1">Uses <code>netsh wlan show networks mode=bssid</code>. NetSwitch never connects to or tests other networks.</p>
      {err && <div className="text-danger small">{err}</div>}
      {res && <Table size="sm" className="ns-table"><thead><tr><th>SSID</th><th>Security</th><th>BSSID</th><th>Signal</th><th>Band</th><th>Channel</th></tr></thead>
        <tbody>{res.networks.flatMap((n) => n.bssids.map((b) => <tr key={n.ssid + b.bssid}><td>{n.ssid}</td><td>{n.authentication}</td><td className="ns-mono">{b.bssid}</td><td>{b.signal}%</td><td>{b.band}</td><td>{b.channel}</td></tr>))}</tbody></Table>}
    </div>
  );
}

export default function InterfaceDetail() {
  const { key } = useParams();
  const [d, setD] = useState(null); const [err, setErr] = useState('');
  useEffect(() => { let on = true; const load = () => api(`/api/interfaces/${key}`).then((x) => on && setD(x)).catch((e) => on && setErr(e.message)); load(); const t = setInterval(load, 5000); return () => { on = false; clearInterval(t); }; }, [key]);
  if (err) return <div className="text-danger">{err} · <Link to="/">back</Link></div>;
  if (!d) return <div className="ns-muted">Loading…</div>;
  const a = d.adapter;
  const rows = d.recent.map((r) => ({ ...r, label: new Date(r.bucket * 1000).toLocaleTimeString() }));
  return (
    <>
      <div className="mb-3"><Link to="/" className="small">← Dashboard</Link><h4 className="mb-0">{a.alias}</h4><div className="ns-muted">{a.description}</div></div>
      <Row className="g-3">
        <Col lg={6}><div className="ns-card p-3 h-100"><h6>Facts</h6>
          <Table size="sm" className="mb-0"><tbody>
            {[['Kind', a.kind], ['Interface index', a.index], ['IPv4 / prefix', `${a.ip}/${a.prefix}`], ['Default gateway', a.gateway], ['Interface metric', a.metric], ['State', a.band], ['Probe targets (pinned /32 routes)', a.targets.join(', ') || '(simulated)'], ['Path verified', a.pathVerified ? 'yes' : 'no']].map(([k, v]) => <tr key={k}><td className="ns-muted">{k}</td><td className="ns-mono">{String(v)}</td></tr>)}
          </tbody></Table></div></Col>
        <Col lg={6}><Calculator initIp={a.ip} initPrefix={a.prefix} /></Col>
      </Row>
      <div className="ns-card p-3 mt-3"><h6>Last 5 minutes (from the database)</h6>
        <ResponsiveContainer width="100%" height={200}><LineChart data={rows}><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis dataKey="label" minTickGap={40} /><YAxis width={40} /><Tooltip /><Line dataKey="rtt_ms" name="RTT ms" stroke="#6366f1" dot={false} isAnimationActive={false} connectNulls /><Line dataKey="score" name="Score" stroke="#0d9488" dot={false} isAnimationActive={false} connectNulls /></LineChart></ResponsiveContainer></div>
      {a.kind === 'wifi' && <WifiScan />}
    </>
  );
}
