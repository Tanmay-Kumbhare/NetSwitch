import React from 'react';
import { Toast, ToastContainer } from 'react-bootstrap';
import { useLive } from '../live.jsx';

export default function Toasts() {
  const { toasts, dismissToast } = useLive();
  return (
    <ToastContainer position="bottom-end" className="p-3" style={{ zIndex: 2000 }}>
      {toasts.map((t) => (
        <Toast key={t.id} onClose={() => dismissToast(t.id)} show autohide delay={9000} bg={t.success ? 'light' : 'danger'}>
          <Toast.Header><strong className="me-auto">{t.success ? 'Failover complete' : 'Failover failed'}</strong><small>{new Date(t.ts).toLocaleTimeString()}</small></Toast.Header>
          <Toast.Body>{t.from} → {t.to} ({String(t.reason).replace('_', ' ')}){t.totalMs ? ` in ${(t.totalMs / 1000).toFixed(1)} s` : ''}. {t.note}</Toast.Body>
        </Toast>
      ))}
    </ToastContainer>
  );
}
