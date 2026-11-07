import React from 'react';
import { Link } from 'react-router-dom';
import Gauge from './Gauge.jsx';

const f = (v, d = 0, unit = '') => (v == null ? '—' : `${Number(v).toFixed(d)}${unit}`);
export const BAND_LABEL = { healthy: 'Healthy', degraded: 'Degraded', unhealthy: 'Unhealthy', unverified: 'Warming up', down: 'Down' };

function Stat({ k, v }) { return <div className="ns-stat"><span className="v">{v}</span><span className="k">{k}</span></div>; }

export default function AdapterCard({ a, active }) {
  return (
    <div className={`ns-card p-3 h-100 ${active ? 'active' : ''} ${!a.up ? 'down' : ''}`}>
      <div className="d-flex justify-content-between align-items-start mb-2">
        <div>
          <Link to={`/interfaces/${a.id}`} className="fw-semibold text-decoration-none text-dark">{a.alias}</Link>
          <div className="ns-muted ns-mono">{a.ip}/{a.prefix} · gw {a.gateway}</div>
        </div>
        <div className="text-end d-flex flex-column gap-1 align-items-end">
          {active && <span className="ns-pill live">ACTIVE</span>}
          <span className="ns-pill">{a.kind.toUpperCase()} · metric {a.metric}</span>
        </div>
      </div>
      <div className="d-flex align-items-center gap-3">
        <Gauge score={a.score} band={a.band} />
        <div>
          <div className={`fw-semibold ns-band-${a.band}`}>{BAND_LABEL[a.band] || a.band}</div>
          <div className="ns-muted small">{a.samples} probes in window</div>
          <div className="d-flex gap-1 flex-wrap mt-1">
            {a.udpFiltered && <span className="ns-pill bad">UDP FILTERED · ICMP fallback</span>}
            {!a.pathVerified && <span className="ns-pill bad" title={a.pinError || ''}>PATH UNVERIFIED</span>}
          </div>
        </div>
      </div>
      <hr className="my-3" />
      <div className="d-flex justify-content-between">
        <Stat k="Loss" v={f(a.lossPct, 0, '%')} />
        <Stat k="RTT (median)" v={f(a.rttMs, 0, ' ms')} />
        <Stat k="Jitter" v={f(a.jitterMs, 1, ' ms')} />
        <Stat k="TCP connect" v={f(a.tcpMs, 0, ' ms')} />
        <Stat k="Lost in a row" v={a.consecutiveLost} />
      </div>
    </div>
  );
}
