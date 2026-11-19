import { execFile } from 'node:child_process';

/** Parses `netsh wlan show networks mode=bssid` (English output). Read-only; never connects. */
export function parseNetsh(text) {
  const nets = [];
  let net = null; let bss = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if ((m = /^SSID\s+\d+\s*:\s*(.*)$/.exec(line))) {
      net = { ssid: m[1] || '(hidden)', authentication: '', encryption: '', bssids: [] };
      nets.push(net);
      bss = null;
    } else if (!net) {
      continue;
    } else if ((m = /^Authentication\s*:\s*(.*)$/.exec(line))) {
      net.authentication = m[1];
    } else if ((m = /^Encryption\s*:\s*(.*)$/.exec(line))) {
      net.encryption = m[1];
    } else if ((m = /^BSSID\s+\d+\s*:\s*(.*)$/.exec(line))) {
      bss = { bssid: m[1], signal: null, radio: '', band: '', channel: null };
      net.bssids.push(bss);
    } else if (!bss) {
      continue;
    } else if ((m = /^Signal\s*:\s*(\d+)%/.exec(line))) {
      bss.signal = Number(m[1]);
    } else if ((m = /^Radio type\s*:\s*(.*)$/.exec(line))) {
      bss.radio = m[1];
    } else if ((m = /^Band\s*:\s*(.*)$/.exec(line))) {
      bss.band = m[1];
    } else if ((m = /^Channel\s*:\s*(\d+)/.exec(line))) {
      bss.channel = Number(m[1]);
    }
  }
  return nets;
}

/** Parses `netsh wlan show interfaces` (English output). Read-only; never connects. */
export function parseInterfaces(text) {
  const str = String(text || '');
  if (/no wireless interface|wlansvc.*not running/i.test(str)) {
    return null;
  }
  const getField = (re) => {
    const m = re.exec(str);
    return m ? m[1].trim() : null;
  };

  const name = getField(/Name\s*:\s*([^\r\n]+)/i);
  const stateStr = getField(/State\s*:\s*([^\r\n]+)/i);
  if (!name && !stateStr) return null;

  const desc = getField(/Description\s*:\s*([^\r\n]+)/i);
  const state = (stateStr || 'disconnected').toLowerCase();
  const ssid = getField(/SSID\s*:\s*([^\r\n]+)/i);
  const bssid = getField(/BSSID\s*:\s*([^\r\n]+)/i);
  const signalStr = getField(/Signal\s*:\s*(\d+)%/i);
  const radio = getField(/Radio type\s*:\s*([^\r\n]+)/i);
  const band = getField(/Band\s*:\s*([^\r\n]+)/i);
  const channelStr = getField(/Channel\s*:\s*(\d+)/i);
  const rxStr = getField(/Receive rate \(Mbps\)\s*:\s*([\d.]+)/i);
  const txStr = getField(/Transmit rate \(Mbps\)\s*:\s*([\d.]+)/i);

  return {
    name: name || 'Wi-Fi',
    description: desc || null,
    state,
    ssid: ssid || null,
    bssid: bssid || null,
    signal: signalStr ? Number(signalStr) : null,
    radio: radio || null,
    band: band || null,
    channel: channelStr ? Number(channelStr) : null,
    rxRate: rxStr ? Number(rxStr) : null,
    txRate: txStr ? Number(txStr) : null,
  };
}

/** Parses `netsh wlan show profiles` (English output). Read-only; never connects. */
export function parseProfiles(text) {
  const str = String(text || '');
  if (/no wireless interface|wlansvc.*not running/i.test(str)) {
    return [];
  }
  const profiles = [];
  const re = /^\s*(?:All\s+User\s+Profile|User\s+Profile)\s*:\s*(.+)$/gim;
  let match;
  while ((match = re.exec(str)) !== null) {
    const p = match[1].trim();
    if (p && p !== '<None>' && !profiles.includes(p)) {
      profiles.push(p);
    }
  }
  return profiles;
}

export function scanWifi() {
  return new Promise((resolve, reject) => {
    execFile('netsh.exe', ['wlan', 'show', 'networks', 'mode=bssid'], { timeout: 10000, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).toString())) : resolve(parseNetsh(stdout))));
  });
}

export function showInterfaces() {
  return new Promise((resolve, reject) => {
    execFile('netsh.exe', ['wlan', 'show', 'interfaces'], { timeout: 10000, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).toString())) : resolve(parseInterfaces(stdout))));
  });
}

export function showProfiles() {
  return new Promise((resolve, reject) => {
    execFile('netsh.exe', ['wlan', 'show', 'profiles'], { timeout: 10000, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).toString())) : resolve(parseProfiles(stdout))));
  });
}

export const SIMULATED_WIFI_STATUS = Object.freeze({
  simulated: true,
  current: {
    name: 'Wi-Fi (sim)',
    description: 'Virtual 802.11ax Wireless Adapter',
    state: 'connected',
    ssid: 'NetSwitch-Test-AP',
    bssid: '02:00:00:00:00:01',
    signal: 92,
    radio: '802.11ax',
    band: '5 GHz',
    channel: 36,
    rxRate: 866,
    txRate: 866,
  },
  savedProfiles: ['NetSwitch-Test-AP', 'Campus-Guest', 'Home-Fiber-5G'],
  scannedNetworks: [
    {
      ssid: 'NetSwitch-Test-AP (sim)',
      authentication: 'WPA3-Personal',
      encryption: 'CCMP',
      bssids: [{ bssid: '02:00:00:00:00:01', signal: 92, radio: '802.11ax', band: '5 GHz', channel: 36 }],
    },
    {
      ssid: 'Campus-Guest',
      authentication: 'Open',
      encryption: 'None',
      bssids: [{ bssid: '02:00:00:00:00:02', signal: 68, radio: '802.11ac', band: '2.4 GHz', channel: 6 }],
    },
    {
      ssid: 'Home-Fiber-5G',
      authentication: 'WPA2-Personal',
      encryption: 'CCMP',
      bssids: [{ bssid: '02:00:00:00:00:03', signal: 54, radio: '802.11ax', band: '5 GHz', channel: 149 }],
    },
  ],
});

export async function getWifiStatus({ mode = 'windows' } = {}) {
  if (mode === 'sim') {
    return SIMULATED_WIFI_STATUS;
  }

  const [ifRes, profRes, scanRes] = await Promise.allSettled([
    showInterfaces(),
    showProfiles(),
    scanWifi(),
  ]);

  const current = ifRes.status === 'fulfilled' ? ifRes.value : null;
  const savedProfiles = profRes.status === 'fulfilled' && Array.isArray(profRes.value) ? profRes.value : [];
  const scannedNetworks = scanRes.status === 'fulfilled' && Array.isArray(scanRes.value) ? scanRes.value : [];

  return {
    simulated: false,
    current,
    savedProfiles,
    scannedNetworks,
  };
}
