import React, { useEffect, useState } from 'react';
import { Alert, Col, Row, Spinner } from 'react-bootstrap';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from 'recharts';
import { useLive } from '../live.jsx';
import { api } from '../api.js';
import AdapterCard from '../components/AdapterCard.jsx';
import FailoverTable from '../components/FailoverTable.jsx';

const COLORS = ['#0d9488', '#6366f1', '#d97706', '#db2777'];
const PHASE = {
  STABLE: ['ok', 'Stable'],
  HOLD_DOWN: ['live', 'Hold-down'],
  UNVERIFIED: ['', 'Warming up'],
  NO_INTERNET: ['bad', 'No verified internet'],
  FAILING_OVER: ['sim', 'Failing over…'],
  MONITOR_ONLY: ['', 'Monitor only'],
  MANUAL_ONLY: ['live', 'Manual only'],
};

function formatTimeSince(ts, nowMs) {
  if (!ts) return 'None this session';
  const sec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s ago`;
  const hrs = Math.floor(min / 60);
  return `${hrs}h ${min % 60}m ago`;
}

export default function Dashboard() {
  const { snapshot: s, series, events, status } = useLive();
  const [cfg, setCfg] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let on = true;
    api('/api/config').then((c) => on && setCfg(c)).catch(() => {});
    return () => { on = false; };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!s) {
    return (
      <div className="ns-card p-5 text-center my-4">
        <Spinner animation="border" variant="primary" className="mb-3" />
        <h5 className="fw-semibold">Connecting to NetSwitch Agent</h5>
        <div className="ns-muted small">
          {status === 'open' ? 'Waiting for first live snapshot…' : 'Establishing real-time WebSocket connection…'}
        </div>
      </div>
    );
  }

  const [cls, label] = PHASE[s.phase] || ['', s.phase];
  const activeAdapter = s.adapters.find((a) => a.id === s.activeId);
  const preferredAdapter = s.adapters.find((a) => a.id === s.preferredId);
  const lastEvent = events && events.length > 0 ? events[0] : null;
  const timeSinceLastFailover = lastEvent ? formatTimeSince(lastEvent.ts, now) : 'None this session';

  // Compute reference lines for failover events on the score chart
  const scoreMarkers = [];
  if (series && series.length > 0 && events && events.length > 0) {
    const minTs = series[0].ts;
    const maxTs = series[series.length - 1].ts;
    const seenX = new Set();
    for (const ev of events) {
      if (ev.ts >= minTs - 2000 && ev.ts <= maxTs + 2000) {
        let closest = null;
        let minDiff = Infinity;
        for (const pt of series) {
          const diff = Math.abs(pt.ts - ev.ts);
          if (diff < minDiff) {
            minDiff = diff;
            closest = pt;
          }
        }
        if (closest && !seenX.has(closest.label)) {
          seenX.add(closest.label);
          scoreMarkers.push({
            x: closest.label,
            reason: String(ev.reason || 'failover').replace('_', ' '),
            ts: ev.ts,
          });
        }
      }
    }
  }

  const scoreCfg = cfg?.score;

  return (
    <>
      {/* 1. Summary Strip above adapter cards */}
      <div className="ns-summary-strip p-3 mb-3">
        <div className="d-flex flex-wrap align-items-center justify-content-between gap-3">
          <div className="d-flex flex-wrap align-items-center gap-3">
            <div>
              <div className="text-muted small text-uppercase fw-semibold" style={{ fontSize: '0.68rem', letterSpacing: '0.05em' }}>Active Adapter</div>
              <div className="d-flex align-items-center gap-2">
                <span className="fw-bold">{activeAdapter ? activeAdapter.alias : (s.activeId || 'None')}</span>
                <span className="ns-pill live" style={{ fontSize: '0.68rem' }}>ACTIVE</span>
              </div>
            </div>
            <div className="vr d-none d-md-block my-1" />
            <div>
              <div className="text-muted small text-uppercase fw-semibold" style={{ fontSize: '0.68rem', letterSpacing: '0.05em' }}>Preferred</div>
              <div className="fw-semibold">{preferredAdapter ? preferredAdapter.alias : (s.preferredId || '—')}</div>
            </div>
            <div className="vr d-none d-md-block my-1" />
            <div>
              <div className="text-muted small text-uppercase fw-semibold" style={{ fontSize: '0.68rem', letterSpacing: '0.05em' }}>Failovers (Session)</div>
              <div className="fw-semibold">{events?.length ?? 0}</div>
            </div>
            <div className="vr d-none d-md-block my-1" />
            <div>
              <div className="text-muted small text-uppercase fw-semibold" style={{ fontSize: '0.68rem', letterSpacing: '0.05em' }}>Last Failover</div>
              <div className="fw-semibold">{timeSinceLastFailover}</div>
            </div>
          </div>

          <div className="d-flex flex-wrap align-items-center gap-2 ms-auto">
            <span className={`ns-pill ${s.mode === 'sim' ? 'sim' : 'live'}`} title="Execution mode">
              {s.mode === 'sim' ? 'SIM' : 'LIVE · Windows'}
            </span>
            <span className={`ns-pill ${s.failoverEnabled ? 'ok' : 'off'}`} title="Failover enabled in environment">
              Failover: {s.failoverEnabled ? 'ON' : 'OFF'}
            </span>
            <span className={`ns-pill ${s.autoFailoverEnabled ? 'ok' : 'off'}`} title="Automatic background switching">
              Auto: {s.autoFailoverEnabled ? 'ON' : 'OFF'}
            </span>
            <span className={`ns-pill ${s.probeRoutePinning ? 'ok' : 'off'}`} title="Per-adapter /32 route pinning">
              Pinning: {s.probeRoutePinning ? 'ON' : 'OFF'}
            </span>
            <span className={`ns-pill ${cls}`} title="Decision engine phase">{label}</span>
            {s.holdRemainingMs > 0 && <span className="ns-pill">hold-down {Math.ceil(s.holdRemainingMs / 1000)} s</span>}
          </div>
        </div>
      </div>

      {!s.canControl && (
        <Alert variant="warning" className="py-2 small">
          Monitor-only mode: run the agent as Administrator to pin probe routes and enable switching. Scores shown without verified routes are not per-adapter measurements.
        </Alert>
      )}
      {s.phase === 'NO_INTERNET' && (
        <Alert variant="danger" className="py-2 small">
          No adapter has verified internet. NetSwitch will not switch until a candidate is healthy.
        </Alert>
      )}

      {/* 2. Adapter Cards */}
      {s.adapters.length === 0 ? (
        <div className="ns-card p-4 text-center ns-muted mb-3">
          No eligible network adapters discovered. Check Wi-Fi and USB tethering connections.
        </div>
      ) : (
        <Row className="g-3 mb-2">
          {s.adapters.map((a) => (
            <Col md={6} key={a.id}>
              <AdapterCard
                a={a}
                active={a.id === s.activeId}
                pinningEnabled={s.probeRoutePinning}
                scoreConfig={scoreCfg}
              />
            </Col>
          ))}
        </Row>
      )}

      {/* 4. Legend under the gauges */}
      <div className="ns-legend-strip px-3 py-2 mb-3">
        <div className="d-flex flex-wrap align-items-center justify-content-between small text-muted" style={{ fontSize: '0.78rem' }}>
          <span className="fw-semibold text-dark">Scoring Legend (Weights & Limits):</span>
          {scoreCfg ? (
            <>
              <span>Loss: ≤ <b>{scoreCfg.limits.loss}%</b> (weight {Number(scoreCfg.weights.loss).toFixed(2)})</span>
              <span className="d-none d-md-inline text-secondary">·</span>
              <span>RTT: ≤ <b>{scoreCfg.limits.latency} ms</b> (weight {Number(scoreCfg.weights.latency).toFixed(2)})</span>
              <span className="d-none d-md-inline text-secondary">·</span>
              <span>Jitter: ≤ <b>{scoreCfg.limits.jitter} ms</b> (weight {Number(scoreCfg.weights.jitter).toFixed(2)})</span>
              <span className="d-none d-md-inline text-secondary">·</span>
              <span>TCP: ≤ <b>{scoreCfg.limits.tcp} ms</b> (weight {Number(scoreCfg.weights.tcp).toFixed(2)})</span>
            </>
          ) : (
            <span>Loading scoring weights and limits…</span>
          )}
        </div>
      </div>

      {/* Charts */}
      <Row className="g-3 mb-3">
        <Col lg={6}>
          <div className="ns-card p-3">
            <h6 className="mb-2">Latest RTT per adapter (ms)</h6>
            {series.length === 0 ? (
              <div className="ns-empty-state" style={{ height: 220 }}>Gathering RTT telemetry…</div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={series}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" hide />
                  <YAxis width={40} />
                  <Tooltip />
                  <Legend />
                  {s.adapters.map((a, i) => (
                    <Line
                      key={a.id}
                      type="monotone"
                      dataKey={`${a.id}_rtt`}
                      name={a.alias}
                      stroke={COLORS[i % 4]}
                      dot={false}
                      isAnimationActive={false}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </Col>

        <Col lg={6}>
          <div className="ns-card p-3">
            <h6 className="mb-2">Score per adapter (0–100)</h6>
            {series.length === 0 ? (
              <div className="ns-empty-state" style={{ height: 220 }}>Gathering score telemetry…</div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={series}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" hide />
                  <YAxis width={40} domain={[0, 100]} />
                  <Tooltip />
                  <Legend />
                  {s.adapters.map((a, i) => (
                    <Line
                      key={a.id}
                      type="monotone"
                      dataKey={`${a.id}_score`}
                      name={a.alias}
                      stroke={COLORS[i % 4]}
                      dot={false}
                      isAnimationActive={false}
                      connectNulls
                    />
                  ))}
                  {/* Vertical markers for failovers */}
                  {scoreMarkers.map((m) => (
                    <ReferenceLine
                      key={`${m.x}-${m.ts}`}
                      x={m.x}
                      stroke="#dc2626"
                      strokeDasharray="3 3"
                      label={{
                        value: m.reason,
                        position: 'insideTopLeft',
                        fill: '#dc2626',
                        fontSize: 10,
                        fontWeight: 600,
                      }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </Col>
      </Row>

      {/* Failover timeline */}
      <div className="ns-card p-3">
        <h6 className="mb-2">Failover timeline (this session)</h6>
        <FailoverTable events={events} />
      </div>
    </>
  );
}
