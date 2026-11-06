import assert from 'node:assert/strict';
import { increasingDisplacementDisplay } from './displacement-display-data';

const input = [1, 4, 2, 5, 8].map((actualMm, i) => Object.freeze({ point: `P${i + 1}`, radiusM: i + 1, actualMm }));
const result = increasingDisplacementDisplay(Object.freeze(input));
assert.deepEqual(result.map(p => p.actualMm), [1, 4, 2, 5, 8], 'actual values survive unchanged');
assert.deepEqual(result.map(p => p.radiusM), [1, 2, 3, 4, 5]);
assert(result.every((p, i) => !i || p.displayMm > result[i - 1].displayMm));
result.forEach((p, i) => assert(Math.abs(p.displayMm - [1, 2.92, 3.08, 5, 8][i]) < 1e-12, 'only the decreasing pair is pooled'));
assert.deepEqual(increasingDisplacementDisplay([]), []);
assert.equal(increasingDisplacementDisplay([{ point: 'P1', radiusM: null, actualMm: 2 }])[0].displayMm, 2);
assert.deepEqual(increasingDisplacementDisplay(input.map(p => ({ ...p, actualMm: 0 }))).map(p => p.displayMm), [0, 0, 0, 0, 0], 'zero response must not create vibration');
assert.equal(increasingDisplacementDisplay([NaN, Infinity, -1].map(actualMm => ({ point: 'bad', radiusM: null, actualMm }))).length, 0);

const reversed = Object.freeze([...input].reverse());
assert.deepEqual(increasingDisplacementDisplay(reversed), result, 'record order must not change the P1 to P5 trend');
assert.equal(reversed[0].point, 'P5', 'sorting must not mutate the input');
assert.deepEqual(increasingDisplacementDisplay(['P10', 'P2', 'P1'].map(point => ({point, radiusM: null, actualMm: 1}))).map(p => p.point), ['P1', 'P2', 'P10']);

// The six local blade results, converted to mm and rounded only in this fixture.
const blades = [
  [0.058804, 0.343391, 0.611161, 0.673956, 1.085174],
  [0.026241, 0.140356, 0.241023, 0.281106, 0.258008],
  [0.048072, 0.271281, 0.445193, 0.405553, 0.740785],
  [0.885900, 1.432351, 1.284785, 1.588045, 2.451437],
  [0.914225, 1.334045, 1.243718, 1.709971, 2.401474],
  [0.896056, 1.281705, 1.443721, 1.788679, 2.176828],
];
for (const actual of blades) {
  const points = actual.map((actualMm, i) => ({point: `P${i + 1}`, radiusM: 7.05 + i * 14.1, actualMm}));
  const display = increasingDisplacementDisplay(points);
  assert.deepEqual(display.map(p => p.actualMm), actual);
  assert(display.every((p, i) => !i || p.displayMm > display[i - 1].displayMm), 'each of the six blade display curves must increase');
  if (actual.every((v, i) => !i || v - actual[i - 1] > Math.max(...actual) * .02)) {
    display.forEach((p, i) => assert(Math.abs(p.displayMm - actual[i]) < 1e-12, 'already increasing results stay unchanged'));
  }
}
console.log('PASS independent displacement display, six blades, stable point order, unchanged measurements and empty/invalid input');
