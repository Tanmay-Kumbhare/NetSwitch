import React from 'react';
import { Toast, ToastContainer } from 'react-bootstrap';
import { useLive } from '../live.jsx';

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

export default function Toasts() {
  const { toasts, dismissToast } = useLive();
  return (
    <ToastContainer position="bottom-end" className="p-3" style={{ zIndex: 2000 }}>
      {toasts.map((t) => (
        <Toast key={t.id} onClose={() => dismissToast(t.id)} show autohide delay={9000} bg={t.success ? 'light' : 'danger'}>
          <Toast.Header>
            <strong className="me-auto">{t.success ? 'Failover Complete' : 'Failover Failed / Rolled Back'}</strong>
            <small>{new Date(t.ts).toLocaleTimeString()}</small>
          </Toast.Header>
          <Toast.Body>
            <b>{formatAdapter(t.from)}</b> → <b>{formatAdapter(t.to)}</b> ({formatReason(t.reason)})
            {t.totalMs ? ` in ${(t.totalMs / 1000).toFixed(1)} s` : ''}. {t.note}
          </Toast.Body>
        </Toast>
      ))}
    </ToastContainer>
  );
}
