import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNetsh, parseInterfaces, parseProfiles, getWifiStatus } from '../src/windows/wifiScan.js';
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
