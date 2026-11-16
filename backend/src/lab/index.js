// Lab add-on: syllabus concepts made visible. Everything is additive and self-contained.
//   import { startLab, registerLabRoutes } from './lab/index.js';
import { SocketLab } from './sockets.js';
import { MailLab } from './mail.js';
import { dijkstra, graphFromSnapshot, ospfCost } from './dijkstra.js';
import { describeDnsProbe } from './packet.js';
import { runTool, TOOL_NAMES } from './tools.js';

export async function startLab({ log = () => {}, ports = {} } = {}) {
  const sockets = await new SocketLab({ ...ports, log }).start();
  const mail = await new MailLab({ log }).start();
  return { sockets, mail, onFailover: (e) => mail.onFailover(e), close: async () => { await sockets.close(); await mail.close(); } };
}

const bad = (msg, status = 400) => { const e = new Error(msg); e.status = status; return e; };

export function registerLabRoutes(app, { lab, getSnapshot, requireAuth, requireAdmin }) {
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const base = '/api/lab';
  let toolBusy = false;

  app.get(`${base}/status`, requireAuth, (req, res) => res.json({ sockets: lab.sockets.status(), mail: { smtpPort: lab.mail.smtpPort, pop3Port: lab.mail.pop3Port, stored: lab.mail.box.length }, tools: TOOL_NAMES }));

  app.post(`${base}/tcp`, requireAuth, wrap(async (req, res) => {
    const cmds = req.body?.commands;
    if (!Array.isArray(cmds) || !cmds.length || cmds.length > 8 || cmds.some((c) => typeof c !== 'string' || !c.trim() || c.length > 200 || /[\r\n]/.test(c))) throw bad('commands: 1-8 single-line strings of at most 200 characters');
    res.json(await lab.sockets.tcpSession(cmds));
  }));
  app.post(`${base}/udp`, requireAuth, wrap(async (req, res) => {
    const m = req.body?.message; if (typeof m !== 'string' || !m.trim() || m.length > 200) throw bad('message: 1-200 characters');
    res.json(await lab.sockets.udpRequest(m));
  }));
  app.post(`${base}/udp-drop`, requireAdmin, (req, res) => res.json({ dropPct: lab.sockets.setDrop(req.body?.pct) }));
  app.post(`${base}/concurrency`, requireAuth, wrap(async (req, res) => {
    const n = Number(req.body?.clients); const cmd = String(req.body?.command || '');
    if (!Number.isInteger(n) || n < 1 || n > 10) throw bad('clients must be 1-10');
    if (!/^(SLEEP \d{1,4}|PRIME \d{1,8}|HELLO \w{1,20}|TIME)$/i.test(cmd)) throw bad('command must be SLEEP <ms>, PRIME <n>, HELLO <name> or TIME');
    res.json(await lab.sockets.concurrency(n, cmd));
  }));

  app.post(`${base}/dijkstra`, requireAuth, wrap(async (req, res) => {
    try { res.json(dijkstra(req.body?.edges, req.body?.src, req.body?.dst)); } catch (e) { throw bad(e.message); }
  }));
  app.get(`${base}/routing-graph`, requireAuth, (req, res) => {
    const { edges, costs } = graphFromSnapshot(getSnapshot());
    const r = edges.length ? dijkstra(edges, 'Laptop', 'Internet') : null;
    res.json({ edges, costs, result: r, ospfExample: [10, 100, 1000].map((m) => ({ mbps: m, cost: ospfCost(m) })) });
  });

  app.get(`${base}/packet`, requireAuth, (req, res) => {
    const a = getSnapshot()?.adapters?.[0]; res.json(describeDnsProbe({ srcIp: a?.ip, dstIp: (a?.targets?.[0]) || '1.1.1.1' }));
  });

  app.post(`${base}/tool`, requireAuth, wrap(async (req, res) => {
    if (toolBusy) throw bad('another tool is still running', 409);
    toolBusy = true; try { res.json(await runTool(String(req.body?.tool), { target: req.body?.target, type: req.body?.type, server: req.body?.server })); } finally { toolBusy = false; }
  }));

  app.get(`${base}/mail`, requireAuth, (req, res) => res.json({ messages: lab.mail.messages() }));
  app.post(`${base}/mail/send`, requireAuth, wrap(async (req, res) => {
    const { subject, text } = req.body || {};
    if (typeof subject !== 'string' || !subject.trim() || subject.length > 150 || typeof text !== 'string' || text.length > 2000) throw bad('subject (1-150) and text (max 2000) required');
    res.json(await lab.mail.sendMail({ subject: subject.replace(/[\r\n]/g, ' '), text }));
  }));
  app.get(`${base}/mail/pop3`, requireAuth, wrap(async (req, res) => res.json(await lab.mail.retrieve())));
}
