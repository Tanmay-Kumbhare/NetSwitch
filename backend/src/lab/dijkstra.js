// Dijkstra shortest path: the algorithm behind link-state routing (OSPF). Pure functions, no I/O.

export function dijkstra(edges, src, dst, { directed = false } = {}) {
  if (!Array.isArray(edges) || edges.length > 200) throw new Error('edges must be an array of at most 200 entries');
  const adj = new Map();
  const add = (a, b, w) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push({ to: b, w }); };
  for (const e of edges) {
    if (!Array.isArray(e) || e.length !== 3) throw new Error('each edge must be [from, to, cost]');
    const [a, b, w] = [String(e[0]), String(e[1]), Number(e[2])];
    if (!a || !b || a.length > 30 || b.length > 30) throw new Error('node names must be 1-30 characters');
    if (!Number.isFinite(w) || w < 0) throw new Error('costs must be non-negative numbers (Dijkstra requirement)');
    add(a, b, w); if (!directed) add(b, a, w); if (!adj.has(b)) adj.set(b, []);
  }
  src = String(src); dst = String(dst);
  if (!adj.has(src) || !adj.has(dst)) throw new Error('source and destination must appear in the edge list');
  const dist = new Map([...adj.keys()].map((n) => [n, Infinity])); const prev = new Map(); const done = new Set(); const steps = [];
  dist.set(src, 0);
  while (done.size < adj.size) {
    let u = null; for (const [n, d] of dist) if (!done.has(n) && (u === null || d < dist.get(u))) u = n;
    if (u === null || dist.get(u) === Infinity) break;
    done.add(u); const relaxed = [];
    for (const { to, w } of adj.get(u)) {
      if (done.has(to)) continue; const nd = dist.get(u) + w;
      if (nd < dist.get(to)) { relaxed.push({ to, old: dist.get(to) === Infinity ? '∞' : dist.get(to), new: nd, via: u }); dist.set(to, nd); prev.set(to, u); }
    }
    steps.push({ visit: u, distance: dist.get(u), relaxed, table: Object.fromEntries([...dist].map(([n, d]) => [n, d === Infinity ? '∞' : d])) });
    if (u === dst) break;
  }
  const path = []; if (dist.get(dst) !== Infinity) for (let n = dst; n !== undefined; n = prev.get(n)) path.unshift(n);
  return { src, dst, reachable: dist.get(dst) !== Infinity, distance: dist.get(dst) === Infinity ? null : dist.get(dst), path, steps };
}

/** Builds a link-state graph from a NetSwitch snapshot. Cost = median RTT (ms) + 10 x loss(%), the same signals the score uses. */
export function graphFromSnapshot(snap) {
  const edges = []; const costs = [];
  for (const a of snap?.adapters ?? []) {
    if (!a.up) continue;
    const cost = Math.max(1, Math.round((a.rttMs ?? 100) + 10 * (a.lossPct ?? 0)));
    edges.push(['Laptop', `GW ${a.id} (${a.gateway})`, cost]); edges.push([`GW ${a.id} (${a.gateway})`, 'Internet', 1]);
    costs.push({ adapter: a.id, cost, rttMs: a.rttMs, lossPct: a.lossPct, score: a.score });
  }
  return { edges, costs };
}

/** OSPF interface cost = reference bandwidth / interface bandwidth (Cisco default reference: 100 Mbps). */
export const ospfCost = (mbps, refMbps = 100) => Math.max(1, Math.round(refMbps / mbps));
