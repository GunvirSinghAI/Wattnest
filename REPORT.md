# WattNest — CSE276 project report and viva walkthrough

WattNest plans appliance cycles for a simulated household. It compares preferred and optimized costs, shows the resulting load, and lets Jim explain decisions. No household sensors are required.

## Run it

Use Node.js 22 or newer. Open a terminal in this folder, run `npm run dev`, and open http://127.0.0.1:4173. There are no npm packages to install. Run `npm test` to check the scenario and explanation route.

To enable Jim's generative replies, create an API key at https://aistudio.google.com/api-keys. The template uses gemini-3.5-flash-lite. Copy .env.example to .env.local, fill in GEMINI_API_KEY and GEMINI_MODEL, then restart the dev server. Keep .env.local private. Opening Jim requests an explanation of the current schedule. Use Send for follow-up questions. Jim shows a rule trace when the model is unavailable.

For deployment, put this folder's contents in a GitHub repository and import it into Vercel using the Other preset. The repo root serves the website, and api/explain.js is the server function. Add GEMINI_API_KEY and GEMINI_MODEL in Vercel's project environment variables and redeploy. Model calls count toward your Gemini project quota. Consider rate limiting the route before sharing the demo widely.

## 1. Classical search · Units I and II

Read search() in engine.js. A state is a partial assignment of appliances to start slots. An action adds one appliance at a valid start slot. The goal is a complete schedule with the lowest electricity cost. Each half-hour adds watts ÷ 2,000 kWh multiplied by the slot tariff. BFS uses a queue, while DFS uses a stack. They exhaust the same feasible search tree and therefore visit the same count and find the same minimum. Runtime is an observed measurement that can vary between runs.

Try tracing the children of the empty state. Then compare the preferred cost and optimized cost. The preferred plan is a cost reference and can exceed the power cap.

## 2. Production rules · Unit II

Read check() in engine.js. Appliance profiles and deadlines in data.js are the facts. A start outside its allowed window triggers a rejection. A slot where the candidate's watts plus scheduled watts exceed the cap also triggers a rejection. Search prunes any rejected action. Jim uses the same rules to explain a counterfactual preferred start against the final schedule of the other devices.

Try lowering the cap to 1.5 kW. A dryer slot uses 1.9 kW on its own, so no complete schedule is possible.

## 3. Multi-agent simulation · Unit III

Read coordinate() in engine.js. Each appliance proposes its cheapest feasible-in-time slot. The coordinator prioritizes earlier deadlines and tries the appliance's remaining candidates when a request conflicts. This is a greedy simulation and may differ from the exhaustive optimum.

PEAS: performance is completed cycles and low tariff cost within the cap. The environment is the tariff day and household load. The actuator reserves a start slot. The sensed inputs are tariffs, the device window, and reservations available to the coordinator.

Open Agent negotiation. Find two agents that prefer overlapping low-price slots and explain why the coordinator rejected or accepted each request.

## 4. Statistical forecast and Jim · Units IV, V and VI

forecast() averages five historical start slots and rounds to the nearest slot. This simple statistical baseline estimates usual behavior. Search still decides which start minimizes simulated cost. Jim uses a foundation model to explain the result in plain language. The server recomputes the scenario from the selected cap and retrieves matching reference notes from data.js by keyword. It sends the question, verified trace and retrieved notes to Gemini. Compare a generic prompt with this grounded prompt using jim-study.js and count unsupported numbers or reasons.

Data provenance: iAWE (https://iawe.github.io/) supplies channel 6 for the washer. The inferred session spans Unix timestamps 1372384120 through 1372386455. It has 1,688 recorded seconds over a 38 min 56 sec interval. The program boundaries are inferred from a 15-minute gap rule. Summing recorded watts as one-second samples gives an estimated 0.107 kWh spread across two 30-minute reservations. Refrigerator (channel 3) and AC (channel 4) supply shiftable daily profiles for 28 June 2013 IST. All bins divide the observed watt-seconds by 1,800, leaving missing seconds as zero in the estimate. The logger reports appliances when on and gaps can also reflect incomplete monitoring. The dryer, dishwasher, forecast histories and tariff are synthetic. Dashboard cost totals, the power chart and the cap include the refrigerator and AC profiles. Jim uses household totals for plan comparisons. Guide notes are short reference summaries with linked sources.

## How the modules connect

data.js supplies the facts. engine.js checks rules and runs search, coordination and the forecast. app.js reads results and draws the dashboard. api/explain.js independently recomputes and explains the same scenario so the explanation uses the same inputs as the charts.

Start learning by changing the cap and predicting the result. Next change one tariff and explain how the optimum responds. Finally, trace one question through the browser, API route, retrieval and model call.

## A* and the comparison dashboard

The dashboard recommends the A* schedule. Its priority adds the cost already assigned to a lower bound for the remaining appliances. The lower bound sums the cheapest eligible start for each remaining appliance before overlap constraints are applied. Power and deadline rules still prune successors. Compare visited states and plan cost with BFS and DFS in the search table.

Channel 3 (refrigerator) and channel 4 (AC) contribute slot load during every candidate check and both comparison curves. Their cost is computed at each candidate timing and included in the dashboard totals. A plan shifts whole flexible cycles, so the cost can decrease while energy stays constant. Preferred starts are an unoptimized reference and can exceed the cap.

## Integrated demo

1. At 2.4 kW, compare preferred starts with the A* recommendation. In the search table, compare the optimum cost and states visited with BFS and DFS.
2. Read Rule checks to see whether a preferred start would pass given the other A* reservations. Read the agent log to see the order in which different reservations were made. The agent plan and A* plan can reach the same price while following different decision processes.
3. Open Ask Jim and ask why the plan changed. The server independently calculates the same scenario and supplies the verified schedule, rule checks, agent events and search counts to Gemini when configured.
4. Change the cap to 1.5 kW. The dryer exceeds this cap in every candidate start, so neither method produces a complete plan.
5. Explain how the historical-average forecast, symbolic planner, and foundation model serve different roles. In the Inference Playground, run the same question once alone and once with the displayed evidence. Score each response against the actual starts, constraints and cost.

The washer usual-start forecast uses the historical iAWE median. Dishwasher and dryer forecasts use synthetic histories. The measured data supplies power profiles for the washer, refrigerator and AC. The dashboard's household cost includes all five appliances; agent costs given to the model are household totals.

## Evaluation results

In the shift-enabled study at 2.4 kW, A*, BFS and DFS returned the same minimum cost. With peak tie-breaking, A* visits 1,269 states and BFS and DFS each visit 52,858. The simulated tariff yields a ₹20.97 cost reduction and 0 kWh energy reduction. Whole-cycle rescheduling changes the price applied to the energy.

The separate iAWE washer study uses 14 inferred sessions from one home. The first nine establish a fixed mean start time and the final five serve as a time-ordered test set. Run node forecast-study.js to reproduce the comparison. Mean absolute start-time error is 48.1 minutes for the fixed mean and 35.2 minutes for the previous observed start. The previous-start baseline uses only observations available before each prediction. These small-sample results concern the time of the next recorded session. The dashboard uses the iAWE median for the washer and simulated histories for the dishwasher and dryer.

Run node jim-study.js after setting GEMINI_API_KEY and GEMINI_MODEL. It sends eight matched questions with and without the planner evidence and prints both responses alongside the expected answers. Score each response for factual accuracy and unsupported claims.

The refrigerator and AC each choose among recorded timing and a shift of one half-hour earlier or later. The daily profiles wrap at midnight, preserving their energy and recorded load patterns. This is a simulation assumption about timing flexibility. The data does not model temperature or comfort. A*, BFS, DFS and coordination all use these same choices.


A live run with gemini-3.5-flash-lite answered all three questions correctly when supplied with planner evidence. With the generic prompts, the model requested more information for all three questions. That earlier run used the planner before peak tie-breaking. These results describe one run of three questions.

## Planning trade-offs

In the earlier shift-enabled trial, use the washer controls to change the earliest start, finish deadline, and maximum gap from the washer forecast. The AC and refrigerator controls allow or disable their simulated half-hour shifts. The server uses the same submitted settings when generating Jim’s explanations.

In the shift-enabled study at 2.4 kW, the cost-first plan starts the washer at 15:30, 450 minutes after the forecast, for ₹35.54 household cost. In that trial, the routine-first plan prioritizes the smallest washer timing gap and then cost and peak. It starts the washer at 08:30, 30 minutes after the forecast, for ₹35.91. The cost-first peak falls from approximately 2.25 kW in the earlier implementation to 1.94 kW at the same minimum cost. A* keeps exploring states whose lower bounds can match the best cost, then chooses the lowest peak from the equal-cost completed plans.

Use Try a tight deadline for the 16:00–17:00 washer window at 2.4 kW. Deadline-first reserves timings for four devices and leaves the refrigerator unplaced. Fewest-options-first rechecks how many feasible options remain for each unassigned device and schedules all five at ₹35.54. Both policies use the same cost ranking and rule checks as the planner.
## Expanded Gemini evaluation

In one six-question run with Gemini 3.5 Flash-Lite, the grounded responses correctly answered the washer timing and cost, infeasible cap, peak comparison, routine trade-off, and tight-deadline agent comparison. The model declined to answer the search counts despite receiving them, for 5/6 correct. Generic replies answered 0/6 correctly. Five requested more context and one supplied unsupported peak figures and attributed savings to a peak-demand charge. WattNest uses the modeled time-of-use tariff for this comparison. These scores describe a single run and may vary with model output.

## Baseline, power resolution, and forecast

The default scenario preserves recorded refrigerator and AC timing. The optional shifts are scenarios for experimentation. WattNest uses estimated half-hour average power. It does not infer refrigerator temperature, room comfort, or instantaneous peak from this data.

The feasible baseline processes appliances in deadline order and picks the closest timing to each preset preference that passes the same rules as A*. It reports no complete result when its greedy choices block an appliance. Savings against this baseline are shown only when it finishes every reservation. The preset reference remains useful for comparison and can violate edited constraints.

In the rolling forecast study, each of sessions 5 through 14 is predicted from earlier sessions only. Mean absolute time error is 63.5 minutes for the expanding median, 80.3 for the expanding mean and 110.3 for the previous start. The dashboard uses the median fitted to all 14 sessions as the next-start estimate. The preceding five-session comparison is a different evaluation period. Both use the same home, and these exploratory results do not establish cross-household accuracy. The recorded Gemini trial is a prompt-grounding study with a single model and six questions.
The three cycle appliances now have independent earliest-start and finish-by settings. The refrigerator and AC each allow separate earlier and later limits of 0 to 120 minutes in 30-minute steps. The optimizer tests every permitted offset within those bounds. Jim’s plan panel offers questions about the current recommendation, limiting rules, and the routine trade-off.
