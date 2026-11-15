import { background, appliances, limit, slots, time, money } from './data.js';
import { scenario, costs, loadAt, forecast, explain, deviceLoad, choiceLabel, defaultConstraints, validConstraints, deviation, peakLoad, dailyTimingOptions } from './engine.js';
import { forecastSlot, forecastResults, rollingResults } from './forecast-study.js';

const byId = id => document.getElementById(id);
const capInput = byId('cap');
const dialog = byId('jim');
let cap = limit;
let result;
let selected = null;
let requestVersion = 0;
let constraints = defaultConstraints;
let previousResult;
const dailyTicks = '<div class="tick"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>';
const settings = document.createElement('form');
settings.className = 'panel search-panel planner-settings';
const shiftSelect = (id, direction) => `<label>Maximum shift ${direction.toLowerCase()}<select name="${id + direction}">
  <option value="0">None</option>
  ${[1, 2, 3, 4].map(value => `<option value="${value}">${value * 30} min</option>`).join('')}
</select></label>`;
const dailySettings = (id, title) => `<fieldset class="appliance-settings">
  <legend>${title}</legend>
  <div class="planner-fields">${shiftSelect(id, 'Earlier')}${shiftSelect(id, 'Later')}</div>
  <div id="${id}-timing-preview"></div>
</fieldset>`;
const otherCycles = appliances.filter(device => device.id !== 'washer');
settings.innerHTML = `<h3>Set your limits</h3>
  <fieldset class="appliance-settings">
    <legend>Preferred starts</legend>
    <p><small>Set the times you would normally choose. WattNest uses them to build the comparison baseline.</small></p>
    <div class="planner-fields">${appliances.map(device => `<label>${device.name}
      <input name="preferred-${device.id}" type="time" min="00:00" max="${time(slots - device.profile.length)}" step="1800" required value="${time(device.preferred)}">
    </label>`).join('')}</div>
  </fieldset>
  <fieldset class="appliance-settings">
  <legend>Washing machine</legend>
  <div class="planner-fields">
  <label>Earliest start <input name="earliest" type="time" required step="1800" value="${time(defaultConstraints.earliest)}"></label>
  <label>Finish by <input name="deadline" type="time" required step="1800" value="${time(defaultConstraints.deadline)}"></label>
  <label>Allowed gap from usual start <select name="tolerance">
    <option value="1440">Any time within the window</option>
    <option value="0">Usual start only</option>
    <option value="30">Within 30 minutes</option>
    <option value="60">Within 1 hour</option>
    <option value="120">Within 2 hours</option>
    <option value="480">Within 8 hours</option>
  </select></label></div>
  <div id="constraint-preview"></div>
  </fieldset>
  <div class="daily-settings-grid">
    ${otherCycles.map(device => `<fieldset class="appliance-settings">
      <legend>${device.name}</legend>
      <div class="planner-fields">
        <label>Earliest start <input name="${device.id}-earliest" type="time" required step="1800" value="${time(device.earliest)}"></label>
        <label>Finish by <input name="${device.id}-deadline" type="time" required step="1800" value="${time(device.deadline)}"></label>
      </div>
      <p><small>Full cycle takes ${device.profile.length * 30} minutes.</small></p>
      <p id="${device.id}-window-preview"></p>
    </fieldset>`).join('')}
  </div>
  <div class="group-divider" aria-hidden="true"></div>
  <div class="daily-settings-grid">
    ${dailySettings('fridge', 'Refrigerator')}
    ${dailySettings('ac', 'Air conditioner')}
  </div>

  <p><small>Shifts are a simulation of recorded loads. The cap checks half-hour averages and the planner has no temperature readings or appliance controls.</small></p>
  <button class="primary">Update plan</button> <button type="button" id="tight-case">Try a tight deadline</button>
  <p id="planning-status" aria-live="polite"></p>`;
byId('dashboard').before(settings);
function readConstraints() {
  const fields = new FormData(settings);
  const slot = name => {
    const [hours, minutes] = fields.get(name).split(':').map(Number);
    return hours * 2 + minutes / 30;
  };
  return { earliest: slot('earliest'), deadline: slot('deadline'),
    tolerance: Number(fields.get('tolerance')) / 30,
    shiftFridge: true, shiftAC: true,
    ...Object.fromEntries(['fridgeEarlier', 'fridgeLater', 'acEarlier', 'acLater'].map(key => [key, Number(fields.get(key))])),
    cycleWindows: Object.fromEntries(otherCycles.map(device => [device.id, {
      earliest: slot(device.id + '-earliest'), deadline: slot(device.id + '-deadline')
    }])),
    preferredStarts: Object.fromEntries(appliances.map(device => [device.id, slot('preferred-' + device.id)])) };
}

function previewConstraints() {
  const draft = readConstraints();
  const holder = byId('constraint-preview');
  for (const device of otherCycles) {
    const { earliest, deadline } = draft.cycleWindows[device.id];
    const last = deadline - device.profile.length;
    byId(device.id + '-window-preview').textContent = Number.isInteger(earliest) && Number.isInteger(last) && last >= earliest
      ? 'Eligible starts before power checks · ' + time(earliest) + '–' + time(last)
      : 'The full cycle cannot fit in this window.';
  }
  for (const device of background) {
    const options = dailyTimingOptions(device, draft).map(start =>
      '<li>' + choiceLabel(device, start) + ' · ' + money(costs(device, start)) + '</li>').join('');
    byId(device.id + '-timing-preview').innerHTML = '<p><small>Daily load options and estimated costs</small></p><ul>' + options + '</ul>';
  }
  if (!validConstraints(draft)) {
    holder.textContent = 'Use half-hour times and allow each cycle enough time to finish.';
    return;
  }
  const first = Math.max(draft.earliest, forecastSlot - draft.tolerance);
  const last = Math.min(draft.deadline - appliances[0].profile.length, forecastSlot + draft.tolerance);
  const count = Math.max(0, last - first + 1);
  const bar = (start, length) => `<span style="left:${start / slots * 100}%;width:${length / slots * 100}%"></span>`;
  const dots = Array.from({length: count}, (_, i) =>
    `<i style="left:${(first + i) / slots * 100}%"></i>`).join('');
  const pending = ['earliest', 'deadline', 'tolerance'].some(key => draft[key] !== constraints[key]) ||
    ['fridgeEarlier', 'fridgeLater', 'acEarlier', 'acLater'].some(key => draft[key] !== (constraints[key] ?? 0)) ||
    otherCycles.some(device => {
      const applied = constraints.cycleWindows?.[device.id] ?? device;
      const timing = draft.cycleWindows[device.id];
      return applied.earliest !== timing.earliest || applied.deadline !== timing.deadline;
    }) ||
    appliances.some(device => draft.preferredStarts[device.id] !== (constraints.preferredStarts?.[device.id] ?? device.preferred));
  holder.innerHTML = `<div class="constraint-heading"><strong>Washer timing preview</strong><small>${pending ? 'Unsaved changes' : 'Applied settings'}</small></div>
    <div class="cycle-row"><small>Allowed run window · ${time(draft.earliest)}–${time(draft.deadline)}</small><div class="cycle-track window-track" aria-hidden="true">${bar(draft.earliest, draft.deadline - draft.earliest)}</div></div>
    <div class="cycle-row"><small>Eligible starts before checking household power · ${count ? time(first) + '–' + time(last) + ' · ' + count + (count === 1 ? ' option' : ' options') : 'None'}</small><div class="cycle-track eligible-track" aria-hidden="true">${dots}</div></div>
    ${dailyTicks}
    <p><small>Usual washer start from iAWE ${time(forecastSlot)}</small></p>`;
}

settings.addEventListener('input', previewConstraints);
settings.addEventListener('submit', event => {
  event.preventDefault();
  const next = readConstraints();
  if (!validConstraints(next)) {
    byId('planning-status').textContent = 'Use half-hour times and allow each cycle enough time to finish.';
    return;
  }
  constraints = next;
  render();
  previewConstraints();
});
byId('tight-case').addEventListener('click', () => {
  settings.elements.earliest.value = '16:00';
  settings.elements.deadline.value = '17:00';
  settings.elements.tolerance.value = '1440';
  for (const key of ['fridgeEarlier', 'fridgeLater', 'acEarlier', 'acLater']) settings.elements[key].value = '1';
  for (const device of otherCycles) {
    settings.elements[device.id + '-earliest'].value = time(device.earliest);
    settings.elements[device.id + '-deadline'].value = time(device.deadline);
  }
  capInput.value = '2400';
  settings.requestSubmit();
});

function applianceTimeline(device, start, preferredStart) {
  const rows = [['Preferred', preferredStart, 'before'], ['A* plan', start, 'after']];
  return rows.map(([label, slot, color]) => {
    if (slot === undefined) return '<p>No feasible A* start</p>';
    const end = slot + device.profile.length;
    return `<div class="cycle-row ${color}"><small>${label} · ${time(slot)}–${time(end)} · ${money(costs(device, slot))}</small>
      <div class="cycle-track" aria-hidden="true"><span style="left:${slot / slots * 100}%;width:${device.profile.length / slots * 100}%"></span></div></div>`;
  }).join('') + dailyTicks;
}

function loadComparison(baseline, optimized, cap) {
  const max = Math.max(1, cap, ...baseline, ...(optimized ?? []));
  const y = watts => 110 - watts / max * 100;
  const line = (values, color) => '<polyline fill="none" stroke="' + color +
    '" stroke-width="2" vector-effect="non-scaling-stroke" points="' +
    values.map((value, i) => (i * 480 / (slots - 1)) + ',' + y(value)).join(' ') + '"/>';
  const grid = [0, .25, .5, .75, 1].map(fraction =>
    '<path d="M0 ' + y(max * fraction) + 'h480" stroke="var(--line)"/>').join('');
  return '<div class="plot"><div class="axis"><span>' + (max / 1000).toFixed(2) +
    ' kW</span><span>0 kW</span></div><div><svg class="comparison" viewBox="0 0 480 120" preserveAspectRatio="none" role="img" aria-label="Daily power comparison. Baseline peak ' + Math.round(Math.max(...baseline)) + ' watts' +
    (optimized ? ', optimized peak ' + Math.round(Math.max(...optimized)) + ' watts' : ', no feasible optimized plan') + '.">' +
    grid + (cap ? '<path d="M0 ' + y(cap) + 'h480" stroke="var(--muted)" stroke-dasharray="4 4"/>' : '') +
    line(baseline, 'var(--before)') + (optimized ? line(optimized, 'var(--after)') : '') +
    '</svg><div class="tick"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div></div></div>';
}

function render() {
  cap = Number(capInput.value);
  previousResult = result;
  result = scenario(cap, constraints);
  const { bfs, dfs, astar, routine, agents, fewest, fewestCost, baseline, baselineCost, reference, referenceCost, coordinatedCost, ruleTrace } = result;
  const plan = astar.plan;
  const prior = previousResult?.astar.plan;
  const changed = prior && plan ? [...appliances, ...background].filter(device => prior[device.id] !== plan[device.id]) : [];
  byId('planning-status').textContent = !plan ? explain(result, cap) :
    'All five appliances scheduled · ' + (cap / 1000).toFixed(1) + ' kW cap · ' + money(astar.cost) + ' household cost.';
  const changes = changed.map(device => device.name + ' ' + choiceLabel(device, prior[device.id]) + ' → ' + choiceLabel(device, plan[device.id]));
  const load = Array.from({length: slots}, (_, slot) => loadAt(plan ?? {}, slot));
  const preferredLoad = Array.from({length: slots}, (_, slot) => loadAt(referenceCost === null ? baseline : reference.plan, slot));
  const kwh = values => values.reduce((total, watts) => total + watts / 2000, 0);
  const baselineEnergy = kwh(preferredLoad);
  const fmtEnergy = value => value.toFixed(3) + ' kWh';
  const metric = (name, value) => '<div class="panel metric"><small>' + name + '</small><strong>' + value + '</strong></div>';
  const profile = device => {
    const start = plan?.[device.id];
    const cycleEnergy = kwh(device.profile);
    return `<article class="panel appliance-card">
      <h3>${device.name}</h3>
      <p><small>${device.measured ? 'iAWE · 39 min inferred cycle' : 'Simulated cycle'} · ${fmtEnergy(cycleEnergy)} per run</small></p>
      <div class="appliance-plot">${applianceTimeline(device, start, baseline[device.id])}</div>
      <p><small>Usual start estimate ${time(device.id === 'washer' ? forecastSlot : forecast(device))} · ${device.id === 'washer' ? 'median of 14 iAWE sessions' : 'simulated history'}</small></p>
      <button data-jim="${device.id}">✦ Explain with Jim</button>
    </article>`;
  };
  const dailyProfiles = background.map(device => `<article class="panel appliance-card">
    <h3>${device.name}</h3>
    <p><small>iAWE · adjustable daily profile · ${fmtEnergy(kwh(device.profile))} estimated</small></p>
    <div class="appliance-plot"><div class="legend"><span class="before">Recorded</span>${plan ? '<span class="after">A* · ' + choiceLabel(device, plan[device.id]) + '</span>' : ''}</div>${loadComparison(device.profile, plan ? device.profile.map((_, slot) => deviceLoad(device, plan[device.id], slot)) : null, 0)}</div>
    ${plan && plan[device.id] === 0 ? '<p><small>A* selected recorded timing. Both curves overlap.</small></p>' : ''}
    <p>${plan ? 'A* · ' + choiceLabel(device, plan[device.id]) + ' · ' + money(costs(device, 0)) + ' → ' + money(costs(device, plan[device.id])) : 'No feasible plan'}</p><p><small>28 June 2013 · ${(device.counts.reduce((a,b) => a+b,0)/864).toFixed(1)}% of seconds sampled</small></p>
    <button data-jim="${device.id}">✦ Explain with Jim</button>
  </article>`).join('');
  const methods = [['BFS', bfs, 'Level by level'], ['DFS', dfs, 'Branch first'], ['A*', astar, 'Cost + estimated remaining cost']];
  const mostStates = Math.max(1, ...methods.map(([, run]) => run.explored));
  const searchRows = methods.map(([name, run, note]) => `
    <tr class="${name === 'A*' ? 'chosen' : ''}">
      <th scope="row">${name}<small>${note}</small></th>
      <td><div class="search-bar" style="--progress:${run.explored / mostStates * 100}%"></div>${run.explored.toLocaleString()}</td>
      <td>${run.ms.toFixed(2)} ms</td>
      <td>${run.plan ? money(run.cost) : '—'}</td>
    </tr>`).join('');

  byId('dashboard').innerHTML = `
    <section class="panel search-panel plan-outcome" aria-labelledby="plan-outcome-title">
      <h3 id="plan-outcome-title">Household schedule</h3>
      ${plan ? `<div class="table-scroll"><table>
        <thead><tr><th>Appliance</th><th>Feasible baseline</th><th>A* recommendation</th><th>Estimated cost</th></tr></thead>
        <tbody>${[...appliances, ...background].map(device => {
          const timing = start => appliances.includes(device)
            ? time(start) + '–' + time(start + device.profile.length)
            : choiceLabel(device, start);
          return `<tr><th scope="row">${device.name}</th>
            <td>${referenceCost === null ? '—' : timing(reference.plan[device.id])}</td>
            <td class="after">${timing(plan[device.id])}</td>
            <td>${money(costs(device, plan[device.id]))}</td></tr>`;
        }).join('')}</tbody>
      </table></div>` : '<p>' + explain(result, cap) + '</p>'}
      ${previousResult ? '<p><strong>Since the last plan</strong> · ' + (prior && plan
        ? (changes.length ? changes.join(' · ') + '. ' : 'Appliance timings stayed the same. ') +
          'Cost ' + money(previousResult.astar.cost) + ' → ' + money(astar.cost) +
          ' · peak ' + Math.round(peakLoad(prior)) + ' → ' + Math.round(peakLoad(plan)) + ' W.'
        : plan ? 'A complete schedule is now feasible.' : prior ? 'The new limits block the previous schedule.' : 'A complete plan is still infeasible.') + '</p>' : ''}
    </section>
    <section class="panel jim-feature" aria-labelledby="jim-feature-title">
      <div>
        <h3 id="jim-feature-title">✦ Jim · Plan assistant</h3>
        <p>${plan ? 'Explore why appliances moved and what your limits changed.' : 'Find out which limit blocks a complete schedule.'}</p>
      </div>
      <div class="jim-prompts">
        <button class="primary" data-jim data-question="${plan ? 'Summarize the schedule, its cost, and how it compares with the feasible baseline.' : 'Why is the current schedule infeasible? Which limit is blocking it?'}">${plan ? 'Explain this plan' : 'Explain the blocker'}</button>
        <button data-jim data-question="How did the power cap and appliance time windows affect the result?">Walk me through the limits</button>
        <button data-jim data-question="What is the trade-off between the cost-first and routine-first plans?">Compare the two plans</button>
      </div>
    </section>
    <div class="metrics">
      ${metric('Feasible baseline cost', referenceCost === null ? 'No complete plan' : money(referenceCost))}
      ${metric('Planned cost', plan ? money(astar.cost) : 'No feasible plan')}
      ${metric('Saved vs. feasible baseline', plan && referenceCost !== null ? money(referenceCost - astar.cost) : '—')}
    </div>
    <div class="panel comparison-panel">
      <h3>Household demand by time of day</h3>
      <p>${plan ? 'Both schedules use ' + fmtEnergy(baselineEnergy) + '. Moving the appliance timings changes when you pay for that energy.' : 'Showing preferred demand while no complete plan is feasible.'}</p>
      <div class="legend"><span class="before">${referenceCost === null ? 'Preset reference · feasibility unchecked' : 'Feasible baseline'}</span>${plan ? '<span class="after">A* schedule</span>' : ''}<span class="cap-line">${cap.toLocaleString()} W cap</span></div>
      <p><small>The baseline reserves the closest available timing to each preference, checking the same rules in deadline order. Your preferred timing alone costs ${money(baselineCost)}.</small></p>
      ${loadComparison(preferredLoad, plan ? load : null, cap)}
      <p>Baseline peak ${Math.round(Math.max(...preferredLoad)).toLocaleString()} W${plan ? ' · A* peak ' + Math.round(Math.max(...load)).toLocaleString() + ' W' : ''}. Refrigerator and AC follow the timing limits selected above.</p>
    </div>
    <h3 class="group-title">Measured iAWE profiles</h3>
    <div class="grid">${appliances.filter(device => device.measured).map(profile).join('')}${dailyProfiles}</div>
    <div class="group-divider"></div>
    <h3 class="group-title">Simulated profiles</h3>
    <div class="grid">${appliances.filter(device => !device.measured).map(profile).join('')}</div>
    <details class="panel search-panel">
      <summary>How the planner searches</summary>
      <p>A* uses the cheapest eligible individual starts to bound remaining cost. Among equal-cost plans it picks the lowest peak demand.</p>
      <div class="table-scroll"><table><thead><tr><th>Method</th><th>States visited</th><th>Runtime</th><th>Plan cost</th></tr></thead><tbody>${searchRows}</tbody></table></div>
    </details>
    <section class="panel" aria-labelledby="ai-comparison">
      <summary>AI methods compared · Washer case study</summary>
      <div class="table-scroll"><table>
        <thead><tr><th>Method</th><th>Question</th><th>Result</th></tr></thead>
        <tbody>
          <tr><th scope="row">Washer forecast from iAWE</th><td>When does the washer usually start?</td>
            <td>About ${time(forecastSlot)} from 14 recorded sessions. On 10 rolling tests, the median averaged ${rollingResults[2]} min of error. The expanding mean averaged ${rollingResults[0]} min of error and previous start averaged ${rollingResults[1]} min. On the final five, the fixed mean scored ${forecastResults[0].minutesMAE} min and previous start scored ${forecastResults[1].minutesMAE} min.</td></tr>
          <tr><th scope="row">Symbolic rules and A*</th><td>When should the washer run?</td>
            <td>${plan ? time(plan.washer) + ' · ' + deviation(plan.washer) + ' min from forecast · household ' + money(astar.cost) + ' · peak ' + Math.round(peakLoad(plan)) + ' W.' : explain(result, cap)}</td></tr>
          <tr><th scope="row">Routine-first plan</th><td>What if staying close to the forecast matters most?</td>
            <td>${routine.plan ? time(routine.plan.washer) + ' · ' + deviation(routine.plan.washer) + ' min from forecast · household ' + money(routine.cost) + ' · peak ' + Math.round(peakLoad(routine.plan)) + ' W.' : 'No feasible alternative.'}</td></tr>
          <tr><th scope="row">Gemini · Jim</th><td>Why did the planner choose that result?</td>
            <td><button data-jim="washer">Ask Jim about the washer</button></td></tr>
        </tbody>
      </table></div>
      <p><small>The historical median sets the reference for your timing limit and the routine-first plan. The forecast study uses one home. Tariffs and scheduling constraints are simulated.</small></p>
      <p><small>In an earlier six-question trial, Gemini answered five correctly with planner evidence. Generic replies answered none correctly and invented peak figures once.</small> <a href="/REPORT.md">See evaluation</a></p>
    </details>
    <div class="details">
      <details class="panel"><summary>Rule checks</summary><p>Each candidate is checked against its time window and the combined load in each slot.</p>
        ${ruleTrace.length ? '<ul>' + ruleTrace.map(item => '<li>' + item.device + ': preferred ' + item.preferred + ' → scheduled ' + item.scheduled + '. ' + (item.rejection ?? 'Preferred start passes the rules with the other A* reservations.') + '</li>').join('') + '</ul>' : '<p>' + explain(result, cap) + '</p>'}
      </details>
      <details class="panel"><summary>Appliance agents and coordination</summary>
        <p>Deadline first · ${Object.keys(agents.plan).length}/5 scheduled · ${coordinatedCost === null ? 'Partial plan' : money(coordinatedCost)} · ${agents.events.filter(event => event.includes('Power cap exceeded')).length} power rejections</p>
        <p>Fewest feasible options first · ${Object.keys(fewest.plan).length}/5 scheduled · ${fewestCost === null ? 'Partial plan' : money(fewestCost)} · ${fewest.events.filter(event => event.includes('Power cap exceeded')).length} power rejections</p>
        <h4>Deadline-first decisions</h4>
        <ol>${agents.events.map(event => '<li>' + event + '</li>').join('')}</ol>
        <details><summary>Fewest-options-first decisions</summary><ol>${fewest.events.map(event => '<li>' + event + '</li>').join('')}</ol></details>
      </details>
    </div>`;
}

function openJim(id, question = 'Why was this schedule chosen?') {
  requestVersion++;
  selected = id || null;
  byId('scope').textContent = [...appliances, ...background].find(device => device.id === selected)?.name ?? 'Whole home';
  byId('answer').textContent = explain(result, cap, selected);
  byId('question').value = question;
  if (!dialog.open) dialog.showModal();
  byId('ask').requestSubmit();
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-jim]');
  if (button) openJim(button.dataset.jim, button.dataset.question);
});
capInput.addEventListener('change', render);
byId('ask').addEventListener('submit', async event => {
  event.preventDefault();
  const current = ++requestVersion;
  const answer = byId('answer');
  answer.textContent = 'Jim is checking the schedule…';
  try {
    const response = await fetch('/api/explain', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ cap, constraints, id:selected, question:byId('question').value })});
    if (!response.ok) throw new Error('Explanation request failed');
    const data = await response.json();
    if (current !== requestVersion) return;
    answer.textContent = data.mode + '\n' + data.answer;
    for (const [index, entry] of data.references.entries()) {
      const link = document.createElement('a');
      link.href = entry.url;
      link.textContent = 'Reference ' + (index + 1);
      answer.append(document.createElement('br'),link);
    }
  } catch {
    if (current === requestVersion) answer.textContent = explain(result,cap,selected);
  }
});
const theme = byId('theme');
function setTheme(day) {
  document.documentElement.classList.toggle('day', day);
  theme.textContent = day ? '☾' : '☼';
  theme.title = day ? 'Switch to night mode' : 'Switch to day mode';
  theme.setAttribute('aria-label', theme.title);
}
setTheme(localStorage.getItem('wattnest-theme') === 'day');
theme.addEventListener('click', () => {
  const day = !document.documentElement.classList.contains('day');
  setTheme(day);
  localStorage.setItem('wattnest-theme', day ? 'day' : 'night');
});
render();
previewConstraints();


