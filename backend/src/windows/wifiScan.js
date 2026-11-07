import { execFile } from 'node:child_process';

/** Parses `netsh wlan show networks mode=bssid` (English output). Read-only; never connects. */
export function parseNetsh(text) {
  const nets = [];
  let net = null; let bss = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if ((m = /^SSID\s+\d+\s*:\s*(.*)$/.exec(line))) { net = { ssid: m[1] || '(hidden)', authentication: '', encryption: '', bssids: [] }; nets.push(net); bss = null; }
    else if (!net) continue;
    else if ((m = /^Authentication\s*:\s*(.*)$/.exec(line))) net.authentication = m[1];
    else if ((m = /^Encryption\s*:\s*(.*)$/.exec(line))) net.encryption = m[1];
    else if ((m = /^BSSID\s+\d+\s*:\s*(.*)$/.exec(line))) { bss = { bssid: m[1], signal: null, radio: '', band: '', channel: null }; net.bssids.push(bss); }
    else if (!bss) continue;
    else if ((m = /^Signal\s*:\s*(\d+)%/.exec(line))) bss.signal = Number(m[1]);
    else if ((m = /^Radio type\s*:\s*(.*)$/.exec(line))) bss.radio = m[1];
    else if ((m = /^Band\s*:\s*(.*)$/.exec(line))) bss.band = m[1];
    else if ((m = /^Channel\s*:\s*(\d+)/.exec(line))) bss.channel = Number(m[1]);
  }
  return nets;
}

export function scanWifi() {
  return new Promise((resolve, reject) => {
    execFile('netsh.exe', ['wlan', 'show', 'networks', 'mode=bssid'], { timeout: 10000, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).toString())) : resolve(parseNetsh(stdout))));
  });
}
