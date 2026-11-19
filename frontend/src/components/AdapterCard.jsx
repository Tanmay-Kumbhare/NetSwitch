import React from 'react';
import { Link } from 'react-router-dom';
import Gauge from './Gauge.jsx';

const f = (v, d = 0, unit = '') => (v == null ? '—' : `${Number(v).toFixed(d)}${unit}`);
export const BAND_LABEL = { healthy: 'Healthy', degraded: 'Degraded', unhealthy: 'Unhealthy', unverified: 'Warming up', down: 'Down' };

function Stat({ k, v }) { return <div className="ns-stat"><span className="v">{v}</span><span className="k">{k}</span></div>; }

export default function AdapterCard({ a, active, pinningEnabled = false, scoreConfig = null, wifiStatus = null }) {
  const pathTooltip = a.pathVerified
    ? 'Probes are pinned to this interface via verified /32 routes'
    : (!pinningEnabled
      ? 'Route pinning is off, so probes may not be using this adapter'
      : (a.pinError || 'Route pinning failed or path unverified'));

  const wifi = a.wifi || (a.kind === 'wifi' ? wifiStatus?.current : null);
  const wifiRate = wifi?.rxRate || wifi?.txRate;
  const wifiBandCh = wifi?.band && wifi?.channel ? `${wifi.band} ch ${wifi.channel}` : (wifi?.band || (wifi?.channel ? `ch ${wifi.channel}` : ''));
  const wifiDesc = wifi && wifi.state === 'connected' && wifi.ssid
    ? `Connected to ${wifi.ssid}${wifi.signal != null ? ` · signal ${wifi.signal}%` : ''}${wifiBandCh ? ` · ${wifiBandCh}` : ''}${wifiRate ? ` · ${wifiRate} Mbps` : ''}`
    : (wifi ? `Wi-Fi ${wifi.state || 'disconnected'}` : null);

  return (
    <div className={`ns-card p-3 h-100 ${active ? 'active' : ''} ${!a.up ? 'down' : ''}`}>
      <div className="d-flex justify-content-between align-items-start mb-2">
        <div>
          <Link to={`/interfaces/${a.id}`} className="fw-semibold text-decoration-none text-dark">{a.alias}</Link>
          <div className="ns-muted ns-mono">{a.ip}/{a.prefix} · gw {a.gateway}</div>
          {a.kind === 'wifi' && wifiDesc && (
            <div className="small mt-1 text-truncate" title={wifiDesc}>
              <span className="text-secondary fw-medium">{wifiDesc}</span>
            </div>
          )}
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
            {a.pathVerified ? (
              <span className="ns-pill ok" title={pathTooltip}>PATH VERIFIED</span>
            ) : (
              <span className="ns-pill bad" title={pathTooltip}>PATH UNVERIFIED</span>
            )}
          </div>
        </div>
      </div>
      <hr className="my-2" />
      <div className="d-flex justify-content-between">
        <Stat k="Loss" v={f(a.lossPct, 0, '%')} />
        <Stat k="RTT (median)" v={f(a.rttMs, 0, ' ms')} />
        <Stat k="Jitter" v={f(a.jitterMs, 1, ' ms')} />
        <Stat k="TCP connect" v={f(a.tcpMs, 0, ' ms')} />
        <Stat k="Lost in a row" v={a.consecutiveLost} />
      </div>
      {scoreConfig?.limits && scoreConfig?.weights && (
        <div className="mt-2 pt-2 border-top ns-muted d-flex flex-wrap gap-2 justify-content-between align-items-center" style={{ fontSize: '0.72rem' }}>
          <span className="fw-semibold text-secondary">Limits & Weights:</span>
          <span>Loss: {scoreConfig.limits.loss}%/{Number(scoreConfig.weights.loss).toFixed(2)}</span>
          <span>RTT: {scoreConfig.limits.latency} ms/{Number(scoreConfig.weights.latency).toFixed(2)}</span>
          <span>Jitter: {scoreConfig.limits.jitter} ms/{Number(scoreConfig.weights.jitter).toFixed(2)}</span>
          <span>TCP: {scoreConfig.limits.tcp} ms/{Number(scoreConfig.weights.tcp).toFixed(2)}</span>
        </div>
      )}
    </div>
  );
}
