import React from 'react';
import { Table } from 'react-bootstrap';

const ms = (v) => (v == null ? '—' : `${(v / 1000).toFixed(1)} s`);

function formatAdapter(id) {
  if (!id) return '—';
  const s = String(id).trim().toLowerCase();
  if (s === 'wifi') return 'Wi-Fi';
  if (s === 'usb') return 'USB';
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function formatReason(r) {
  if (!r) return '—';
  return String(r)
    .split(/[_\s-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function formatDetect(e) {
  if (e.detectMs != null) {
    return `${(e.detectMs / 1000).toFixed(1)} s`;
  }
  const r = String(e.reason || '').toLowerCase().replace('-', '_');
  if (r === 'manual') {
    return <span className="text-secondary small" title="Manual switch triggered directly by user">Immediate</span>;
  }
  if (r === 'degradation') {
    return <span className="text-secondary small" title="Triggered after 5 consecutive checks exceeding degradation margin">5 checks (window)</span>;
  }
  if (r === 'switch_back' || r === 'switch back') {
    return <span className="text-secondary small" title="Verified after 10 consecutive healthy checks">10 checks (window)</span>;
  }
  return <span className="text-muted small">—</span>;
}

function formatTotal(e) {
  if (e.totalMs != null) {
    return `${(e.totalMs / 1000).toFixed(1)} s`;
  }
  if (e.switchMs != null) {
    return `${(e.switchMs / 1000).toFixed(1)} s`;
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
      <thead>
        <tr>
          <th>Time</th>
          <th>From → To</th>
          <th>Reason</th>
          <th>Detect</th>
          <th>Switch</th>
          <th>Total</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        {events.map((e, i) => (
          <tr key={`${e.ts}-${i}`}>
            <td className="ns-mono">{new Date(e.ts).toLocaleTimeString()}</td>
            <td>
              <span className="fw-medium">{formatAdapter(e.from)}</span> → <b>{formatAdapter(e.to)}</b>
            </td>
            <td>
              <span className="badge bg-light text-dark border">
                {formatReason(e.reason)}
              </span>
            </td>
            <td>{formatDetect(e)}</td>
            <td className="fw-semibold">{ms(e.switchMs)}</td>
            <td className="fw-semibold text-dark">{formatTotal(e)}</td>
            <td>
              {e.success ? (
                <span className="ns-pill ok">Verified</span>
              ) : (
                <span className="ns-pill bad" title={e.note}>
                  Failed · Rolled Back
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
