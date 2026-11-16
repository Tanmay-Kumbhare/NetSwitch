import test from 'node:test';
import assert from 'node:assert/strict';
import { SocketLab } from '../src/lab/sockets.js';
import { MailLab } from '../src/lab/mail.js';
import { dijkstra, graphFromSnapshot, ospfCost } from '../src/lab/dijkstra.js';
import { describeDnsProbe } from '../src/lab/packet.js';
import { validHost, isPrivateIPv4, runTool, resolveName } from '../src/lab/tools.js';
import { compute } from '../src/lab/calc.worker.js';

let s; let m;
test.before(async () => { s = await new SocketLab({ tcpPort: 0, udpPort: 0 }).start(); m = await new MailLab({ smtpPort: 0, pop3Port: 0 }).start(); });
test.after(async () => { await s.close(); await m.close(); });

test('TCP: HELLO, ECHO, LIST and file transfer on one connection, with a primitive trace', async () => {
  const r = await s.tcpSession(['HELLO tanmay', 'ECHO hi there', 'LIST', 'GET notice.txt', 'GET ../../etc/passwd', 'BOGUS']);
  assert.match(r.replies[0].reply, /Hello tanmay/); assert.equal(r.replies[1].reply, '200 hi there');
  assert.match(r.replies[2].reply, /notice\.txt/); assert.match(r.replies[3].body, /INSTITUTE NOTICE/);
  assert.equal(r.replies[4].reply, '404 no such file'); assert.match(r.replies[5].reply, /^400/);
  assert.deepEqual(r.trace.slice(0, 2).map((t) => t.step), ['socket()', 'connect()']); assert.equal(r.trace.at(-1).step, 'close()');
});

test('TCP: PRIME runs on a worker thread', async () => {
  const r = await s.tcpSession(['PRIME 100000']); assert.match(r.replies[0].reply, /= 9592 .*worker thread #\d+/);
});

test('TCP concurrency: 5 clients sleeping 400 ms finish in roughly 400 ms total, not 2000 ms', async () => {
  const r = await s.concurrency(5, 'SLEEP 400');
  assert.ok(r.wallClockMs < 1300, `wall clock ${r.wallClockMs}`); assert.ok(r.sumOfIndividualMs > 1900); assert.ok(r.peakActiveConnections >= 3);
});

test('worker threads keep the event loop free while a CPU-bound request runs', async () => {
  const heavy = s.tcpSession(['PRIME 20000000']); let ticks = 0; const iv = setInterval(() => ticks++, 20);
  await heavy; clearInterval(iv); assert.ok(ticks >= 3, `event loop ticked ${ticks} times during the heavy request`);
});

test('UDP: hello, trigonometry, errors, and simulated loss', async () => {
  assert.match((await s.udpRequest('hello Tanmay')).reply, /Hello Tanmay/);
  assert.match((await s.udpRequest('sin 30')).reply, /sin\(30\) = 0\.5 /); assert.match((await s.udpRequest('cos 60')).reply, /= 0\.5/);
  assert.match((await s.udpRequest('sqrt -4')).reply, /error/); assert.match((await s.udpRequest('xyz')).reply, /commands:/);
  s.setDrop(90); let lost = 0; for (let i = 0; i < 10; i++) if ((await s.udpRequest('time', 120)).lost) lost++; s.setDrop(0);
  assert.ok(lost >= 5, `expected most datagrams lost, lost ${lost}`);
});

test('worker compute function', () => { assert.equal(Math.round(compute('sin', 90)), 1); assert.equal(compute('primes', 100), 25); assert.throws(() => compute('tan', 90)); });

test('SMTP + POP3: send a MIME message, read it back, dot-stuffing and UTF-8 subject survive', async () => {
  const a = await m.sendMail({ subject: 'Failover usb → wifi', text: 'line one\n.starts with a dot\nline three' });
  assert.ok(a.transcript.some((l) => l.startsWith('S: 354'))); assert.ok(a.transcript.some((l) => /^C: Content-Transfer-Encoding: base64/.test(l)));
  const msgs = m.messages(); assert.equal(msgs[0].subject, 'Failover usb → wifi'); assert.match(msgs[0].text, /\.starts with a dot/); assert.equal(msgs[0].mime.version, '1.0');
  const p = await m.retrieve(); assert.ok(p.transcript.some((l) => /^S: \+OK maildrop has 1/.test(l))); assert.ok(p.transcript.some((l) => l.startsWith('C: RETR 1')));
});

test('SMTP rejects out-of-order commands', async () => {
  const net = await import('node:net'); const sock = net.connect(m.smtpPort, '127.0.0.1'); let out = '';
  sock.on('data', (d) => { out += d; }); await new Promise((r) => sock.once('connect', r)); sock.write('DATA\r\nQUIT\r\n'); await new Promise((r) => sock.once('close', r));
  assert.match(out, /503 need MAIL and RCPT first/);
});

test('Dijkstra: textbook graph, steps, unreachable, validation', () => {
  const edges = [['A', 'B', 7], ['A', 'C', 9], ['A', 'F', 14], ['B', 'C', 10], ['B', 'D', 15], ['C', 'D', 11], ['C', 'F', 2], ['D', 'E', 6], ['E', 'F', 9]];
  const r = dijkstra(edges, 'A', 'E'); assert.equal(r.distance, 20); assert.deepEqual(r.path, ['A', 'C', 'F', 'E']); assert.ok(r.steps.length >= 4);
  assert.equal(dijkstra([['A', 'B', 1], ['C', 'D', 1]], 'A', 'D').reachable, false);
  assert.throws(() => dijkstra([['A', 'B', -1]], 'A', 'B')); assert.throws(() => dijkstra([['A', 'B']], 'A', 'B')); assert.throws(() => dijkstra([['A', 'B', 1]], 'A', 'Z'));
  assert.equal(ospfCost(10), 10); assert.equal(ospfCost(1000), 1);
});

test('graph from a NetSwitch snapshot picks the cheaper adapter', () => {
  const g = graphFromSnapshot({ adapters: [{ id: 'wifi', up: true, gateway: '10.0.0.1', rttMs: 35, lossPct: 0, score: 93 }, { id: 'usb', up: true, gateway: '10.1.1.1', rttMs: 45, lossPct: 20, score: 40 }, { id: 'x', up: false, gateway: '1.1.1.1' }] });
  assert.equal(g.edges.length, 4); assert.deepEqual(dijkstra(g.edges, 'Laptop', 'Internet').path.slice(0, 2), ['Laptop', 'GW wifi (10.0.0.1)']);
});

test('packet anatomy: real DNS bytes inside Ethernet/IPv4/UDP', () => {
  const p = describeDnsProbe({ srcIp: '10.97.128.167', dstIp: '1.1.1.1' });
  assert.equal(p.layers.length, 4); assert.equal(p.layers[3].size, 29); assert.equal(p.totalFrameBytes, 14 + 20 + 8 + 29); assert.match(p.dnsHex, /07 65 78 61 6d 70 6c 65 03 63 6f 6d 00/);
});

test('tool validation: only hostnames and IPv4, no shell metacharacters, private hosts refused for TLS', async () => {
  assert.ok(validHost('example.com') && validHost('8.8.8.8') && validHost('localhost')); assert.ok(!validHost('a; calc') && !validHost('$(id)') && !validHost('x y.com') && !validHost(''));
  assert.ok(isPrivateIPv4('10.1.2.3') && isPrivateIPv4('127.0.0.1') && isPrivateIPv4('192.168.1.1') && !isPrivateIPv4('8.8.8.8'));
  await assert.rejects(runTool('ping', { target: '1.1.1.1; calc' }), /valid host/); await assert.rejects(runTool('rm', {}), /unknown tool/);
  await assert.rejects(runTool('tls', { target: '127.0.0.1' }), /public hosts/); await assert.rejects(resolveName('example.com', 'A', '6.6.6.6'), /server must be/);
  const ip = await runTool('ipconfig', {}); assert.ok(ip.output.length > 0 && ip.what);
});

test('a busy port falls back to a free one instead of crashing the app', async () => {
  const s2 = await new SocketLab({ tcpPort: s.tcpPort, udpPort: s.udpPort }).start();
  assert.notEqual(s2.tcpPort, s.tcpPort); assert.notEqual(s2.udpPort, s.udpPort); assert.match((await s2.tcpSession(['TIME'])).replies[0].reply, /^200 /); await s2.close();
});
