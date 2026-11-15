import { explain, scenario, defaultConstraints, validConstraints, deviation, peakLoad, dailyTimingOptions, choiceLabel } from '../engine.js';
import { guides, appliances, background, time } from '../data.js';
import { forecastSlot } from '../forecast-study.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  const { cap, id, question, constraints = defaultConstraints } = req.body ?? {};
  if (!Number.isInteger(cap) || cap < 1000 || cap > 6000 ||
      (id && ![...appliances, ...background].some(device => device.id === id)) ||
      !validConstraints(constraints) || typeof question !== 'string' || question.length > 300) {
    return res.status(400).json({ error: 'Invalid scenario or question.' });
  }
  const result = scenario(cap, constraints);
  const trace = explain(result, cap, id);
  const summarize = run => run.plan ? {
    washerStart: time(run.plan.washer), minutesFromForecast: deviation(run.plan.washer),
    householdCost: run.cost.toFixed(2), peakWatts: Math.round(peakLoad(run.plan))
  } : null;
  const routineImprovement = result.astar.plan && result.routine.plan
    ? deviation(result.astar.plan.washer) - deviation(result.routine.plan.washer) : null;
  const evidence = {
    trace,
    scope: id ?? 'whole home',
    powerCapWatts: cap,
    washerWindow: [time(constraints.earliest), time(constraints.deadline)],
    otherCycleWindows: Object.fromEntries(appliances.slice(1).map(device => {
      const { earliest, deadline } = constraints.cycleWindows?.[device.id] ?? device;
      return [device.name, { earliest: time(earliest), finishBy: time(deadline) }];
    })),
    maximumShiftMinutes: constraints.tolerance * 30,
    allowedDailyTimings: Object.fromEntries(background.map(device => [device.name,
      dailyTimingOptions(device, constraints).map(start => choiceLabel(device, start))])),
    iAWEWasherForecast: time(forecastSlot),
    preferredPeakWatts: Math.round(peakLoad(result.baseline)),
    feasibleBaseline: result.referenceCost === null ? null : {
      householdCost: result.referenceCost.toFixed(2),
      peakWatts: Math.round(peakLoad(result.reference.plan)),
      savingsWithAStar: result.astar.plan ? (result.referenceCost - result.astar.cost).toFixed(2) : null
    },
    costFirstPlan: summarize(result.astar),
    routineFirstPlan: summarize(result.routine),
    routineFirstMinutesCloserToForecast: routineImprovement,
    agentPolicyComparison: 'Deadline first scheduled ' + Object.keys(result.agents.plan).length +
      ' of 5 appliances. Fewest feasible options first scheduled ' + Object.keys(result.fewest.plan).length + ' of 5 appliances.',
    deadlineFirstScheduled: Object.keys(result.agents.plan).length,
    fewestOptionsFirstScheduled: Object.keys(result.fewest.plan).length,
    fewestOptionsFirstCost: result.fewestCost,
    preferredHouseholdCost: result.baselineCost,
    optimizedHouseholdCost: result.astar.cost,
    coordinatedHouseholdCost: result.coordinatedCost,
    ruleChecks: result.ruleTrace,
    agentEvents: result.agents.events,
    statesVisited: { BFS: result.bfs.explored, DFS: result.dfs.explored, 'A*': result.astar.explored }
  };
  const references = guides.filter(entry => entry.tags.test(question));
  const fallback = id || !result.astar.plan ? trace : trace +
    ' A* visited ' + result.astar.explored + ' states. BFS visited ' + result.bfs.explored +
    ' and DFS visited ' + result.dfs.explored + '.' +
    (result.coordinatedCost === null ? ' The agents did not schedule all flexible appliances.' :
      ' The agents scheduled every appliance at a cost of ₹' + result.coordinatedCost.toFixed(2) + '.');
  if (!process.env.GEMINI_API_KEY || !process.env.GEMINI_MODEL) return res.status(200).json({ answer: fallback, mode: 'Rule trace', references });
  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.GEMINI_MODEL,
        max_tokens: 512,
        messages: [
          { role: 'system', content: 'You are Jim, WattNest’s energy assistant. Answer briefly using only the verified schedule and reference notes. Preserve all numbers. Say when the data cannot answer the question.' },
          { role: 'user', content: JSON.stringify({ question, evidence, references: references.map(entry => entry.text) }) }
        ]
      }),
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) throw new Error('Inference request failed');
    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content?.trim();
    if (!answer) throw new Error('Empty response');
    return res.status(200).json({ answer, mode: 'Gemini', references });
  } catch {
    return res.status(200).json({ answer: fallback, mode: 'Rule trace · model unavailable', references });
  }
}
