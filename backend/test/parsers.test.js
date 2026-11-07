import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNetsh } from '../src/windows/wifiScan.js';
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
