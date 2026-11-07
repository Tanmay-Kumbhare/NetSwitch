import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { getToken } from './api.js';
import { useAuth } from './auth.jsx';

const Ctx = createContext(null);
export const useLive = () => useContext(Ctx);
const MAX_POINTS = 120;

/** One WebSocket for the whole app: snapshots every second, failover events, reconnect with backoff. */
export function LiveProvider({ children }) {
  const { user } = useAuth();
  const [state, setState] = useState({ status: 'closed', hello: null, snapshot: null, series: [], events: [], toasts: [], pingMs: null });
  const wsRef = useRef(null);

  useEffect(() => {
    if (!user) return undefined;
    let closed = false; let retry = 0; let timer; let pinger;
    const connect = () => {
      setState((s) => ({ ...s, status: 'connecting' }));
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(getToken())}`);
      wsRef.current = ws;
      ws.onopen = () => { retry = 0; setState((s) => ({ ...s, status: 'open' })); pinger = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ping', t: Date.now() })), 5000); };
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        setState((s) => {
          if (msg.type === 'hello') return { ...s, hello: msg };
          if (msg.type === 'pong') return { ...s, pingMs: Date.now() - msg.t };
          if (msg.type === 'failover') return { ...s, events: [msg.event, ...s.events].slice(0, 30), toasts: [{ id: msg.event.ts, ...msg.event }, ...s.toasts].slice(0, 3) };
          if (msg.type === 'snapshot') {
            const point = { ts: msg.ts, label: new Date(msg.ts).toLocaleTimeString() };
            for (const a of msg.adapters) { point[`${a.id}_rtt`] = a.lastRttMs; point[`${a.id}_score`] = a.score; }
            return { ...s, snapshot: msg, series: [...s.series, point].slice(-MAX_POINTS) };
          }
          return s;
        });
      };
      ws.onclose = () => { clearInterval(pinger); setState((s) => ({ ...s, status: 'closed' })); if (!closed) { retry += 1; timer = setTimeout(connect, Math.min(10000, 500 * 2 ** retry)); } };
    };
    connect();
    return () => { closed = true; clearTimeout(timer); clearInterval(pinger); wsRef.current?.close(); };
  }, [user]);

  const dismissToast = (id) => setState((s) => ({ ...s, toasts: s.toasts.filter((t) => t.id !== id) }));
  return <Ctx.Provider value={{ ...state, dismissToast }}>{children}</Ctx.Provider>;
}
