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

export function connectWifi({ profile, interfaceName = 'Wi-Fi' }) {
  return new Promise((resolve, reject) => {
    const args = ['wlan', 'connect', `name=${profile}`];
    if (interfaceName) {
      args.push(`interface=${interfaceName}`);
    }
    execFile('netsh.exe', args, { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error((stderr || err.message).toString().trim()));
      }
      resolve({ ok: true, message: (stdout || '').trim() });
    });
  });
}

let simulatedCurrent = {
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
};

export function setSimulatedWifiCurrent(cur) {
  simulatedCurrent = { ...simulatedCurrent, ...cur };
}

export const SIMULATED_WIFI_STATUS = {
  simulated: true,
  get current() {
    return simulatedCurrent;
  },
  savedProfiles: ['NetSwitch-Test-AP', 'Campus-Guest', 'Home-Fiber-5G'],
  scannedNetworks: [
    {
      ssid: 'NetSwitch-Test-AP',
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
};

export const SIMULATED_WIFI_HISTORY = Object.freeze({
  'NetSwitch-Test-AP': { avgScore: 91.2, samples: 120, lastSeen: '2026-11-19T13:00:00.000Z' },
  'Campus-Guest': { avgScore: 58.4, samples: 45, lastSeen: '2026-11-19T11:30:00.000Z' },
});

/**
 * Intersects saved Wi-Fi profiles with scanned networks and produces recommendations.
 * Pure function: unit tested with arbitrary profiles, scan data, and history stats.
 */
export function computeWifiAdvisor({ current = null, savedProfiles = [], scannedNetworks = [], historyStats = {} }) {
  const scannedMap = new Map();
  for (const net of (scannedNetworks || [])) {
    if (!net || !net.ssid) continue;
    const ssid = net.ssid;
    let bestBss = null;
    for (const bss of (net.bssids || [])) {
      if (!bestBss || (bss.signal != null && (bestBss.signal == null || bss.signal > bestBss.signal))) {
        bestBss = bss;
      }
    }
    const signal = bestBss?.signal ?? null;
    const band = bestBss?.band ?? '';
    const channel = bestBss?.channel ?? null;
    const radio = bestBss?.radio ?? '';

    if (!scannedMap.has(ssid) || (signal != null && (scannedMap.get(ssid).signal == null || signal > scannedMap.get(ssid).signal))) {
      scannedMap.set(ssid, {
        ssid,
        signal,
        band,
        channel,
        radio,
        authentication: net.authentication || '',
        encryption: net.encryption || '',
      });
    }
  }

  // Intersect saved profiles with in-range scanned networks
  // savedProfiles defines Windows preference priority (index 0 is highest priority)
  const inRangeSaved = [];
  for (let i = 0; i < (savedProfiles || []).length; i++) {
    const profName = savedProfiles[i];
    if (scannedMap.has(profName)) {
      const scanned = scannedMap.get(profName);
      const hist = historyStats ? historyStats[profName] : null;
      const measuredScore = hist && typeof hist.avgScore === 'number' ? hist.avgScore : null;

      // Formula:
      // if history exists: 0.7 * history + 0.3 * signal-based
      // otherwise: signal-based with a +5 bonus for 5 GHz
      const baseSignal = Math.min(100, Math.max(0, Number(scanned.signal) || 0));
      const is5G = String(scanned.band || '').includes('5');
      let predictedRating;
      if (measuredScore != null) {
        predictedRating = Math.round((0.7 * measuredScore + 0.3 * baseSignal) * 10) / 10;
      } else {
        const bonus = is5G ? 5 : 0;
        predictedRating = Math.min(100, Math.round((baseSignal + bonus) * 10) / 10);
      }

      inRangeSaved.push({
        ssid: profName,
        signal: scanned.signal,
        band: scanned.band,
        channel: scanned.channel,
        radio: scanned.radio,
        priorityIndex: i,
        measuredScore,
        samples: hist?.samples ?? 0,
        lastSeen: hist?.lastSeen ?? null,
        predictedRating,
        hasHistory: measuredScore != null,
      });
    }
  }

  // windowsLikelyPick: the first saved profile, in priority order, that is in range
  const windowsLikelyPick = inRangeSaved.length > 0 ? inRangeSaved[0].ssid : null;

  // Sort in-range saved networks by predicted rating descending (highest predicted rating first)
  const sorted = [...inRangeSaved].sort((a, b) => {
    if (b.predictedRating !== a.predictedRating) return b.predictedRating - a.predictedRating;
    return (b.signal || 0) - (a.signal || 0);
  });

  // recommended: highest predicted rating
  const recommended = sorted.length > 0 ? sorted[0].ssid : null;

  const currentSsid = current?.ssid || null;
  const currentMeasuredScore = currentSsid && historyStats?.[currentSsid]?.avgScore != null
    ? historyStats[currentSsid].avgScore
    : (current?.score ?? null);

  return {
    current: current ? {
      ssid: currentSsid,
      signal: current.signal ?? null,
      band: current.band || null,
      channel: current.channel ?? null,
      state: current.state || null,
      measuredScore: currentMeasuredScore,
    } : null,
    networks: sorted,
    windowsLikelyPick,
    recommended,
  };
}

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
