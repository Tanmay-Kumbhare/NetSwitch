import React, { useEffect, useState } from 'react';
import { Alert, Button, Col, Form, Row, Table } from 'react-bootstrap';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useLive } from '../live.jsx';
import WifiConnectModal from '../components/WifiConnectModal.jsx';

function SimPanel({ adapters }) {
  const [msg, setMsg] = useState('');
  const send = async (adapter, patch) => { try { await api('/api/sim/impair', { method: 'POST', body: { adapter, ...patch } }); setMsg(''); } catch (e) { setMsg(e.message); } };
  return (
    <div className="ns-card p-3 mb-3">
      <h6>Simulation: Inject Faults</h6>
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

const DECIDE_LABELS = {
  degradeChecks: 'Degrade Checks',
  degradeScoreMargin: 'Degrade Score Margin',
  switchBackChecks: 'Switch-Back Checks',
  switchBackMinScore: 'Switch-Back Min Score',
  holdDownMs: 'Hold-Down (ms)',
  evalIntervalMs: 'Eval Interval (ms)',
};

const WEIGHT_LABELS = {
  loss: 'Weight · Loss',
  latency: 'Weight · Latency',
  jitter: 'Weight · Jitter',
  tcp: 'Weight · TCP',
};

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
      <h6>Decision Thresholds &amp; Score Weights</h6>
      {msg && <Alert variant={msg.v} className="py-1">{msg.t}</Alert>}
      <Row className="g-3">
        {Object.entries(cfg.decide).map(([k, v]) => (
          <Col xs={6} md={3} key={k}>
            <Form.Label className="small mb-0 fw-semibold text-secondary">{DECIDE_LABELS[k] || k}</Form.Label>
            <Form.Control size="sm" type="number" value={v} disabled={!isAdmin} onChange={(e) => setD(k, e.target.value)} />
          </Col>
        ))}
        {Object.entries(cfg.score.weights).map(([k, v]) => (
          <Col xs={6} md={3} key={k}>
            <Form.Label className="small mb-0 fw-semibold text-secondary">{WEIGHT_LABELS[k] || `Weight · ${k}`}</Form.Label>
            <Form.Control size="sm" type="number" step="0.05" value={v} disabled={!isAdmin} onChange={(e) => setW(k, e.target.value)} />
          </Col>
        ))}
      </Row>
      {isAdmin && <Button size="sm" className="mt-3" onClick={save}>Save Changes</Button>}
    </div>
  );
}

function SignalBar({ signal }) {
  const s = Math.max(0, Math.min(100, Number(signal) || 0));
  const color = s >= 70 ? '#16a34a' : (s >= 40 ? '#d97706' : '#dc2626');
  return (
    <div className="d-flex align-items-center gap-2">
      <div style={{ width: 64, height: 6, backgroundColor: '#e2e8f0', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${s}%`, height: '100%', backgroundColor: color }} />
      </div>
      <span className="small ns-mono">{s}%</span>
    </div>
  );
}

function WifiNetworksPanel() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [connectTarget, setConnectTarget] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [connectErr, setConnectErr] = useState('');

  const load = async () => {
    setLoading(true);
    setErr('');
    try {
      setData(await api('/api/wifi/status'));
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmConnect = async () => {
    if (!connectTarget) return;
    setConnecting(true);
    setConnectErr('');
    try {
      await api('/api/wifi/connect', { method: 'POST', body: { profile: connectTarget } });
      setConnectTarget(null);
      await load();
    } catch (e) {
      setConnectErr(e.message);
    } finally {
      setConnecting(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const cur = data?.current;
  const saved = data?.savedProfiles || [];
  const scanned = data?.scannedNetworks || [];

  return (
    <div className="ns-card p-3 mb-3">
      <div className="d-flex justify-content-between align-items-center mb-2">
        <h6 className="mb-0">Wi-Fi Networks &amp; Saved Profiles {data?.simulated && <span className="ns-pill sim ms-2">SIMULATED</span>}</h6>
        <Button size="sm" variant="outline-dark" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh / Scan'}
        </Button>
      </div>

      <Alert variant="light" className="border small mb-3">
        <b>Note:</b> One Wi-Fi radio can join one network at a time. Windows chooses it from the saved-profile order; NetSwitch reports it and switches between adapters.
      </Alert>

      {err && <Alert variant="danger" className="py-1 small">{err}</Alert>}

      <Row className="g-3">
        {/* Connected Interface */}
        <Col md={12} lg={4}>
          <div className="border rounded p-3 h-100 bg-white">
            <div className="fw-semibold small text-uppercase text-muted mb-2">Connected Network</div>
            {cur && cur.state === 'connected' && cur.ssid ? (
              <div>
                <div className="h5 mb-1 text-primary fw-bold">{cur.ssid}</div>
                <div className="d-flex align-items-center gap-2 mb-2">
                  <span className="ns-pill ok">CONNECTED</span>
                  <SignalBar signal={cur.signal} />
                </div>
                <Table size="sm" className="table-borderless small mb-0">
                  <tbody>
                    <tr><td className="text-muted ps-0">Radio &amp; Band</td><td className="ns-mono">{cur.radio || '—'} · {cur.band || '—'} (ch {cur.channel || '—'})</td></tr>
                    <tr><td className="text-muted ps-0">Link Rates</td><td className="ns-mono">Rx {cur.rxRate || '—'} Mbps / Tx {cur.txRate || '—'} Mbps</td></tr>
                    <tr><td className="text-muted ps-0">BSSID</td><td className="ns-mono text-truncate" style={{ maxWidth: 140 }}>{cur.bssid || '—'}</td></tr>
                  </tbody>
                </Table>
              </div>
            ) : (
              <div className="text-muted small py-3">
                {cur ? 'Wi-Fi interface is disconnected (not associated with an Access Point).' : 'No wireless interface detected on this system.'}
              </div>
            )}
          </div>
        </Col>

        {/* Saved Profiles */}
        <Col md={6} lg={4}>
          <div className="border rounded p-3 h-100 bg-white">
            <div className="d-flex justify-content-between align-items-center mb-2">
              <span className="fw-semibold small text-uppercase text-muted">Saved Windows Profiles</span>
              <span className="badge bg-secondary">{saved.length}</span>
            </div>
            <p className="text-muted small mb-2" style={{ fontSize: '0.75rem' }}>
              Windows connects in priority order (top to bottom):
            </p>
            {saved.length === 0 ? (
              <div className="text-muted small py-2">No saved profiles found.</div>
            ) : (
              <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                <ol className="ps-3 mb-0 small">
                  {saved.map((name, i) => (
                    <li key={`${name}-${i}`} className="py-1 d-flex align-items-center justify-content-between">
                      <div>
                        <span className={cur?.ssid === name ? 'fw-bold text-success' : ''}>{name}</span>
                        {cur?.ssid === name && <span className="ns-pill live ms-2" style={{ fontSize: '0.65rem' }}>ACTIVE</span>}
                      </div>
                      {user?.role === 'admin' && cur?.ssid !== name && (
                        <Button
                          size="sm"
                          variant="outline-primary"
                          style={{ fontSize: '0.68rem', padding: '0.1rem 0.45rem' }}
                          onClick={() => { setConnectErr(''); setConnectTarget(name); }}
                        >
                          Connect
                        </Button>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        </Col>

        {/* Nearby Networks */}
        <Col md={6} lg={4}>
          <div className="border rounded p-3 h-100 bg-white">
            <div className="d-flex justify-content-between align-items-center mb-2">
              <span className="fw-semibold small text-uppercase text-muted">Nearby Scanned Networks</span>
              <span className="badge bg-secondary">{scanned.length}</span>
            </div>
            {scanned.length === 0 ? (
              <div className="text-muted small py-2">No nearby networks found.</div>
            ) : (
              <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                <Table size="sm" className="ns-table mb-0 align-middle">
                  <thead><tr><th>SSID</th><th>Signal</th><th>Security</th></tr></thead>
                  <tbody>
                    {scanned.map((net, i) => {
                      const topBss = net.bssids?.[0];
                      return (
                        <tr key={`${net.ssid}-${i}`}>
                          <td className="fw-medium text-truncate" style={{ maxWidth: 120 }}>{net.ssid}</td>
                          <td><SignalBar signal={topBss?.signal} /></td>
                          <td className="small text-muted">{net.authentication?.replace('-Personal', '') || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              </div>
            )}
          </div>
        </Col>
      </Row>

      <WifiConnectModal
        show={!!connectTarget}
        onHide={() => { if (!connecting) setConnectTarget(null); }}
        profile={connectTarget}
        onConfirm={handleConfirmConnect}
        connecting={connecting}
        error={connectErr}
      />
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
      <h4 className="mb-3">Control &amp; Configuration</h4>
      {!isAdmin && <Alert variant="info">You are a viewer. Only the admin can switch adapters or edit thresholds.</Alert>}
      {isAdmin && !s.canControl && <Alert variant="warning">Control is disabled because the agent is not running as Administrator. Restart the terminal as Administrator.</Alert>}
      {msg && <Alert variant={msg.v} dismissible onClose={() => setMsg(null)}>{msg.t}</Alert>}
      <div className="ns-card p-3 mb-3">
        <h6>Adapter Routing &amp; Metrics</h6>
        <Table size="sm" className="ns-table align-middle mb-2">
          <thead><tr><th>Adapter</th><th>Interface</th><th>Metric</th><th>Score</th><th>Action</th></tr></thead>
          <tbody>
            {s.adapters.map((a) => (
              <tr key={a.id}>
                <td><b>{a.alias}</b> {a.id === s.activeId && <span className="ns-pill live ms-1">ACTIVE</span>}</td>
                <td className="ns-mono">#{a.index} · {a.ip}</td><td>{a.metric}</td><td>{a.score ?? '—'}</td>
                <td className="text-end">
                  <Button size="sm" disabled={!enabled || a.id === s.activeId || !a.up} onClick={() => run(() => api('/api/control/switch', { method: 'POST', body: { to: a.id } }))}>
                    {busy ? 'Switching…' : 'Make Active'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="ns-muted small mb-2">Switching changes only the Windows interface metric (lowest = preferred), then verifies the route and the source address of a new connection. If verification fails, the previous metrics are restored.</p>
        <Button size="sm" variant="outline-danger" disabled={!enabled} onClick={() => run(() => api('/api/control/restore', { method: 'POST' }))}>
          {busy ? 'Restoring…' : 'Restore Original Adapter Settings'}
        </Button>
      </div>
      <WifiNetworksPanel />
      {s.mode === 'sim' ? <SimPanel adapters={s.adapters} /> : (
        <div className="ns-card p-3 mb-3">
          <h6>Fault Injection Testing with Clumsy (Windows)</h6>
          <p className="ns-muted small">Run clumsy.exe as Administrator, tick Lag (150 ms) and Drop (10%), Inbound and Outbound, and use the filter for the adapter to impair:</p>
          {s.adapters.map((a) => <div key={a.id} className="mb-1"><b>{a.alias}:</b> <code>{`ip and (ip.SrcAddr == ${a.ip} or ip.DstAddr == ${a.ip})`}</code></div>)}
        </div>
      )}
      <ConfigForm isAdmin={isAdmin} />
    </>
  );
}
