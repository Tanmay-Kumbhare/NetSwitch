import test from 'node:test';
import assert from 'node:assert/strict';
import { runDemoScenario, SCENARIO_DEFS } from '../src/core/demo.js';
import { DEFAULTS } from '../src/config.js';

test('Scenario 1: gradual Wi-Fi degradation fails over to USB after 5 checks', () => {
  const result = runDemoScenario('degradation', DEFAULTS);
  assert.equal(result.scenario, 'degradation');
  assert.ok(result.timeline.length >= 10);

  // Before second 4, both links are stable
  assert.equal(result.timeline[0].activeId, 'wifi');
  assert.equal(result.timeline[0].phase, 'STABLE');
  assert.equal(result.timeline[0].action, null);

  // Degrade count increments from sec 4 to 8
  const sec8 = result.timeline.find((t) => t.second === 8);
  assert.ok(sec8, 'second 8 frame exists');
  assert.deepEqual(sec8.action, { type: 'switch', to: 'usb', reason: 'degradation' });
  assert.equal(sec8.activeId, 'usb');
  assert.equal(sec8.phase, 'HOLD_DOWN');

  // Exactly one switch occurs
  const switches = result.timeline.filter((t) => t.action);
  assert.equal(switches.length, 1);
  assert.equal(switches[0].action.reason, 'degradation');
});

test('Scenario 2: hard failure triggers immediate failover at second 3', () => {
  const result = runDemoScenario('hard_failure', DEFAULTS);
  assert.equal(result.scenario, 'hard_failure');

  const sec3 = result.timeline.find((t) => t.second === 3);
  assert.ok(sec3, 'second 3 frame exists');
  assert.deepEqual(sec3.action, { type: 'switch', to: 'usb', reason: 'hard_failure' });
  assert.equal(sec3.activeId, 'usb');

  // Post-failure frames stay on USB
  const sec4 = result.timeline.find((t) => t.second === 4);
  assert.equal(sec4.activeId, 'usb');
});

test('Scenario 3: flapping link is suppressed by hold-down timer', () => {
  const result = runDemoScenario('flapping', DEFAULTS);
  assert.equal(result.scenario, 'flapping');

  // Active is USB, hold-down is active
  for (const frame of result.timeline) {
    assert.equal(frame.activeId, 'usb');
    assert.equal(frame.phase, 'HOLD_DOWN');
    assert.equal(frame.action, null, `no switches allowed during hold-down at sec ${frame.second}`);
  }
});

test('Scenario 4: recovery triggers switch-back after 10 consecutive evaluations', () => {
  const result = runDemoScenario('recovery_switch_back', DEFAULTS);
  assert.equal(result.scenario, 'recovery_switch_back');

  // Initial active is USB
  assert.equal(result.timeline[0].activeId, 'usb');
  assert.equal(result.timeline[0].preferredId, 'wifi');

  // Switch back occurs after 10 evaluations at second 12
  const sec12 = result.timeline.find((t) => t.second === 12);
  assert.ok(sec12, 'second 12 frame exists');
  assert.deepEqual(sec12.action, { type: 'switch', to: 'wifi', reason: 'switch_back' });
  assert.equal(sec12.activeId, 'wifi');

  // Exactly one switch occurs
  const switches = result.timeline.filter((t) => t.action);
  assert.equal(switches.length, 1);
  assert.equal(switches[0].action.reason, 'switch_back');
});

test('Scenario 5: both links bad results in NO_INTERNET state without switching', () => {
  const result = runDemoScenario('no_internet', DEFAULTS);
  assert.equal(result.scenario, 'no_internet');

  // Starting from second 2, Wi-Fi suffers hard failure while USB is score < 50
  const sec2 = result.timeline.find((t) => t.second === 2);
  assert.ok(sec2);
  assert.equal(sec2.phase, 'NO_INTERNET');
  assert.equal(sec2.action, null);

  // Zero switches executed
  const switches = result.timeline.filter((t) => t.action);
  assert.equal(switches.length, 0);
});

test('SCENARIO_DEFS exports all 5 supported scenarios', () => {
  assert.deepEqual(Object.keys(SCENARIO_DEFS).sort(), [
    'degradation',
    'flapping',
    'hard_failure',
    'no_internet',
    'recovery_switch_back',
  ].sort());
});
