import handler from './api/explain.js';
import { scenario, studyConstraints, deviation, peakLoad } from './engine.js';
import { appliances, time, money } from './data.js';
import { costs } from './engine.js';

try { process.loadEnvFile('.env.local'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const { GEMINI_MODEL, GEMINI_API_KEY } = process.env;
if (!GEMINI_API_KEY || !GEMINI_MODEL) {
  console.error('Set GEMINI_API_KEY and GEMINI_MODEL in .env.local to run the live comparison.');
  process.exit(1);
}

const base = scenario(2400, studyConstraints);
const tight = { ...studyConstraints, earliest: 32, deadline: 34 };
const fixed = { ...studyConstraints, fridgeMode: 'fixed', acMode: 'fixed' };
const fixedPlan = scenario(2400, fixed);
const questions = [
  [2400, 'When should the washer start and what does its cycle cost?', time(base.astar.plan.washer) + ' and ' + money(costs(appliances[0], base.astar.plan.washer))],
  [2400, 'How many states did A* and BFS visit?', base.astar.explored + ' and ' + base.bfs.explored],
  [1500, 'Is a complete schedule feasible under this power cap?', 'No complete schedule is feasible'],
  [2400, 'What is the cost-first plan’s peak load and how does it compare with the preferred plan?', Math.round(peakLoad(base.astar.plan)) + ' W versus ' + Math.round(peakLoad(base.baseline)) + ' W'],
  [2400, 'How much closer to the washer forecast is the routine-first plan and what does each plan cost?', (deviation(base.astar.plan.washer) - deviation(base.routine.plan.washer)) + ' minutes closer. Cost-first ' + money(base.astar.cost) + ', routine-first ' + money(base.routine.cost)],
  [2400, 'How many appliances did each agent policy schedule?', 'Deadline first 4/5. Fewest options first 5/5.', tight],
  [2400, 'What is the feasible baseline cost and how much does A* save against it?', money(fixedPlan.referenceCost) + ' and ' + money(fixedPlan.referenceCost - fixedPlan.astar.cost), fixed],
  [2400, 'What timing choices are allowed for the refrigerator and AC?', 'Both must keep recorded timing.', fixed]
];
for (const [cap, question, expected, constraints] of questions) {
  const grounded = await handler({ method: 'POST', body: { cap, question, constraints: constraints ?? studyConstraints } }, {
    status: code => ({ json: body => ({ code, ...body }) })
  });
  if (grounded.mode !== 'Gemini') {
    throw new Error('Jim fell back to the rule trace. Check model access and inference credits.');
  }
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: GEMINI_MODEL, max_tokens: 512, messages: [
      { role: 'system', content: 'You are Jim, an energy assistant. Answer briefly.' },
      { role: 'user', content: 'WattNest power cap is ' + cap + ' W. ' + question }
    ] }),
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error('Generic inference failed with HTTP ' + response.status);
  const generic = (await response.json()).choices?.[0]?.message?.content?.trim();
  if (!generic) throw new Error('Generic prompt returned an empty reply.');
  console.log(JSON.stringify({ model: GEMINI_MODEL, cap, constraints, question, expected, generic, grounded: grounded.answer }, null, 2));
}

