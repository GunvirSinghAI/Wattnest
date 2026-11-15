import { background, appliances, limit, slots, tariff, time, money } from './data.js';
import { forecastSlot } from './forecast-study.js';

export const devices = [...appliances, ...background];
const isDaily = device => device.counts !== undefined;
const preferred = (device, constraints) => constraints.preferredStarts?.[device.id] ?? device.preferred ?? 0;
const washer = devices[0];
export const defaultConstraints = {
  earliest: washer.earliest, deadline: washer.deadline, tolerance: slots,
  shiftFridge: true, shiftAC: true, fridgeMode: 'fixed', acMode: 'fixed'
};
export const studyConstraints = { ...defaultConstraints, fridgeMode: 'either', acMode: 'either' };

const shiftModes = ['fixed', 'earlier', 'later', 'either'];
const validShift = value => Number.isInteger(value) && value >= 0 && value <= 4;
const windowFor = (device, constraints) => device.id === 'washer'
  ? constraints : constraints.cycleWindows?.[device.id] ?? device;

export function validConstraints(input) {
  return input && Number.isInteger(input.earliest) && input.earliest >= 0 &&
    Number.isInteger(input.deadline) && input.deadline <= slots &&
    input.deadline - input.earliest >= washer.profile.length &&
    Number.isInteger(input.tolerance) && input.tolerance >= 0 && input.tolerance <= slots &&
    typeof input.shiftFridge === 'boolean' && typeof input.shiftAC === 'boolean' &&
    ['fridgeEarlier', 'fridgeLater', 'acEarlier', 'acLater'].every(key =>
      input[key] === undefined || validShift(input[key])) &&
    (input.cycleWindows === undefined || (input.cycleWindows &&
      appliances.slice(1).every(device => {
        const { earliest, deadline } = windowFor(device, input);
        return Number.isInteger(earliest) && Number.isInteger(deadline) &&
          earliest >= 0 && deadline <= slots && deadline - earliest >= device.profile.length;
      }))) &&
    (input.fridgeMode === undefined || shiftModes.includes(input.fridgeMode)) &&
    (input.acMode === undefined || shiftModes.includes(input.acMode)) &&
    (input.preferredStarts === undefined || (input.preferredStarts &&
      typeof input.preferredStarts === 'object' && !Array.isArray(input.preferredStarts) &&
      Object.entries(input.preferredStarts).every(([id, start]) => appliances.some(device =>
        device.id === id && Number.isInteger(start) && start >= 0 && start + device.profile.length <= slots))));
}

export const deviation = start => Math.abs(start - forecastSlot) * 30;

export function dailyTimingOptions(device, constraints) {
  const fridge = device.id === 'fridge';
  const enabled = fridge ? constraints.shiftFridge : constraints.shiftAC;
  const mode = fridge ? constraints.fridgeMode : constraints.acMode;
  const earlier = constraints[device.id + 'Earlier'];
  const later = constraints[device.id + 'Later'];
  if (enabled && (earlier !== undefined || later !== undefined)) {
    return Array.from({ length: (earlier ?? 0) + (later ?? 0) + 1 }, (_, i) => i - (earlier ?? 0));
  }
  if (!enabled || mode === 'fixed') return [0];
  if (mode === 'earlier') return [0, -1];
  if (mode === 'later') return [0, 1];
  return [0, 1, -1];
}

function startsFor(device, constraints) {
  if (isDaily(device)) return dailyTimingOptions(device, constraints);
  if (device.id === 'washer') {
    return Array.from({ length: constraints.deadline - constraints.earliest - device.profile.length + 1 },
      (_, offset) => constraints.earliest + offset).filter(start => deviation(start) <= constraints.tolerance * 30);
  }
  const { earliest, deadline } = windowFor(device, constraints);
  return Array.from({ length: deadline - earliest - device.profile.length + 1 },
    (_, offset) => earliest + offset);
}

export function choiceLabel(device, start) {
  if (!isDaily(device)) return time(start);
  if (start === 0) return 'recorded timing';
  return Math.abs(start) * 30 + (start < 0 ? ' min earlier' : ' min later');
}

export function deviceLoad(device, start, slot) {
  if (start === undefined) return 0;
  const offset = isDaily(device) ? (slot - start + slots) % slots : slot - start;
  return device.profile[offset] ?? 0;
}

export function costs(device, start) {
  return device.profile.reduce((total, watts, offset) => total + watts / 2000 * tariff((start + offset + slots) % slots), 0);
}

export function loadAt(plan, slot) {
  return devices.reduce((total, device) => total + deviceLoad(device, plan[device.id], slot), 0);
}

export const peakLoad = plan => Math.max(...Array.from({ length: slots }, (_, slot) => loadAt(plan, slot)));

export function check(device, start, plan, cap = limit, constraints = defaultConstraints) {
  const daily = isDaily(device);
  const { earliest, deadline } = windowFor(device, constraints);
  if (!Number.isInteger(start) || (daily ? !startsFor(device, constraints).includes(start) :
    start < earliest || start + device.profile.length > deadline)) return 'Outside allowed window';
  if (device.id === 'washer' && deviation(start) > constraints.tolerance * 30) return 'Beyond the allowed deviation from the forecast';
  const first = daily ? 0 : start;
  for (let slot = first; slot < first + device.profile.length; slot++) {
    const combined = deviceLoad(device, start, slot) + loadAt(plan, slot);
    if (combined > cap) return 'Power cap exceeded at ' + time(slot) + ' (' + combined.toFixed(2) + ' W > ' + cap + ' W)';
  }
  return null;
}

export function search(method, cap = limit, constraints = defaultConstraints, routineFirst = false) {
  const began = performance.now();
  const options = devices.map(device => startsFor(device, constraints)
    .filter(start => !check(device, start, {}, cap, constraints))
    .map(start => {
      const first = isDaily(device) ? 0 : start;
      const watts = device.profile.map((_, offset) => deviceLoad(device, start, first + offset));
      return { start, first, watts, cost: costs(device, start) };
    }));
  if (options.some(choices => !choices.length)) return { plan: null, cost: null, explored: 0, ms: performance.now() - began };
  const remainingCost = [0];
  for (let index = devices.length - 1; index >= 0; index--) {
    const prices = options[index].map(option => option.cost);
    remainingCost.unshift(remainingCost[0] + Math.min(...prices));
  }
  const priority = state => state.cost + remainingCost[state.depth];
  const distance = state => routineFirst && state.depth ? deviation(state.plan.washer) : 0;
  const better = (state, best) => distance(state) < distance(best) ||
    (distance(state) === distance(best) && state.cost < best.cost);
  const frontier = [{ plan: {}, cost: 0, depth: 0 }];
  let cursor = 0;
  let explored = 0;
  let best = null;
  while (cursor < frontier.length) {
    if (method === 'A*') frontier.sort((a, b) => distance(b) - distance(a) || priority(b) - priority(a) || a.depth - b.depth);
    const state = method === 'BFS' ? frontier[cursor++] : frontier.pop();
    if (method === 'A*' && best && (distance(state) > distance(best) ||
      (distance(state) === distance(best) && priority(state) > best.cost + 1e-8))) break;
    explored++;
    const device = devices[state.depth];
    if (!device) {
      if (best && distance(state) === distance(best) && Math.abs(state.cost - best.cost) <= 1e-8) {
        const peak = peakLoad(state.plan);
        const bestPeak = peakLoad(best.plan);
        if (peak < bestPeak ||
          (peak === bestPeak && JSON.stringify(state.plan) < JSON.stringify(best.plan))) best = state;
      } else if (!best || better(state, best)) best = state;
      continue;
    }
    const load = Array.from({ length: slots }, (_, slot) => loadAt(state.plan, slot));
    for (const option of options[state.depth]) {
      if (option.watts.some((watts, offset) => watts + load[option.first + offset] > cap)) continue;
      frontier.push({ plan: { ...state.plan, [device.id]: option.start }, cost: state.cost + option.cost, depth: state.depth + 1 });
    }
  }
  return { plan: best?.plan ?? null, cost: best?.cost ?? null, explored, ms: performance.now() - began };
}

export function coordinate(cap = limit, constraints = defaultConstraints, policy = 'deadline') {
  const plan = {};
  const events = [];
  const proposals = devices.map(device => {
    const starts = startsFor(device, constraints);
    starts.sort((a,b) => policy === 'preferred'
      ? Math.abs(a - preferred(device, constraints)) - Math.abs(b - preferred(device, constraints)) || a - b
      : costs(device,a) - costs(device,b) || a - b);
    return { device, starts };
  });
  const deadline = ({device}) => windowFor(device, constraints).deadline ?? slots;
  proposals.sort((a,b) => deadline(a) - deadline(b));
  while (proposals.length) {
    if (policy === 'fewest') {
      const counts = new Map(proposals.map(proposal => [proposal, proposal.starts.filter(start =>
        !check(proposal.device, start, plan, cap, constraints)).length]));
      proposals.sort((a,b) => counts.get(a) - counts.get(b) || deadline(a) - deadline(b));
    }
    const {device, starts} = proposals.shift();
    if (!starts.length) {
      events.push(device.name + ' has no timing option within the requested limits.');
      continue;
    }
    events.push(device.name + ' requests ' + choiceLabel(device, starts[0]) +
      (policy === 'preferred' ? ' as its closest allowed timing.' : ' as its cheapest option.'));
    const start = starts.find(candidate => {
      const reason = check(device, candidate, plan, cap, constraints);
      if (reason) events.push(device.name + ' · ' + choiceLabel(device, candidate) + ' · ' + reason);
      return !reason;
    });
    if (start !== undefined) plan[device.id] = start;
    events.push(device.name + (start === undefined ? ' could not be scheduled.' : ' accepted at ' + choiceLabel(device, start) + '.'));
  }
  return { plan, events };
}

export function forecast(device) {
  const mean = device.history.reduce((sum, slot) => sum + slot, 0) / device.history.length;
  return Math.round(mean);
}

export function scenario(cap = limit, constraints = defaultConstraints) {
  const bfs = search('BFS', cap, constraints);
  const dfs = search('DFS', cap, constraints);
  const astar = search('A*', cap, constraints);
  const routine = search('A*', cap, constraints, true);
  const agents = coordinate(cap, constraints);
  const fewest = coordinate(cap, constraints, 'fewest');
  const reference = coordinate(cap, constraints, 'preferred');
  const baseline = Object.fromEntries(devices.map(device => [device.id, preferred(device, constraints)]));
  const baselineCost = devices.reduce((sum, device) => sum + costs(device, baseline[device.id]),0);
  const completeCost = ({plan}) => devices.every(device => device.id in plan)
    ? devices.reduce((sum, device) => sum + costs(device, plan[device.id]), 0)
    : null;
  const ruleTrace = astar.plan ? devices.map(device => {
    const other = { ...astar.plan };
    delete other[device.id];
    return {
      device: device.name,
      preferred: choiceLabel(device, baseline[device.id]),
      scheduled: choiceLabel(device, astar.plan[device.id]),
      rejection: check(device, baseline[device.id], other, cap, constraints)
    };
  }) : [];
  return { bfs, dfs, astar, routine, agents, fewest, baseline, baselineCost,
    reference, referenceCost: completeCost(reference),
    coordinatedCost: completeCost(agents), fewestCost: completeCost(fewest), ruleTrace, constraints };
}

export function explain(result, cap, id) {
  if (!result.astar.plan) {
    const constraints = result.constraints;
    const blocked = devices.find(device => !startsFor(device, constraints)
      .some(start => !check(device, start, {}, cap, constraints)));
    const reason = blocked ? ' ' + blocked.name + ' has no individually feasible timing option.' :
      ' Every combination conflicts with the household power cap.';
    return 'No complete schedule meets the ' + cap + ' W cap and requested timing limits.' + reason;
  }
  const plan = result.astar.plan;
  const selected = id ? devices.filter(device => device.id === id) : devices;
  const peak = Math.max(...Array.from({ length: slots },(_,slot) => loadAt(plan,slot)));
  return selected.map(device => {
    const start = plan[device.id];
    if (isDaily(device)) return device.name + ' uses ' + choiceLabel(device, start) + ' and costs ' + money(costs(device, start)) + '.';
    const other = { ...plan };
    delete other[device.id];
    const preferredStart = result.baseline[device.id];
    const reason = check(device, preferredStart, other, cap, result.constraints);
    const change = start === preferredStart ? 'keeps its preferred start' : reason ? 'moves because the preferred start would fail: ' + reason.toLowerCase() : costs(device,start) < costs(device,preferredStart) ? 'moves to a cheaper start' : 'moves to fit the lowest-cost complete schedule';
    return device.name + ' starts at ' + time(start) + ' and ' + change + '. Its cycle costs ' + money(costs(device,start)) + '.';
  }).join(' ') + ' The complete plan peaks at ' + peak + ' W under the ' + cap + ' W cap.';
}
