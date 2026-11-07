import React, { useCallback, useEffect, useState } from 'react';
import { Button, Col, Form, Modal, Row } from 'react-bootstrap';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../api.js';
import { useLive } from '../live.jsx';
import FailoverTable from '../components/FailoverTable.jsx';

export default function History() {
  const { snapshot } = useLive();
  const ids = snapshot?.adapters.map((a) => a.id) ?? [];
  const [key, setKey] = useState('');
  const [minutes, setMinutes] = useState(15);
  const [data, setData] = useState(null);
  const [events, setEvents] = useState([]);
  const [showSql, setShowSql] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (!key && ids.length) setKey(ids[0]); }, [ids, key]);
  const load = useCallback(async () => {
    if (!key) return;
    try { setErr(''); setData(await api(`/api/readings?interface=${key}&minutes=${minutes}`)); setEvents((await api('/api/failovers?limit=20')).events); }
    catch (e) { setErr(e.message); }
  }, [key, minutes]);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  const rows = (data?.rows ?? []).map((r) => ({ ...r, label: new Date(r.bucket * 1000).toLocaleTimeString() }));
  const sqlText = data ? (() => { const ps = [...data.params]; return data.sql.replace(/\?/g, () => { const p = ps.shift(); return typeof p === 'string' ? `'${p}'` : String(p); }); })() : '';
  return (
    <>
      <div className="d-flex flex-wrap gap-3 align-items-end mb-3">
        <h4 className="mb-0 me-auto">History</h4>
        <Form.Group><Form.Label className="small mb-0">Interface</Form.Label><Form.Select size="sm" value={key} onChange={(e) => setKey(e.target.value)}>{ids.map((i) => <option key={i}>{i}</option>)}</Form.Select></Form.Group>
        <Form.Group><Form.Label className="small mb-0">Range</Form.Label><Form.Select size="sm" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>{[[5, '5 min'], [15, '15 min'], [60, '1 hour'], [360, '6 hours']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Form.Select></Form.Group>
        <Button size="sm" variant="outline-dark" onClick={() => setShowSql(true)} disabled={!data}>Show SQL</Button>
      </div>
      {err && <div className="text-danger mb-2">{err}</div>}
      <Row className="g-3 mb-3">
        <Col lg={6}><div className="ns-card p-3"><h6>Average score</h6>
          <ResponsiveContainer width="100%" height={240}><LineChart data={rows}><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis dataKey="label" minTickGap={40} /><YAxis width={40} domain={[0, 100]} /><Tooltip /><Line dataKey="score" stroke="#0d9488" dot={false} connectNulls isAnimationActive={false} /></LineChart></ResponsiveContainer></div></Col>
        <Col lg={6}><div className="ns-card p-3"><h6>RTT (ms) and loss (%)</h6>
          <ResponsiveContainer width="100%" height={240}><LineChart data={rows}><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis dataKey="label" minTickGap={40} /><YAxis width={40} /><Tooltip /><Legend /><Line dataKey="rtt_ms" name="RTT ms" stroke="#6366f1" dot={false} connectNulls isAnimationActive={false} /><Line dataKey="loss_pct" name="Loss %" stroke="#dc2626" dot={false} connectNulls isAnimationActive={false} /></LineChart></ResponsiveContainer></div></Col>
      </Row>
      <div className="ns-card p-3"><h6>Failover events (stored in MySQL)</h6><FailoverTable events={events} /></div>
      <Modal show={showSql} onHide={() => setShowSql(false)} size="lg">
        <Modal.Header closeButton><Modal.Title>Query behind these charts</Modal.Title></Modal.Header>
        <Modal.Body>
          <p className="ns-muted small">Readings are written every 5 s. The database averages them into time buckets of {data?.bucketSec} s; the browser only draws the result.</p>
          <pre className="ns-pre">{sqlText}</pre>
        </Modal.Body>
      </Modal>
    </>
  );
}
