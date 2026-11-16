// Minimal SMTP server + client and POP3 server + client over plain TCP (RFC 5321 / RFC 5322 / RFC 1939 subset).
// Everything stays on 127.0.0.1. Used to show protocol dialogs, MIME headers and the receive path in the UI.
import net from 'node:net';
import { listenOrFallback } from './sockets.js';

const CRLF = '\r\n';
const MAX_MSG = 50_000;

function parseMessage(raw) {
  const [head, ...body] = raw.split(/\r\n\r\n/); const headers = {};
  for (const line of head.replace(/\r\n[ \t]+/g, ' ').split(/\r\n/)) { const i = line.indexOf(':'); if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim(); }
  let text = body.join('\r\n\r\n');
  if ((headers['content-transfer-encoding'] || '').toLowerCase() === 'base64') text = Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
  let subject = headers.subject || '';
  const enc = /^=\?UTF-8\?B\?(.+)\?=$/i.exec(subject); if (enc) subject = Buffer.from(enc[1], 'base64').toString('utf8');
  return { headers, subject, text };
}

export function buildMime({ from, to, subject, text }) {
  const ascii = /^[\x00-\x7f]*$/.test(subject + text);
  const subj = /^[\x00-\x7f]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const body = ascii ? text.replace(/\r?\n/g, CRLF) : Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, `$1${CRLF}`);
  return [`From: ${from}`, `To: ${to}`, `Subject: ${subj}`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@netswitch.local>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', `Content-Transfer-Encoding: ${ascii ? '7bit' : 'base64'}`, '', body].join(CRLF);
}

export class MailLab {
  constructor({ smtpPort = 5025, pop3Port = 5110, host = '127.0.0.1', log = () => {} } = {}) {
    Object.assign(this, { smtpPort, pop3Port, host, log }); this.box = [];
  }

  async start() {
    this.smtp = net.createServer((s) => this.#smtpSession(s)); this.pop3 = net.createServer((s) => this.#pop3Session(s));
    await listenOrFallback(this.smtp, this.smtpPort, this.host); this.smtpPort = this.smtp.address().port;
    await listenOrFallback(this.pop3, this.pop3Port, this.host); this.pop3Port = this.pop3.address().port;
    this.log(`[lab] SMTP ${this.host}:${this.smtpPort}, POP3 ${this.host}:${this.pop3Port}`);
    return this;
  }

  #lines(sock, onLine) {
    sock.setEncoding('utf8'); sock.setTimeout(15000, () => sock.destroy()); sock.on('error', () => {});
    let buf = ''; sock.on('data', (d) => { buf += d; if (buf.length > MAX_MSG * 2) return sock.destroy(); let i; while ((i = buf.indexOf(CRLF)) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); onLine(l); } });
  }

  #smtpSession(sock) {
    let from = ''; let to = []; let data = null; const send = (l) => sock.write(l + CRLF);
    send('220 netswitch.local ESMTP NetSwitch ready');
    this.#lines(sock, (line) => {
      if (data) {
        if (line === '.') {
          const raw = data.join(CRLF); data = null;
          if (raw.length > MAX_MSG) { send('552 message too large'); return; }
          this.box.push({ id: this.box.length + 1, receivedAt: Date.now(), envelopeFrom: from, envelopeTo: to, raw, ...parseMessage(raw) }); if (this.box.length > 50) this.box.shift();
          from = ''; to = []; send(`250 OK queued as ${this.box.length}`); return;
        }
        data.push(line.startsWith('.') ? line.slice(1) : line); return; // dot-unstuffing
      }
      const [cmd] = line.split(' '); const u = cmd.toUpperCase();
      if (u === 'EHLO' || u === 'HELO') send('250 netswitch.local greets you');
      else if (u === 'MAIL') { const m = /^MAIL FROM:\s*<([^>]*)>/i.exec(line); if (!m) return send('501 syntax: MAIL FROM:<address>'); from = m[1]; send('250 OK'); }
      else if (u === 'RCPT') { const m = /^RCPT TO:\s*<([^>]+)>/i.exec(line); if (!m || !from) return send(from ? '501 syntax: RCPT TO:<address>' : '503 need MAIL first'); to.push(m[1]); send('250 OK'); }
      else if (u === 'DATA') { if (!from || !to.length) return send('503 need MAIL and RCPT first'); data = []; send('354 end data with <CRLF>.<CRLF>'); }
      else if (u === 'RSET') { from = ''; to = []; send('250 OK'); }
      else if (u === 'NOOP') send('250 OK');
      else if (u === 'QUIT') { send('221 bye'); sock.end(); }
      else send('502 command not implemented');
    });
  }

  #pop3Session(sock) {
    let user = ''; let authed = false; const send = (l) => sock.write(l + CRLF);
    send('+OK NetSwitch POP3 ready');
    this.#lines(sock, (line) => {
      const [cmd, arg] = line.split(' '); const u = cmd.toUpperCase();
      if (u === 'USER') { user = arg || ''; send('+OK'); }
      else if (u === 'PASS') { authed = !!user; send(authed ? `+OK maildrop has ${this.box.length} messages` : '-ERR USER first'); }
      else if (!authed && u !== 'QUIT') send('-ERR authenticate first');
      else if (u === 'STAT') send(`+OK ${this.box.length} ${this.box.reduce((a, m) => a + m.raw.length, 0)}`);
      else if (u === 'LIST') { send(`+OK ${this.box.length} messages`); this.box.forEach((m, i) => send(`${i + 1} ${m.raw.length}`)); send('.'); }
      else if (u === 'RETR') { const m = this.box[Number(arg) - 1]; if (!m) return send('-ERR no such message'); send(`+OK ${m.raw.length} octets`); for (const l of m.raw.split(CRLF)) send(l.startsWith('.') ? `.${l}` : l); send('.'); }
      else if (u === 'NOOP') send('+OK');
      else if (u === 'QUIT') { send('+OK bye'); sock.end(); }
      else send('-ERR command not implemented');
    });
  }

  /** Real SMTP client dialog against our own server. Returns the transcript (C: / S: lines). */
  sendMail({ from = 'netswitch@netswitch.local', to = 'admin@netswitch.local', subject, text }) {
    return this.#dialog(this.smtpPort, (say, expect) => async () => {
      await expect('220'); await say('EHLO client.netswitch.local', '250'); await say(`MAIL FROM:<${from}>`, '250'); await say(`RCPT TO:<${to}>`, '250'); await say('DATA', '354');
      const msg = buildMime({ from, to, subject, text }).split(CRLF).map((l) => (l.startsWith('.') ? `.${l}` : l)).join(CRLF);
      await say(msg + CRLF + '.', '250'); await say('QUIT', '221');
    });
  }

  /** Real POP3 client dialog: login, STAT, LIST, RETR of the newest message. */
  retrieve() {
    return this.#dialog(this.pop3Port, (say, expect, readMulti) => async () => {
      await expect('+OK'); await say('USER admin', '+OK'); await say('PASS secret', '+OK'); await say('STAT', '+OK');
      await say('LIST', '+OK', true);
      if (this.box.length) await say(`RETR ${this.box.length}`, '+OK', true);
      await say('QUIT', '+OK');
    });
  }

  async #dialog(port, build) {
    const transcript = []; const sock = net.connect({ host: this.host, port }); sock.setEncoding('utf8'); sock.setTimeout(8000, () => sock.destroy());
    let buf = ''; let wake = null; sock.on('data', (d) => { buf += d; wake?.(); }); sock.on('error', () => wake?.());
    const wait = (pred) => new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('timeout')), 6000); const c = () => { if (pred()) { clearTimeout(to); wake = null; res(); } }; wake = c; c(); });
    const take = async (multi) => { await wait(() => (multi ? /\r\n\.\r\n$/.test(buf) || /^-ERR/.test(buf) : /\r\n$/.test(buf))); const r = buf; buf = ''; transcript.push(...r.trimEnd().split(CRLF).map((l) => `S: ${l}`)); return r; };
    const expect = async (code, multi = false) => { const r = await take(multi); if (!r.startsWith(code) && !r.startsWith(code.slice(0, 1))) throw new Error(`expected ${code}, got ${r.slice(0, 40)}`); return r; };
    const say = async (line, code, multi = false) => { transcript.push(...line.split(CRLF).map((l) => `C: ${l}`)); sock.write(line + CRLF); return expect(code, multi); };
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    try { await build(say, expect)(); } finally { sock.destroy(); }
    return { transcript, stored: this.box.length };
  }

  /** Called by the server when a failover happens: sends an alert e-mail through the SMTP server above. */
  onFailover(e) {
    return this.sendMail({ subject: `NetSwitch failover: ${e.from} -> ${e.to} (${String(e.reason).replace('_', ' ')})`, text: `Time: ${new Date(e.ts).toISOString()}\nFrom: ${e.from}\nTo: ${e.to}\nReason: ${e.reason}\nTotal time: ${e.totalMs ?? 'n/a'} ms\nResult: ${e.success ? 'verified' : 'failed and rolled back'}\n${e.note || ''}` }).catch(() => {});
  }

  messages() { return this.box.map(({ id, receivedAt, envelopeFrom, envelopeTo, subject, text, headers }) => ({ id, receivedAt, from: envelopeFrom, to: envelopeTo, subject, text, mime: { version: headers['mime-version'], type: headers['content-type'], encoding: headers['content-transfer-encoding'] } })).reverse(); }

  async close() { const a = new Promise((r) => this.smtp?.close(r)); const b = new Promise((r) => this.pop3?.close(r)); this.smtp?.closeAllConnections?.(); this.pop3?.closeAllConnections?.(); await Promise.all([a, b]); }
}
