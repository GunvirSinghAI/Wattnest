import test from 'node:test';
import assert from 'node:assert/strict';
import { slots } from './data.js';
import { costs, loadAt, scenario, explain, check, devices, defaultConstraints, studyConstraints, deviation, peakLoad } from './engine.js';
import handler from './api/explain.js';

test('search methods agree on feasible minimum and cost', () => {
  const { bfs, dfs } = scenario();
  assert.deepEqual(bfs.plan, dfs.plan);
  assert.equal(bfs.explored, dfs.explored);
  assert.equal(bfs.cost, devices.reduce((sum,d) => sum + costs(d,bfs.plan[d.id]),0));
  for (let slot = 0; slot < slots; slot++) assert.ok(loadAt(bfs.plan,slot) <= 2400);
});

test('coordinator resolves conflicting proposals within the cap', () => {
  const { agents } = scenario();
  assert.equal(Object.keys(agents.plan).length, devices.length);
  assert.ok(agents.events.some(event => event.includes('Power cap exceeded')));
  for (let slot = 0; slot < slots; slot++) assert.ok(loadAt(agents.plan,slot) <= 2400);
});

test('impossible cap produces a clear explanation', () => {
  assert.equal(scenario(1500).bfs.plan,null);
  assert.match(explain(scenario(1500),1500),/No complete schedule/);
});

test('A* matches exhaustive search across dashboard caps', () => {
  for (const cap of [1500, 2000, 2400, 3500, 6000]) {
    const { astar, bfs, baseline } = scenario(cap);
    assert.equal(astar.cost, bfs.cost);
    if (!astar.plan) continue;
    for (const device of devices) {
      const other = { ...astar.plan };
      delete other[device.id];
      assert.equal(check(device, astar.plan[device.id], other, cap), null);
    }
    const energy = plan => Array.from({ length: slots }, (_, slot) => loadAt(plan, slot))
      .reduce((total, watts) => total + watts / 2000, 0);
    assert.ok(Math.abs(energy(astar.plan) - energy(baseline)) < 1e-9);
  }
});

test('API rejects invalid scenarios', async () => {
  const result = await handler({method:'POST',body:{cap:0,question:'Why?'}},{status: code => ({json: body => ({code,body})})});
  assert.equal(result.code,400);
});

test('forecast preference and tight deadline change planning decisions', () => {
  const base = scenario();
  assert.ok(peakLoad(base.astar.plan) < 1940);
  assert.ok(deviation(base.routine.plan.washer) < deviation(base.astar.plan.washer));
  const constraints = { ...studyConstraints, earliest: 32, deadline: 34 };
  const tight = scenario(2400, constraints);
  assert.equal(tight.astar.plan.washer, 32);
  assert.equal(Object.keys(tight.agents.plan).length, 4);
  assert.equal(Object.keys(tight.fewest.plan).length, 5);
  assert.equal(scenario(2400, { ...constraints, tolerance: 0 }).astar.plan, null);
});

