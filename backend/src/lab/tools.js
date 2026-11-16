// Whitelisted network diagnostics (syllabus practical 1b: ping, tracert, nslookup, arp, netstat, route, ipconfig, nbtstat)
// plus a TLS/ALPN inspector (HTTPS, SSL/TLS, HTTP/2 negotiation) and a DNS resolver (nslookup-style).
// Safety: execFile with a FIXED argument list; the only user input is a validated hostname/IPv4. No shell is ever used.
import { execFile } from 'node:child_process';
import dns from 'node:dns';
import tls from 'node:tls';
import net from 'node:net';
import { isIPv4 } from '../core/subnet.js';

const WIN = process.platform === 'win32';
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
export const validHost = (h) => typeof h === 'string' && (isIPv4(h) || HOST_RE.test(h) || h === 'localhost');
export const isPrivateIPv4 = (ip) => { const [a, b] = ip.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224; };

const SPECS = {
  ping:     { needs: 'host', win: (h) => ['ping.exe', ['-n', '4', '-w', '1000', h]], nix: (h) => ['ping', ['-c', '4', '-W', '1', h]], what: 'ICMP echo request/reply: reachability and RTT (Network layer)' },
  tracert:  { needs: 'host', win: (h) => ['tracert.exe', ['-d', '-h', '12', '-w', '1000', h]], nix: (h) => ['traceroute', ['-n', '-m', '12', '-w', '1', h]], what: 'Hop-by-hop path using TTL expiry (ICMP Time Exceeded)' },
  arp:      { win: () => ['arp.exe', ['-a']], nix: () => ['ip', ['neigh']], what: 'ARP cache: IPv4 address to MAC address mapping on the local link' },
  netstat:  { win: () => ['netstat.exe', ['-an']], nix: () => ['ss', ['-tun']], what: 'Open TCP/UDP sockets and their states (LISTENING, ESTABLISHED, TIME_WAIT)' },
  route:    { win: () => ['route.exe', ['print', '-4']], nix: () => ['ip', ['route']], what: 'The IPv4 routing table: destination, mask, gateway, interface, metric' },
  ipconfig: { win: () => ['ipconfig.exe', ['/all']], nix: () => ['ip', ['addr']], what: 'Interface addresses, masks, gateways, DNS servers, DHCP' },
  nbtstat:  { win: () => ['nbtstat.exe', ['-n']], nix: null, what: 'NetBIOS over TCP/IP names (Windows only)' },
};
export const TOOL_NAMES = [...Object.keys(SPECS), 'nslookup', 'tls'];

function run(file, args) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile(file, args, { timeout: 25000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const text = String(stdout || '') + (stderr ? `\n${stderr}` : '');
      resolve({ ok: !err || !!stdout, ms: Date.now() - t0, output: (text.length > 16000 ? `${text.slice(0, 16000)}\n... (truncated)` : text).trim() || (err ? `error: ${err.message}` : '(no output)') });
    });
  });
}

export async function resolveName(host, type = 'A', server) {
  if (!validHost(host)) throw httpErr('invalid host name');
  if (!/^(A|AAAA|MX|NS|TXT|CNAME)$/.test(type)) throw httpErr('type must be A, AAAA, MX, NS, TXT or CNAME');
  const r = new dns.promises.Resolver({ timeout: 2500, tries: 1 });
  if (server) { if (!/^(1\.1\.1\.1|8\.8\.8\.8|9\.9\.9\.9)$/.test(server)) throw httpErr('server must be 1.1.1.1, 8.8.8.8 or 9.9.9.9'); r.setServers([server]); }
  const t0 = process.hrtime.bigint();
  try { const answers = await r.resolve(host, type); return { ok: true, host, type, server: server || 'system default', ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e4) / 100, answers, note: 'DNS runs over UDP port 53 (falls back to TCP for large answers)' }; }
  catch (e) { return { ok: false, host, type, server: server || 'system default', error: e.code || e.message }; }
}

/** TLS handshake with ALPN offering h2 and http/1.1: shows the negotiated protocol, TLS version, cipher and certificate. */
export async function inspectTls(host, port = 443, { allowPrivate = false, rejectUnauthorized = true } = {}) {
  if (!validHost(host)) throw httpErr('invalid host name');
  const addr = isIPv4(host) ? host : (await dns.promises.lookup(host, { family: 4 }).catch(() => ({}))).address;
  if (!addr) return { ok: false, error: 'host did not resolve' };
  if (!allowPrivate && isPrivateIPv4(addr)) throw httpErr('only public hosts are allowed');
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const s = tls.connect({ host: addr, port, servername: isIPv4(host) ? undefined : host, ALPNProtocols: ['h2', 'http/1.1'], rejectUnauthorized, timeout: 6000 }, () => {
      const c = s.getPeerCertificate(); const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e4) / 100;
      resolve({ ok: true, host, address: addr, handshakeMs: ms, tlsVersion: s.getProtocol(), cipher: s.getCipher()?.name, alpn: s.alpnProtocol || 'none', authorized: s.authorized, authError: s.authorizationError || null,
        cert: { subject: c.subject?.CN, issuer: c.issuer?.O || c.issuer?.CN, validFrom: c.valid_from, validTo: c.valid_to, sans: String(c.subjectaltname || '').split(', ').slice(0, 6) },
        note: 'ALPN lets client and server pick HTTP/2 ("h2") or HTTP/1.1 during the TLS handshake, before any HTTP is sent.' });
      s.end();
    });
    s.on('timeout', () => { s.destroy(); resolve({ ok: false, error: 'timeout' }); });
    s.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
  });
}

function httpErr(msg) { const e = new Error(msg); e.status = 400; return e; }

export async function runTool(tool, params = {}) {
  if (tool === 'nslookup') return resolveName(params.target, params.type || 'A', params.server);
  if (tool === 'tls') return inspectTls(params.target, 443);
  const spec = SPECS[tool]; if (!spec) throw httpErr(`unknown tool; choose one of ${TOOL_NAMES.join(', ')}`);
  if (spec.needs === 'host' && !validHost(params.target)) throw httpErr('a valid host name or IPv4 address is required');
  const pick = WIN ? spec.win : spec.nix; if (!pick) return { ok: false, tool, output: `${tool} is not available on this operating system`, what: spec.what };
  const [file, args] = pick(params.target);
  const r = await run(file, args);
  return { tool, command: `${file} ${args.join(' ')}`, what: spec.what, ...r };
}
