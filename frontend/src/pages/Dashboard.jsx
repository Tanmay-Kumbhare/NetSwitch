import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Col, Row, Spinner, Table } from 'react-bootstrap';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from 'recharts';
import { useAuth } from '../auth.jsx';
import { useLive } from '../live.jsx';
import { api } from '../api.js';
import AdapterCard from '../components/AdapterCard.jsx';
import FailoverTable from '../components/FailoverTable.jsx';
import WifiConnectModal from '../components/WifiConnectModal.jsx';

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
  const { user } = useAuth();
  const { snapshot: s, series, events, status } = useLive();
  const [cfg, setCfg] = useState(null);
  const [wifiStatus, setWifiStatus] = useState(null);
  const [wifiAdvisor, setWifiAdvisor] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [connectTarget, setConnectTarget] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [connectErr, setConnectErr] = useState(null);

  const reloadWifiData = () => {
    api('/api/wifi/status').then((w) => setWifiStatus(w)).catch(() => {});
    api('/api/wifi/advisor').then((a) => setWifiAdvisor(a)).catch(() => {});
  };

  const handleConfirmConnect = async () => {
    if (!connectTarget) return;
    setConnecting(true);
    setConnectErr(null);
    try {
      await api('/api/wifi/connect', { method: 'POST', body: { profile: connectTarget } });
      setConnectTarget(null);
      reloadWifiData();
    } catch (e) {
      setConnectErr(e.message);
    } finally {
      setConnecting(false);
    }
  };

  useEffect(() => {
    let on = true;
    api('/api/config').then((c) => on && setCfg(c)).catch(() => {});
    const loadWifi = () => api('/api/wifi/status').then((w) => on && setWifiStatus(w)).catch(() => {});
    const loadAdvisor = () => api('/api/wifi/advisor').then((a) => on && setWifiAdvisor(a)).catch(() => {});
    loadWifi();
    loadAdvisor();
    const t = setInterval(() => {
      loadWifi();
      loadAdvisor();
    }, 10000);
    return () => { on = false; clearInterval(t); };
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
            reason: String(ev.reason || 'failover')
              .split(/[_\s-]+/)
              .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
              .join(' '),
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
            {s.holdRemainingMs > 0 && <span className="ns-pill">Hold-down: {Math.ceil(s.holdRemainingMs / 1000)} s</span>}
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
                wifiStatus={wifiStatus}
              />
            </Col>
          ))}
        </Row>
      )}

      {/* 3. Wi-Fi Advisor Card */}
      {wifiAdvisor && (
        <div className="ns-card p-3 mb-3">
          <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-2">
            <div className="d-flex align-items-center gap-2">
              <span className="fw-bold fs-6">Wi-Fi Advisor</span>
              <span className="ns-pill ok">Intelligent Network Selection</span>
              {wifiAdvisor.simulated && <span className="ns-pill sim">SIMULATED</span>}
            </div>
            {wifiAdvisor.current?.ssid && (
              <div className="small text-muted">
                Current: <b className="text-dark">{wifiAdvisor.current.ssid}</b>{wifiAdvisor.current.signal != null ? ` · Signal ${wifiAdvisor.current.signal}%` : ''}{wifiAdvisor.current.band ? ` · ${wifiAdvisor.current.band}` : ''}
                {wifiAdvisor.current.measuredScore != null && (
                  <> · Measured Score <b className="text-primary">{wifiAdvisor.current.measuredScore}</b></>
                )}
              </div>
            )}
          </div>

          {/* Windows Likely Pick vs NetSwitch Recommendation */}
          <div className="p-2 px-3 rounded bg-light border mb-2 d-flex flex-wrap align-items-center justify-content-between gap-2 small">
            <div>
              <span className="text-muted">Windows will likely pick:</span>{' '}
              <span className="fw-bold text-dark">{wifiAdvisor.windowsLikelyPick || 'None in range'}</span>
              <span className="mx-2 text-muted">;</span>
              <span className="text-muted">NetSwitch recommends:</span>{' '}
              <span className="fw-bold text-success">{wifiAdvisor.recommended || 'None in range'}</span>
            </div>
            {wifiAdvisor.windowsLikelyPick && wifiAdvisor.recommended && (
              wifiAdvisor.windowsLikelyPick === wifiAdvisor.recommended ? (
                <span className="badge bg-success-subtle text-success border border-success-subtle">
                  ✓ Aligned with Windows Default
                </span>
              ) : (
                <span className="badge bg-warning-subtle text-warning-emphasis border border-warning-subtle">
                  ⚡ NetSwitch Recommends Better Link
                </span>
              )
            )}
          </div>

          {/* Candidates Intersection Summary Strip */}
          <div className="d-flex flex-wrap align-items-center justify-content-between text-muted small mb-2 px-1">
            <div>
              <span className="fw-semibold text-dark">
                {wifiAdvisor.networks?.length ?? 0} Connectable Candidate{(wifiAdvisor.networks?.length ?? 0) === 1 ? '' : 's'}
              </span>
              <span className="ms-1">
                (intersected from {wifiStatus?.savedProfiles?.length ?? 0} saved profile{(wifiStatus?.savedProfiles?.length ?? 0) === 1 ? '' : 's'} &amp; {wifiStatus?.scannedNetworks?.length ?? 0} nearby network{(wifiStatus?.scannedNetworks?.length ?? 0) === 1 ? '' : 's'})
              </span>
            </div>
            <Link to="/control" className="text-decoration-none small fw-semibold text-primary">
              View full saved profiles &amp; scan on Control →
            </Link>
          </div>

          {/* In-Range Saved Networks Sorted by Predicted Rating */}
          {(!wifiAdvisor.networks || wifiAdvisor.networks.length === 0) ? (
            <div className="text-muted small py-2 text-center">
              No saved Wi-Fi profiles currently detected in range.
            </div>
          ) : (
            <div className="table-responsive">
              <Table size="sm" className="ns-table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Network (SSID)</th>
                    <th>Signal</th>
                    <th>Band / Radio</th>
                    <th>Measured Avg Score</th>
                    <th>Predicted Rating</th>
                    <th>Advisor Status</th>
                    <th style={{ width: 90 }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {wifiAdvisor.networks.map((net) => {
                    const isConnected = wifiAdvisor.current?.ssid === net.ssid;
                    const isRecommended = wifiAdvisor.recommended === net.ssid;
                    const isWinPick = wifiAdvisor.windowsLikelyPick === net.ssid;
                    return (
                      <tr key={net.ssid} className={isRecommended ? 'table-light' : ''}>
                        <td className="fw-medium">
                          {net.ssid}
                          {isConnected && <span className="ns-pill live ms-2" style={{ fontSize: '0.65rem' }}>CONNECTED</span>}
                        </td>
                        <td>
                          <div className="d-flex align-items-center gap-2">
                            <div className="progress flex-grow-1" style={{ height: 6, minWidth: 60, maxWidth: 100 }}>
                              <div
                                className={`progress-bar ${net.signal >= 75 ? 'bg-success' : net.signal >= 45 ? 'bg-warning' : 'bg-danger'}`}
                                style={{ width: `${net.signal || 0}%` }}
                              />
                            </div>
                            <span className="ns-mono small">{net.signal ?? '—'}%</span>
                          </div>
                        </td>
                        <td className="small text-muted">{net.band || '—'}{net.channel ? ` (ch ${net.channel})` : ''}</td>
                        <td className="ns-mono small">
                          {net.measuredScore != null ? (
                            <span><b>{net.measuredScore}</b> <span className="text-muted">({net.samples} checks)</span></span>
                          ) : (
                            <span className="text-muted">No history</span>
                          )}
                        </td>
                        <td>
                          <span className="badge bg-primary px-2 py-1">
                            {net.predictedRating} Predicted
                          </span>
                        </td>
                        <td>
                          <div className="d-flex gap-1 flex-wrap">
                            {isRecommended && <span className="ns-pill ok">RECOMMENDED</span>}
                            {isWinPick && <span className="ns-pill off">WINDOWS PICK</span>}
                          </div>
                        </td>
                        <td>
                          {user?.role === 'admin' ? (
                            isConnected ? (
                              <span className="text-muted small" style={{ fontSize: '0.75rem' }}>Active</span>
                            ) : (
                              <Button
                                size="sm"
                                variant={isRecommended ? 'success' : 'outline-primary'}
                                style={{ fontSize: '0.72rem', padding: '0.12rem 0.5rem' }}
                                onClick={() => { setConnectErr(null); setConnectTarget(net.ssid); }}
                              >
                                Connect
                              </Button>
                            )
                          ) : (
                            <span className="text-muted small" style={{ fontSize: '0.75rem' }}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </div>
          )}

          <WifiConnectModal
            show={!!connectTarget}
            onHide={() => { if (!connecting) setConnectTarget(null); }}
            profile={connectTarget}
            onConfirm={handleConfirmConnect}
            connecting={connecting}
            error={connectErr}
          />
        </div>
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
            <h6 className="mb-2">Latest RTT per Adapter (ms)</h6>
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
            <h6 className="mb-2">Score per Adapter (0–100)</h6>
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
        <h6 className="mb-2">Failover Timeline (This Session)</h6>
        <FailoverTable events={events} />
      </div>
    </>
  );
}
