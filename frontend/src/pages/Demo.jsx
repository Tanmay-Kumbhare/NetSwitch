import React, { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, ButtonGroup, Card, Col, Form, ProgressBar, Row, Table } from 'react-bootstrap';
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../api.js';

const SCENARIOS = [
  { id: 'degradation', name: '1. Gradual Wi-Fi Degradation (Margin & Hold-Down)' },
  { id: 'hard_failure', name: '2. Sudden Hard Failure (Immediate Failover)' },
  { id: 'flapping', name: '3. Link Flapping (Hold-Down Suppression)' },
  { id: 'recovery_switch_back', name: '4. Recovery & Switch-Back (10 Checks)' },
  { id: 'no_internet', name: '5. Dual Link Failure (NO_INTERNET Guard)' },
];

const PHASE_COLORS = {
  STABLE: 'success',
  HOLD_DOWN: 'warning',
  NO_INTERNET: 'danger',
  UNVERIFIED: 'secondary',
};

export default function Demo() {
  const [scenarioId, setScenarioId] = useState('degradation');
  const [data, setData] = useState(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef(null);

  const loadScenario = async (id) => {
    setLoading(true);
    setPlaying(false);
    try {
      const res = await api('/api/demo/run', {
        method: 'POST',
        body: { scenario: id },
      });
      setData(res);
      setStep(0);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadScenario(scenarioId);
  }, [scenarioId]);

  // Autoplay loop
  useEffect(() => {
    if (playing) {
      timerRef.current = setInterval(() => {
        setStep((prev) => {
          if (!data?.timeline || prev >= data.timeline.length - 1) {
            setPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, 1100);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [playing, data]);

  if (!data?.timeline) {
    return <div className="ns-card p-5 text-center ns-muted">Loading in-memory simulation…</div>;
  }

  const timeline = data.timeline;
  const current = timeline[step] || timeline[0];
  const chartData = timeline.map((t, idx) => ({
    second: `s${t.second}`,
    wifi: t.scores.wifi,
    usb: t.scores.usb,
    active: t.activeId,
    action: t.action,
    highlight: idx === step,
  }));

  const switches = timeline.filter((t) => t.action);

  return (
    <>
      {/* Simulation Notice Banner */}
      <Alert variant="warning" className="d-flex align-items-center gap-2 mb-3 shadow-sm py-2">
        <Badge bg="danger" className="text-uppercase px-2 py-1">Simulation</Badge>
        <span className="fw-semibold">
          SIMULATION MODE: No real network changes. Runs purely in memory using mathematical scoring and failover decision functions.
        </span>
      </Alert>

      <div className="d-flex flex-wrap justify-content-between align-items-center gap-3 mb-3">
        <h4 className="mb-0">Interactive Algorithm Demo</h4>
        <div className="d-flex align-items-center gap-2">
          <Form.Label className="small fw-semibold mb-0 text-muted">Scenario:</Form.Label>
          <Form.Select
            size="sm"
            style={{ minWidth: 320 }}
            value={scenarioId}
            onChange={(e) => setScenarioId(e.target.value)}
            disabled={loading}
          >
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Form.Select>
        </div>
      </div>

      <div className="ns-card p-3 mb-3 bg-light border-0">
        <div className="fw-semibold text-dark mb-1">{data.name}</div>
        <div className="text-muted small">{data.description}</div>
      </div>

      {/* Playback Controls & Timeline Slider */}
      <div className="ns-card p-3 mb-3">
        <div className="d-flex flex-wrap align-items-center justify-content-between gap-3 mb-2">
          <ButtonGroup size="sm">
            <Button
              variant={playing ? 'warning' : 'primary'}
              onClick={() => setPlaying(!playing)}
              disabled={step >= timeline.length - 1 && !playing}
            >
              {playing ? '❚❚ Pause' : '▶ Play'}
            </Button>
            <Button
              variant="outline-secondary"
              onClick={() => { setPlaying(false); setStep(Math.max(0, step - 1)); }}
              disabled={step === 0}
            >
              ◀ Step Back
            </Button>
            <Button
              variant="outline-secondary"
              onClick={() => { setPlaying(false); setStep(Math.min(timeline.length - 1, step + 1)); }}
              disabled={step >= timeline.length - 1}
            >
              Step Forward ▶
            </Button>
            <Button
              variant="outline-danger"
              onClick={() => { setPlaying(false); setStep(0); }}
            >
              ↺ Reset
            </Button>
          </ButtonGroup>

          <div className="d-flex align-items-center gap-2">
            <span className="text-muted small fw-semibold">Second:</span>
            <span className="badge bg-dark fs-6 ns-mono">{current.second}s / {timeline.length}s</span>
            <span className={`ns-pill ${current.phase === 'HOLD_DOWN' ? 'sim' : (current.phase === 'NO_INTERNET' ? 'bad' : 'ok')}`}>
              {current.phase}
            </span>
            {current.holdRemainingSec > 0 && (
              <span className="ns-pill off">Hold-down: {current.holdRemainingSec}s</span>
            )}
          </div>
        </div>

        <ProgressBar
          now={((step + 1) / timeline.length) * 100}
          variant="info"
          style={{ height: 6, cursor: 'pointer' }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const pos = (e.clientX - rect.left) / rect.width;
            setStep(Math.min(timeline.length - 1, Math.max(0, Math.floor(pos * timeline.length))));
          }}
        />
      </div>

      {/* Active Adapter Highlighting */}
      <Row className="g-3 mb-3">
        {/* Wi-Fi Card */}
        <Col md={6}>
          <div
            className={`ns-card p-3 h-100 transition-all ${current.activeId === 'wifi' ? 'active shadow-sm' : 'opacity-75'}`}
            style={{ borderLeftWidth: current.activeId === 'wifi' ? 5 : 1, borderLeftColor: current.activeId === 'wifi' ? '#0d9488' : undefined }}
          >
            <div className="d-flex justify-content-between align-items-start mb-2">
              <div>
                <span className="fw-bold fs-5 text-dark">Wi-Fi</span>
                <span className="ns-mono text-muted small ms-2">10.234.134.167</span>
              </div>
              <div>
                {current.activeId === 'wifi' && <span className="ns-pill live me-1">ACTIVE</span>}
                <span className="ns-pill">Metric {current.activeId === 'wifi' ? 5 : 75}</span>
              </div>
            </div>

            <div className="d-flex align-items-baseline gap-3 my-2">
              <span className="display-6 fw-bold" style={{ color: '#0d9488' }}>
                {current.scores.wifi != null ? current.scores.wifi : '—'}
              </span>
              <span className={`badge bg-${current.bands.wifi === 'healthy' ? 'success' : (current.bands.wifi === 'degraded' ? 'warning' : 'danger')}`}>
                {String(current.bands.wifi || '').charAt(0).toUpperCase() + String(current.bands.wifi || '').slice(1)}
              </span>
            </div>

            <div className="d-flex justify-content-between small text-muted pt-2 border-top">
              <span>Loss: <b>{current.metrics.wifi.lossPct}%</b></span>
              <span>RTT: <b>{current.metrics.wifi.rttMs ?? 'lost'} ms</b></span>
              <span>Jitter: <b>{current.metrics.wifi.jitterMs ?? '—'} ms</b></span>
              <span>TCP: <b>{current.metrics.wifi.tcpOk ? 'OK' : 'FAIL'}</b></span>
              <span>Lost: <b>{current.metrics.wifi.consecutiveLost}</b></span>
            </div>
          </div>
        </Col>

        {/* USB Card */}
        <Col md={6}>
          <div
            className={`ns-card p-3 h-100 transition-all ${current.activeId === 'usb' ? 'active shadow-sm' : 'opacity-75'}`}
            style={{ borderLeftWidth: current.activeId === 'usb' ? 5 : 1, borderLeftColor: current.activeId === 'usb' ? '#6366f1' : undefined }}
          >
            <div className="d-flex justify-content-between align-items-start mb-2">
              <div>
                <span className="fw-bold fs-5 text-dark">USB Tethering</span>
                <span className="ns-mono text-muted small ms-2">10.15.157.4</span>
              </div>
              <div>
                {current.activeId === 'usb' && <span className="ns-pill live me-1">ACTIVE</span>}
                <span className="ns-pill">Metric {current.activeId === 'usb' ? 5 : 75}</span>
              </div>
            </div>

            <div className="d-flex align-items-baseline gap-3 my-2">
              <span className="display-6 fw-bold" style={{ color: '#6366f1' }}>
                {current.scores.usb != null ? current.scores.usb : '—'}
              </span>
              <span className={`badge bg-${current.bands.usb === 'healthy' ? 'success' : (current.bands.usb === 'degraded' ? 'warning' : 'danger')}`}>
                {String(current.bands.usb || '').charAt(0).toUpperCase() + String(current.bands.usb || '').slice(1)}
              </span>
            </div>

            <div className="d-flex justify-content-between small text-muted pt-2 border-top">
              <span>Loss: <b>{current.metrics.usb.lossPct}%</b></span>
              <span>RTT: <b>{current.metrics.usb.rttMs ?? 'lost'} ms</b></span>
              <span>Jitter: <b>{current.metrics.usb.jitterMs ?? '—'} ms</b></span>
              <span>TCP: <b>{current.metrics.usb.tcpOk ? 'OK' : 'FAIL'}</b></span>
              <span>Lost: <b>{current.metrics.usb.consecutiveLost}</b></span>
            </div>
          </div>
        </Col>
      </Row>

      {/* Decision Banner for Current Step */}
      <div className={`ns-card p-3 mb-3 border-start border-4 ${current.action ? 'border-danger bg-danger-subtle' : 'border-primary'}`}>
        <div className="d-flex align-items-center gap-2 mb-1">
          <span className="fw-bold">Second {current.second} Decision:</span>
          {current.action && (
            <Badge bg="danger" className="text-uppercase">
              SWITCH EVENT: {String(current.action.reason).replace(/_/g, ' ').toUpperCase()}
            </Badge>
          )}
        </div>
        <div className="fs-6 text-dark fw-medium">
          {current.explanation}
        </div>
      </div>

      {/* Score Chart */}
      <div className="ns-card p-3 mb-3">
        <h6 className="mb-2">Score Timeline (0–100)</h6>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey="second" />
            <YAxis width={40} domain={[0, 100]} />
            <Tooltip />
            <Legend />
            <Line
              type="monotone"
              dataKey="wifi"
              name="Wi-Fi Score"
              stroke="#0d9488"
              strokeWidth={2}
              dot={{ r: 3 }}
              isAnimationActive={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="usb"
              name="USB Score"
              stroke="#6366f1"
              strokeWidth={2}
              dot={{ r: 3 }}
              isAnimationActive={false}
              connectNulls
            />
            {/* Current Step Marker */}
            <ReferenceLine
              x={`s${current.second}`}
              stroke="#0f172a"
              strokeWidth={2}
              label={{ value: 'Now', position: 'top', fill: '#0f172a', fontSize: 11, fontWeight: 'bold' }}
            />
            {/* Switch Events */}
            {switches.map((s) => (
              <ReferenceLine
                key={`sw-${s.second}`}
                x={`s${s.second}`}
                stroke="#dc2626"
                strokeDasharray="3 3"
                label={{
                  value: `⚡ ${String(s.action.reason).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`,
                  position: 'insideTopLeft',
                  fill: '#dc2626',
                  fontSize: 10,
                  fontWeight: 600,
                }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Decision Log Table */}
      <div className="ns-card p-3">
        <h6 className="mb-2">Per-Second Decision Log</h6>
        <div style={{ maxHeight: 280, overflowY: 'auto' }}>
          <Table size="sm" className="ns-table align-middle mb-0" hover responsive>
            <thead>
              <tr>
                <th style={{ width: 60 }}>Time</th>
                <th style={{ width: 80 }}>Active</th>
                <th style={{ width: 140 }}>Scores (Wi-Fi / USB)</th>
                <th style={{ width: 100 }}>Phase</th>
                <th>Plain-Words Decision Reasoning</th>
              </tr>
            </thead>
            <tbody>
              {timeline.map((t, idx) => {
                const isSelected = idx === step;
                return (
                  <tr
                    key={`log-${t.second}`}
                    className={isSelected ? 'table-primary fw-semibold' : (t.action ? 'table-danger' : '')}
                    style={{ cursor: 'pointer' }}
                    onClick={() => { setPlaying(false); setStep(idx); }}
                  >
                    <td className="ns-mono">{t.second}s</td>
                    <td>
                      <Badge bg={t.activeId === 'wifi' ? 'teal' : 'primary'} style={{ backgroundColor: t.activeId === 'wifi' ? '#0d9488' : '#6366f1' }}>
                        {t.activeId.toUpperCase()}
                      </Badge>
                    </td>
                    <td className="ns-mono small">
                      {t.scores.wifi != null ? t.scores.wifi : '—'} / {t.scores.usb != null ? t.scores.usb : '—'}
                    </td>
                    <td>
                      <span className={`badge bg-${PHASE_COLORS[t.phase] || 'secondary'}`}>
                        {t.phase}
                      </span>
                    </td>
                    <td className="small">
                      {t.explanation}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>
      </div>
    </>
  );
}
