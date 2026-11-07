import { execFile } from 'node:child_process';

export function parsePing(out) {
  const m = /time\s*([=<])\s*(\d+(?:\.\d+)?)\s*ms/i.exec(out);
  if (!m) return null;
  return m[1] === '<' ? 0.5 : Number(m[2]);
}

/** ICMP echo through the OS `ping`, bound to the adapter's source IP (-S on Windows). */
export function probeIcmp(srcIp, host, timeoutMs) {
  const win = process.platform === 'win32';
  const args = win
    ? ['-n', '1', '-w', String(timeoutMs), '-S', srcIp, host]
    : ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), '-I', srcIp, host];
  return new Promise((resolve) => {
    execFile(win ? 'ping.exe' : 'ping', args, { timeout: timeoutMs + 1500, windowsHide: true }, (err, stdout) => {
      const rtt = parsePing(String(stdout || ''));
      resolve(rtt == null ? { ok: false } : { ok: true, rtt });
    });
  });
}
