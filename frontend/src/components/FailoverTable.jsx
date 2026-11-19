import React from 'react';
import { Table } from 'react-bootstrap';

const ms = (v) => (v == null ? '—' : `${(v / 1000).toFixed(1)} s`);

function formatDetectOrTotal(v, reason) {
  if (v != null) return `${(v / 1000).toFixed(1)} s`;
  const r = String(reason || '').toLowerCase().replace('-', '_');
  if (r === 'manual' || r === 'degradation' || r === 'switch_back' || r === 'switch back') {
    return <span className="text-muted" style={{ fontSize: '0.78rem' }}>n/a (measured only for hard failures)</span>;
  }
  return '—';
}

export default function FailoverTable({ events }) {
  if (!events?.length) {
    return (
      <div className="ns-empty-state">
        <div className="fw-semibold">No failovers recorded this session</div>
        <div className="small mt-1">Impair or disconnect the active adapter to observe automated failover, or trigger a manual switch from the Control page.</div>
      </div>
    );
  }
  return (
    <Table size="sm" className="ns-table align-middle mb-0" responsive>
      <thead><tr><th>Time</th><th>From → To</th><th>Reason</th><th>Detect</th><th>Switch</th><th>Total</th><th>Result</th></tr></thead>
      <tbody>
        {events.map((e, i) => (
          <tr key={`${e.ts}-${i}`}>
            <td className="ns-mono">{new Date(e.ts).toLocaleTimeString()}</td>
            <td>{e.from} → <b>{e.to}</b></td>
            <td><span className="badge bg-light text-dark border">{String(e.reason).replace('_', ' ')}</span></td>
            <td>{formatDetectOrTotal(e.detectMs, e.reason)}</td>
            <td className="fw-semibold">{ms(e.switchMs)}</td>
            <td>{formatDetectOrTotal(e.totalMs, e.reason)}</td>
            <td>{e.success ? <span className="ns-pill ok">verified</span> : <span className="ns-pill bad" title={e.note}>failed · rolled back</span>}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
