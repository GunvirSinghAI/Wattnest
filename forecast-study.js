// iAWE channel 6. First sample of each session spanning at least 18 minutes
// with at least 800 readings, split at gaps greater than 15 minutes.
const starts = [
  1370827920, 1371172930, 1371442575, 1371776396, 1372050288,
  1372384120, 1372743123, 1373159820, 1373765088, 1374025298,
  1374369504, 1374717684, 1374974856, 1375237606
];
const minutesIST = epoch => ((epoch + 19800) % 86400) / 60;
const observed = starts.map(minutesIST);
const train = observed.slice(0, 9);
const test = observed.slice(9);
const mean = train.reduce((sum, value) => sum + value, 0) / train.length;
const mae = predictions => test.reduce((sum, value, i) => {
  const difference = Math.abs(value - predictions[i]);
  return sum + Math.min(difference, 1440 - difference);
}, 0) / test.length;
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export const forecastSlot = Math.round(median(observed) / 30);
export const forecastResults = [
  { method: 'Fixed training mean', minutesMAE: mae(test.map(() => mean)).toFixed(1) },
  { method: 'Previous observed start', minutesMAE: mae([train.at(-1), ...test.slice(0, -1)]).toFixed(1) }
];
const rolling = observed.slice(4).map((actual, index) => {
  const history = observed.slice(0, index + 4);
  const average = history.reduce((sum, value) => sum + value, 0) / history.length;
  const error = predicted => Math.min(Math.abs(actual - predicted), 1440 - Math.abs(actual - predicted));
  return [error(average), error(history.at(-1)), error(median(history))];
});
export const rollingResults = rolling[0].map((_, column) =>
  (rolling.reduce((sum, row) => sum + row[column], 0) / rolling.length).toFixed(1));
if (globalThis.process?.argv[1]?.endsWith('forecast-study.js')) {
  console.table(forecastResults);
  console.log('Rolling MAE over 10 sessions (minutes)', { expandingMean: rollingResults[0], previousStart: rollingResults[1], expandingMedian: rollingResults[2] });
}
