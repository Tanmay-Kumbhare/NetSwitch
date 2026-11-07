import React from 'react';

const COLORS = { healthy: '#16a34a', degraded: '#d97706', unhealthy: '#dc2626', down: '#dc2626', unverified: '#94a3b8' };

/** Ring gauge for the 0-100 score. */
export default function Gauge({ score, band, size = 92 }) {
  const r = size / 2 - 8; const c = 2 * Math.PI * r; const v = score == null ? 0 : Math.max(0, Math.min(100, score));
  return (
    <svg width={size} height={size} role="img" aria-label={score == null ? 'no score yet' : `score ${score}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e2e8f0" strokeWidth="8" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={COLORS[band] || COLORS.unverified} strokeWidth="8" strokeLinecap="round"
        strokeDasharray={`${(v / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: 'stroke-dasharray .6s' }} />
      <text x="50%" y="52%" textAnchor="middle" dominantBaseline="middle" fontSize={size * 0.28} fontWeight="700" fill="#0f172a">{score == null ? '—' : Math.round(v)}</text>
    </svg>
  );
}
