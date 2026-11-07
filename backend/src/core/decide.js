// Pure failover decision function. No I/O, no clocks, no globals: everything comes in as arguments.
//
// state  : { activeId, preferredId|null, holdUntil, degradeCount, switchBackCount }
// inputs : { adapters: { [id]: { up:boolean, score:number|null, consecutiveLost:number, tcpOk:boolean|null } } }
// returns: { state, action: null | { type:'switch', to, reason }, phase, note }
//
// phase: STABLE | HOLD_DOWN | UNVERIFIED | NO_INTERNET
// reasons: adapter_down | hard_failure | degradation | switch_back

export function initialState(activeId, preferredId = null) {
  return { activeId, preferredId, holdUntil: 0, degradeCount: 0, switchBackCount: 0 };
}

const eligible = (a, min) => a && a.up && a.score != null && a.score >= min;

function bestCandidate(adapters, activeId, min) {
  let best = null;
  for (const [id, a] of Object.entries(adapters)) {
    if (id === activeId || !eligible(a, min)) continue;
    if (!best || a.score > adapters[best].score) best = id;
  }
  return best;
}

function switched(state, to, nowMs, cfg) {
  return { ...state, activeId: to, holdUntil: nowMs + cfg.holdDownMs, degradeCount: 0, switchBackCount: 0 };
}

export function decide(state, inputs, nowMs, cfg) {
  const adapters = inputs.adapters;
  const act = adapters[state.activeId];
  const inHold = nowMs < state.holdUntil;
  let s = { ...state };

  if (!act) return { state: s, action: null, phase: 'UNVERIFIED', note: 'active adapter unknown' };

  // 1) Hard failure: bypasses hold-down so a user is never trapped on a dead link.
  const down = !act.up;
  const hard = act.up && act.consecutiveLost >= cfg.hardFailLost && act.tcpOk === false;
  if (down || hard) {
    const to = bestCandidate(adapters, s.activeId, cfg.minHealthyScore);
    if (to) {
      return { state: switched(s, to, nowMs, cfg), action: { type: 'switch', to, reason: down ? 'adapter_down' : 'hard_failure' }, phase: 'HOLD_DOWN', note: 'failover' };
    }
    return { state: { ...s, degradeCount: 0, switchBackCount: 0 }, action: null, phase: 'NO_INTERNET', note: 'no verified internet on any adapter' };
  }

  // 2) No switching on missing data.
  if (act.score == null) return { state: { ...s, degradeCount: 0, switchBackCount: 0 }, action: null, phase: 'UNVERIFIED', note: 'active adapter has no score yet' };

  // 3) Hold-down blocks everything except hard failure.
  if (inHold) return { state: { ...s, degradeCount: 0, switchBackCount: 0 }, action: null, phase: 'HOLD_DOWN', note: 'hold-down' };

  // 4) Degradation: a clearly better candidate for N consecutive evaluations.
  const cand = bestCandidate(adapters, s.activeId, cfg.minHealthyScore);
  if (cand && adapters[cand].score - act.score >= cfg.degradeMargin) {
    s.degradeCount += 1;
    if (s.degradeCount >= cfg.degradeChecks) {
      return { state: switched(s, cand, nowMs, cfg), action: { type: 'switch', to: cand, reason: 'degradation' }, phase: 'HOLD_DOWN', note: 'degradation' };
    }
  } else {
    s.degradeCount = 0;
  }

  // 5) Switch-back to the preferred adapter once it is clearly healthy again.
  const pref = s.preferredId && s.preferredId !== s.activeId ? adapters[s.preferredId] : null;
  if (pref && pref.up && pref.score != null && pref.score >= cfg.switchBackMinScore && pref.score - act.score >= cfg.switchBackMargin) {
    s.switchBackCount += 1;
    if (s.switchBackCount >= cfg.switchBackChecks) {
      return { state: switched(s, s.preferredId, nowMs, cfg), action: { type: 'switch', to: s.preferredId, reason: 'switch_back' }, phase: 'HOLD_DOWN', note: 'switch back' };
    }
  } else {
    s.switchBackCount = 0;
  }

  return { state: s, action: null, phase: 'STABLE', note: '' };
}
