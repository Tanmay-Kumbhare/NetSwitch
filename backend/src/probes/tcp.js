import net from 'node:net';

/** TCP connect time to host:port from a given source IP. Resolves { ok, ms }. */
export function probeTcp(srcIp, host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const s = net.createConnection({ host, port, localAddress: srcIp });
    const done = (r) => { s.destroy(); resolve(r); };
    s.setTimeout(timeoutMs, () => done({ ok: false, ms: null }));
    s.once('connect', () => done({ ok: true, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
    s.once('error', () => done({ ok: false, ms: null }));
  });
}

/** Unbound connect (OS picks the route). Used to verify where default traffic goes. */
export function connectUnbound(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const done = (r) => { s.destroy(); resolve(r); };
    s.setTimeout(timeoutMs, () => done({ ok: false, localAddress: null }));
    s.once('connect', () => done({ ok: true, localAddress: s.localAddress }));
    s.once('error', () => done({ ok: false, localAddress: null }));
  });
}
