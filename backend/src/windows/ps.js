import { execFile } from 'node:child_process';
import { isIPv4 } from '../core/subnet.js';

// Safety rule: PowerShell is only ever invoked with FIXED script templates (below, in discovery.js and
// control layer). The only interpolated values are validated integers and IPv4 literals. No user text,
// no request body, no interface alias ever reaches a shell.
export const int = (v, lo = 0, hi = 1e6) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`bad integer: ${v}`);
  return v;
};
export const ip4 = (v) => { if (!isIPv4(v)) throw new Error(`bad IPv4: ${v}`); return v; };

export function runPs(script, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).toString().trim())) : resolve(String(stdout).trim())));
  });
}
