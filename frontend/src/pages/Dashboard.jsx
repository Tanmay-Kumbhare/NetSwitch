import React from 'react';
import { Alert, Col, Row } from 'react-bootstrap';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useLive } from '../live.jsx';
import AdapterCard from '../components/AdapterCard.jsx';
import FailoverTable from '../components/FailoverTable.jsx';

const COLORS = ['#0d9488', '#6366f1', '#d97706', '#db2777'];
const PHASE = { STABLE: ['ok', 'Stable'], HOLD_DOWN: ['live', 'Hold-down'], UNVERIFIED: ['', 'Warming up'], NO_INTERNET: ['bad', 'No verified internet'], FAILING_OVER: ['sim', 'Failing over…'], MONITOR_ONLY: ['', 'Monitor only'] };

export default function Dashboard() {
  const { snapshot: s, series, events, status } = useLive();
  if (!s) return <div className="ns-muted">{status === 'open' ? 'Waiting for the first snapshot…' : 'Connecting to the agent…'}</div>;
  const [cls, label] = PHASE[s.phase] || ['', s.phase];
  return (
    <>
      <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
        <h4 className="mb-0 me-2">Live network status</h4>
        <span className={`ns-pill ${cls}`}>{label}</span>
        {s.holdRemainingMs > 0 && <span className="ns-pill">hold-down {Math.ceil(s.holdRemainingMs / 1000)} s</span>}
        <span className="ns-pill">Preferred: {s.preferredId ?? '—'}</span>
      </div>
      {!s.canControl && <Alert variant="warning">Monitor-only mode: run the agent as Administrator to pin probe routes and enable switching. Scores shown without verified routes are not per-adapter measurements.</Alert>}
      {s.phase === 'NO_INTERNET' && <Alert variant="danger">No adapter has verified internet. NetSwitch will not switch until a candidate is healthy.</Alert>}
      <Row className="g-3 mb-3">
        {s.adapters.map((a) => <Col md={6} key={a.id}><AdapterCard a={a} active={a.id === s.activeId} /></Col>)}
      </Row>
      <Row className="g-3 mb-3">
        <Col lg={6}><div className="ns-card p-3"><h6>Latest RTT per adapter (ms)</h6>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={series}><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis dataKey="label" hide /><YAxis width={40} /><Tooltip /><Legend />
              {s.adapters.map((a, i) => <Line key={a.id} type="monotone" dataKey={`${a.id}_rtt`} name={a.alias} stroke={COLORS[i % 4]} dot={false} isAnimationActive={false} connectNulls />)}
            </LineChart>
          </ResponsiveContainer></div></Col>
        <Col lg={6}><div className="ns-card p-3"><h6>Score per adapter (0–100)</h6>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={series}><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis dataKey="label" hide /><YAxis width={40} domain={[0, 100]} /><Tooltip /><Legend />
              {s.adapters.map((a, i) => <Line key={a.id} type="monotone" dataKey={`${a.id}_score`} name={a.alias} stroke={COLORS[i % 4]} dot={false} isAnimationActive={false} connectNulls />)}
            </LineChart>
          </ResponsiveContainer></div></Col>
      </Row>
      <div className="ns-card p-3"><h6>Failover timeline (this session)</h6><FailoverTable events={events} /></div>
    </>
  );
}
