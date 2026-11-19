import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNetsh, parseInterfaces, parseProfiles, getWifiStatus, computeWifiAdvisor } from '../src/windows/wifiScan.js';
import { toAdapters, classify } from '../src/windows/discovery.js';
import { parsePing } from '../src/probes/icmp.js';
import { buildQuery, parseResponse } from '../src/probes/dnsPacket.js';
import { int, ip4 } from '../src/windows/ps.js';

test('netsh parser reads the S5 sample (Moto g64 5G)', () => {
  const txt = `
Interface name : Wi-Fi
There is 1 network currently visible.

SSID 1 : Moto g64 5G
    Network type            : Infrastructure
    Authentication          : WPA3-Personal
    Encryption              : CCMP
    BSSID 1                 : 66:71:2f:94:31:f9
         Signal             : 97%
         Radio type         : 802.11ac
         Band               : 2.4 GHz
         Channel            : 1
`;
  const n = parseNetsh(txt);
  assert.equal(n.length, 1);
  assert.equal(n[0].ssid, 'Moto g64 5G');
  assert.equal(n[0].authentication, 'WPA3-Personal');
  assert.deepEqual(n[0].bssids[0], { bssid: '66:71:2f:94:31:f9', signal: 97, radio: '802.11ac', band: '2.4 GHz', channel: 1 });
});

test('netsh wlan show interfaces parser reads connected interface details', () => {
  const sample = `
There is 1 interface on the system: 

    Name                   : Wi-Fi
    Description            : Intel(R) Wi-Fi 6 AX203
    GUID                   : 79d3b1f2-252b-4e2c-adf8-1f0379a04dd9
    Physical address       : 6c:2f:80:26:39:2d
    Interface type         : Primary
    State                  : connected
    SSID                   : Campus_5G
    BSSID                  : a4:c3:f0:12:34:56
    Network type           : Infrastructure
    Radio type             : 802.11ax
    Authentication         : WPA3-Personal
    Cipher                 : CCMP
    Connection mode        : Auto Connect
    Band                   : 5 GHz
    Channel                : 36
    Receive rate (Mbps)    : 866.7
    Transmit rate (Mbps)   : 866.7
    Signal                 : 85% 
    Profile                : Campus_5G 
`;
  const info = parseInterfaces(sample);
  assert.ok(info);
  assert.equal(info.name, 'Wi-Fi');
  assert.equal(info.state, 'connected');
  assert.equal(info.ssid, 'Campus_5G');
  assert.equal(info.bssid, 'a4:c3:f0:12:34:56');
  assert.equal(info.signal, 85);
  assert.equal(info.radio, '802.11ax');
  assert.equal(info.band, '5 GHz');
  assert.equal(info.channel, 36);
  assert.equal(info.rxRate, 866.7);
  assert.equal(info.txRate, 866.7);
});

test('netsh wlan show interfaces parser handles disconnected and no interface', () => {
  const dis = `
There is 1 interface on the system: 

    Name                   : Wi-Fi
    Description            : Intel(R) Wi-Fi 6 AX203
    State                  : disconnected
`;
  const dInfo = parseInterfaces(dis);
  assert.ok(dInfo);
  assert.equal(dInfo.state, 'disconnected');
  assert.equal(dInfo.ssid, null);

  assert.equal(parseInterfaces('There is no wireless interface on the system.'), null);
  assert.equal(parseInterfaces('The Wireless AutoConfig Service (wlansvc) is not running.'), null);
});

test('netsh wlan show profiles parser extracts saved profile names', () => {
  const sample = `
Profiles on interface Wi-Fi:

Group policy profiles (read only)
---------------------------------
    <None>

User profiles
-------------
    All User Profile     : Campus_5G
    All User Profile     : Moto g64 5G
    All User Profile     : VIT_STUDENT
`;
  const list = parseProfiles(sample);
  assert.deepEqual(list, ['Campus_5G', 'Moto g64 5G', 'VIT_STUDENT']);
  assert.deepEqual(parseProfiles('There is no wireless interface on the system.'), []);
});

test('getWifiStatus returns simulated payload in sim mode', async () => {
  const st = await getWifiStatus({ mode: 'sim' });
  assert.equal(st.simulated, true);
  assert.ok(st.current);
  assert.equal(st.current.state, 'connected');
  assert.ok(Array.isArray(st.savedProfiles));
  assert.ok(Array.isArray(st.scannedNetworks));
});

test('computeWifiAdvisor intersects saved+in-range networks and calculates predicted ratings', () => {
  const savedProfiles = ['Campus_Fast_5G', 'Legacy_2G', 'Cafe_5G', 'Not_Present_SSID'];
  const scannedNetworks = [
    {
      ssid: 'Campus_Fast_5G',
      bssids: [{ bssid: '01', signal: 85, band: '5 GHz', channel: 36 }],
    },
    {
      ssid: 'Legacy_2G',
      bssids: [{ bssid: '02', signal: 70, band: '2.4 GHz', channel: 6 }],
    },
    {
      ssid: 'Cafe_5G',
      bssids: [{ bssid: '03', signal: 80, band: '5 GHz', channel: 149 }],
    },
    {
      ssid: 'Stranger_Network',
      bssids: [{ bssid: '04', signal: 99, band: '5 GHz', channel: 44 }],
    },
  ];
  const historyStats = {
    // 0.7 * 92 + 0.3 * 85 = 64.4 + 25.5 = 89.9
    Campus_Fast_5G: { avgScore: 92.0, samples: 30, lastSeen: '2026-11-19T10:00:00Z' },
    // 0.7 * 50 + 0.3 * 70 = 35.0 + 21.0 = 56.0
    Legacy_2G: { avgScore: 50.0, samples: 10, lastSeen: '2026-11-19T09:00:00Z' },
    // Cafe_5G has no history: 80 + 5 (5GHz bonus) = 85.0
  };

  const res = computeWifiAdvisor({
    current: { ssid: 'Campus_Fast_5G', state: 'connected', signal: 85, band: '5 GHz' },
    savedProfiles,
    scannedNetworks,
    historyStats,
  });

  assert.equal(res.current.ssid, 'Campus_Fast_5G');
  assert.equal(res.current.measuredScore, 92.0);
  assert.equal(res.networks.length, 3); // excludes Stranger_Network (not saved) and Not_Present_SSID (not in range)

  // Verify sorting by predicted rating descending
  // 1: Campus_Fast_5G (89.9)
  // 2: Cafe_5G (85.0)
  // 3: Legacy_2G (56.0)
  assert.equal(res.networks[0].ssid, 'Campus_Fast_5G');
  assert.equal(res.networks[0].predictedRating, 89.9);
  assert.equal(res.networks[0].hasHistory, true);

  assert.equal(res.networks[1].ssid, 'Cafe_5G');
  assert.equal(res.networks[1].predictedRating, 85.0);
  assert.equal(res.networks[1].hasHistory, false);

  assert.equal(res.networks[2].ssid, 'Legacy_2G');
  assert.equal(res.networks[2].predictedRating, 56.0);

  // windowsLikelyPick is the first saved profile in priority order that is in range
  assert.equal(res.windowsLikelyPick, 'Campus_Fast_5G');
  // recommended is the highest predicted rating
  assert.equal(res.recommended, 'Campus_Fast_5G');
});

test('computeWifiAdvisor identifies when Windows likely pick differs from NetSwitch recommended', () => {
  // Windows priority order has Weak_Default first, but Strong_Fiber has higher quality/score
  const savedProfiles = ['Weak_Default', 'Strong_Fiber'];
  const scannedNetworks = [
    {
      ssid: 'Weak_Default',
      bssids: [{ bssid: '01', signal: 50, band: '2.4 GHz', channel: 1 }],
    },
    {
      ssid: 'Strong_Fiber',
      bssids: [{ bssid: '02', signal: 95, band: '5 GHz', channel: 36 }],
    },
  ];
  const historyStats = {
    // 0.7 * 96 + 0.3 * 95 = 67.2 + 28.5 = 95.7
    Strong_Fiber: { avgScore: 96.0, samples: 50, lastSeen: '2026-11-19T10:00:00Z' },
  };

  const res = computeWifiAdvisor({ savedProfiles, scannedNetworks, historyStats });
  // Windows would pick Weak_Default because it is #0 in saved profile priority
  assert.equal(res.windowsLikelyPick, 'Weak_Default');
  // NetSwitch recommends Strong_Fiber because rating is 95.7 vs 50.0
  assert.equal(res.recommended, 'Strong_Fiber');
});

test('computeWifiAdvisor handles empty and null inputs safely', () => {
  const empty = computeWifiAdvisor({});
  assert.equal(empty.current, null);
  assert.deepEqual(empty.networks, []);
  assert.equal(empty.windowsLikelyPick, null);
  assert.equal(empty.recommended, null);
});

test('adapter classification and ids', () => {
  assert.equal(classify('Intel(R) Wi-Fi 6 AX203 160MHz', 'Wi-Fi'), 'wifi');
  assert.equal(classify('Remote NDIS based Internet Sharing Device', 'Ethernet 2'), 'usb');
  const a = toAdapters([{ index: 12, alias: 'Wi-Fi', description: 'Intel Wi-Fi 6', ip: '10.97.128.167', prefix: 24, gateway: '10.97.128.135', metric: 75, autoMetric: false },
    { index: 17, alias: 'Ethernet 2', description: 'Remote NDIS', ip: '10.41.171.54', prefix: 24, gateway: '10.41.171.250', metric: 5, autoMetric: false }]);
  assert.deepEqual(a.map((x) => x.id), ['wifi', 'usb']);
});

test('ping output parsing', () => {
  assert.equal(parsePing('Reply from 1.1.1.1: bytes=32 time=37ms TTL=57'), 37);
  assert.equal(parsePing('Reply from 1.1.1.1: bytes=32 time<1ms TTL=57'), 0.5);
  assert.equal(parsePing('Request timed out.'), null);
  assert.equal(parsePing('64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.3 ms'), 12.3);
});

test('DNS packet round trip', () => {
  const q = buildQuery(0xabcd);
  assert.equal(q.readUInt16BE(0), 0xabcd);
  assert.equal(q.readUInt16BE(4), 1); // QDCOUNT
  const resp = Buffer.from(q); resp.writeUInt16BE(0x8180, 2);
  assert.deepEqual(parseResponse(resp), { id: 0xabcd, isResponse: true, rcode: 0 });
  assert.equal(parseResponse(q).isResponse, false);
  assert.equal(parseResponse(Buffer.alloc(3)), null);
});

test('PowerShell argument validators reject anything but ints and IPv4', () => {
  assert.equal(int(12), 12);
  assert.throws(() => int('12; calc'));
  assert.throws(() => ip4('1.1.1.1; calc'));
  assert.equal(ip4('8.8.8.8'), '8.8.8.8');
});
