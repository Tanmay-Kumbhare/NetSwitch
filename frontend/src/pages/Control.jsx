import React, { useEffect, useState } from 'react';
import { Alert, Button, Col, Form, Row, Table } from 'react-bootstrap';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useLive } from '../live.jsx';

function SimPanel({ adapters }) {
  const [msg, setMsg] = useState('');
  const send = async (adapter, patch) => { try { await api('/api/sim/impair', { method: 'POST', body: { adapter, ...patch } }); setMsg(''); } catch (e) { setMsg(e.message); } };
  return (
    <div className="ns-card p-3 mb-3">
      <h6>Simulation: inject faults</h6>
      <p className="ns-muted small">Simulation mode only. On Windows you use Clumsy instead (filter shown below).</p>
      {msg && <Alert variant="danger" className="py-1">{msg}</Alert>}
      <Row className="g-3">
        {adapters.map((a) => (
          <Col md={6} key={a.id}><div className="border rounded p-2">
            <b>{a.alias}</b>
            <div className="d-flex flex-wrap gap-2 mt-2">
              <Button size="sm" variant="outline-warning" onClick={() => send(a.id, { lossPct: 20, latencyMs: 380 })}>Degrade (20% loss, 380 ms)</Button>
              <Button size="sm" variant="outline-danger" onClick={() => send(a.id, { blackhole: true })}>Blackhole (link up, no traffic)</Button>
              <Button size="sm" variant="outline-danger" onClick={() => send(a.id, { down: true })}>Disconnect</Button>
              <Button size="sm" variant="outline-success" onClick={() => send(a.id, { lossPct: 0, latencyMs: a.kind === 'wifi' ? 35 : 45, blackhole: false, down: false })}>Heal</Button>
            </div>
          </div></Col>
        ))}
      </Row>
    </div>
  );
}

function ConfigForm({ isAdmin }) {
  const [cfg, setCfg] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => { api('/api/config').then(setCfg).catch((e) => setMsg({ v: 'danger', t: e.message })); }, []);
  if (!cfg) return null;
  const setD = (k, v) => setCfg({ ...cfg, decide: { ...cfg.decide, [k]: Number(v) } });
  const setW = (k, v) => setCfg({ ...cfg, score: { ...cfg.score, weights: { ...cfg.score.weights, [k]: Number(v) } } });
  const save = async () => { try { setCfg({ ...cfg, ...(await api('/api/config', { method: 'PUT', body: { decide: cfg.decide, score: cfg.score } })) }); setMsg({ v: 'success', t: 'Saved. Stored in MySQL and applied immediately.' }); } catch (e) { setMsg({ v: 'danger', t: e.message }); } };
  return (
    <div className="ns-card p-3">
      <h6>Decision thresholds and score weights</h6>
      {msg && <Alert variant={msg.v} className="py-1">{msg.t}</Alert>}
      <Row className="g-3">
        {Object.entries(cfg.decide).map(([k, v]) => <Col xs={6} md={3} key={k}><Form.Label className="small mb-0">{k}</Form.Label><Form.Control size="sm" type="number" value={v} disabled={!isAdmin} onChange={(e) => setD(k, e.target.value)} /></Col>)}
        {Object.entries(cfg.score.weights).map(([k, v]) => <Col xs={6} md={3} key={k}><Form.Label className="small mb-0">weight · {k}</Form.Label><Form.Control size="sm" type="number" step="0.05" value={v} disabled={!isAdmin} onChange={(e) => setW(k, e.target.value)} /></Col>)}
      </Row>
      {isAdmin && <Button size="sm" className="mt-3" onClick={save}>Save</Button>}
    </div>
  );
}

export default function Control() {
  const { user } = useAuth();
  const { snapshot: s } = useLive();
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!s) return <div className="ns-muted">Waiting for the agent…</div>;
  const isAdmin = user.role === 'admin';
  const enabled = isAdmin && s.canControl && !s.switching && !busy;
  const run = async (fn) => { setBusy(true); setMsg(null); try { const r = await fn(); setMsg({ v: r.ok === false ? 'warning' : 'success', t: r.note || 'Done.' }); } catch (e) { setMsg({ v: 'danger', t: e.message }); } finally { setBusy(false); } };
  return (
    <>
      <h4 className="mb-3">Control</h4>
      {!isAdmin && <Alert variant="info">You are a viewer. Only the admin can switch adapters or edit thresholds.</Alert>}
      {isAdmin && !s.canControl && <Alert variant="warning">Control is disabled because the agent is not running as Administrator. Restart the terminal as Administrator.</Alert>}
      {msg && <Alert variant={msg.v} dismissible onClose={() => setMsg(null)}>{msg.t}</Alert>}
      <div className="ns-card p-3 mb-3">
        <Table size="sm" className="ns-table align-middle mb-2">
          <thead><tr><th>Adapter</th><th>Interface</th><th>Metric</th><th>Score</th><th /></tr></thead>
          <tbody>
            {s.adapters.map((a) => (
              <tr key={a.id}>
                <td><b>{a.alias}</b> {a.id === s.activeId && <span className="ns-pill live ms-1">ACTIVE</span>}</td>
                <td className="ns-mono">#{a.index} · {a.ip}</td><td>{a.metric}</td><td>{a.score ?? '—'}</td>
                <td className="text-end"><Button size="sm" disabled={!enabled || a.id === s.activeId || !a.up} onClick={() => run(() => api('/api/control/switch', { method: 'POST', body: { to: a.id } }))}>Make active</Button></td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="ns-muted small mb-2">Switching changes only the Windows interface metric (lowest = preferred), then verifies the route and the source address of a new connection. If verification fails, the previous metrics are restored.</p>
        <Button size="sm" variant="outline-danger" disabled={!enabled} onClick={() => run(() => api('/api/control/restore', { method: 'POST' }))}>Restore original adapter settings</Button>
      </div>
      {s.mode === 'sim' ? <SimPanel adapters={s.adapters} /> : (
        <div className="ns-card p-3 mb-3">
          <h6>Testing with Clumsy (Windows)</h6>
          <p className="ns-muted small">Run clumsy.exe as Administrator, tick Lag (150 ms) and Drop (10%), Inbound and Outbound, and use the filter for the adapter to impair:</p>
          {s.adapters.map((a) => <div key={a.id} className="mb-1"><b>{a.alias}:</b> <code>{`ip and (ip.SrcAddr == ${a.ip} or ip.DstAddr == ${a.ip})`}</code></div>)}
        </div>
      )}
      <ConfigForm isAdmin={isAdmin} />
    </>
  );
}
