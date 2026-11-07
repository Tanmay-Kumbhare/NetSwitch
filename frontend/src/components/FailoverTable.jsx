import React from 'react';
import { Table } from 'react-bootstrap';

const ms = (v) => (v == null ? '—' : `${(v / 1000).toFixed(1)} s`);
export default function FailoverTable({ events }) {
  if (!events?.length) return <div className="ns-muted p-3">No failovers yet. Impair or disconnect the active adapter to see one.</div>;
  return (
    <Table size="sm" className="ns-table align-middle mb-0" responsive>
      <thead><tr><th>Time</th><th>From → To</th><th>Reason</th><th>Detect</th><th>Switch</th><th>Total</th><th>Result</th></tr></thead>
      <tbody>
        {events.map((e, i) => (
          <tr key={`${e.ts}-${i}`}>
            <td className="ns-mono">{new Date(e.ts).toLocaleTimeString()}</td>
            <td>{e.from} → <b>{e.to}</b></td>
            <td>{String(e.reason).replace('_', ' ')}</td>
            <td>{ms(e.detectMs)}</td><td>{ms(e.switchMs)}</td><td>{ms(e.totalMs)}</td>
            <td>{e.success ? <span className="ns-pill ok">verified</span> : <span className="ns-pill bad" title={e.note}>failed · rolled back</span>}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
