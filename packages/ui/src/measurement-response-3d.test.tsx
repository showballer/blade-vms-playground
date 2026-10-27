import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MeasurementResponse3D, interpolateResponseEnvelope, responseEnvelopeIntervals, type Response3DPoint } from "./measurement-response-3d";

const point = (id: string, radiusM: number | null, amplitude: number | null): Response3DPoint => ({
  id, name: id, radiusM, normalizedAmplitude: amplitude, displacementRmsM: amplitude == null ? null : amplitude * 1e-6,
});
const points = [point("P1", .16, .1), point("P2", .3, .3), point("P3", .44, null), point("P4", .58, .7), point("P5", .72, 1)];
const before = JSON.stringify(points);
assert.deepEqual(responseEnvelopeIntervals(points).map(p => [p.from.id, p.to.id]), [["P1", "P2"], ["P4", "P5"]]);
assert(Math.abs(interpolateResponseEnvelope(points, .23)! - .2) < 1e-12);
for (const radius of [0, .15, .31, .44, .57, .73, 1]) assert.equal(interpolateResponseEnvelope(points, radius), null, `No extrapolation/gap filling at ${radius}`);
assert.equal(interpolateResponseEnvelope([point("zero", .1, 0), point("one", .2, 1)], .1), 0);
assert.equal(interpolateResponseEnvelope([], .5), null);
assert.equal(interpolateResponseEnvelope(points, NaN), null);
assert.deepEqual(responseEnvelopeIntervals([...points, point("unknown", null, .5)]), []);
const duplicates = [point("P1", .1, .2), point("P2", .3, .4), point("P3", .3, .9), point("P4", .5, 1)];
assert.deepEqual(responseEnvelopeIntervals(duplicates), []);
assert.equal(interpolateResponseEnvelope(duplicates, .3), null);
assert.equal(JSON.stringify(points), before, "Rendering/interpolation must not change input data");
const html = renderToStaticMarkup(<MeasurementResponse3D points={points} bandHz={[80, 160]} />);
for (const text of ["三维幅值分布", "静态响应包络", "0 = 风机中心", "最远测点", "非叶尖", "缺测", "不补根部或叶尖", "80–160 Hz", 'data-response-interval="P1:P2"', 'data-response-interval="P4:P5"']) assert(html.includes(text), text);
for (const text of ["NaN", "Infinity", "播放动画", "实测振型动画", 'data-response-interval="P2:P4"', 'data-response-interval="P2:P3"']) assert(!html.includes(text), text);
assert.equal((html.match(/data-response-point=/g) || []).length, 5);
const missing = renderToStaticMarkup(<MeasurementResponse3D points={[point("P1", .1, null)]} />);
assert(missing.includes("缺少有效测点或位置"));assert(!missing.includes("data-response-interval"));
const unknown = renderToStaticMarkup(<MeasurementResponse3D points={[...points, point("P6", null, .6)]} />);
assert(unknown.includes("位置未知"));assert(!unknown.includes("data-response-interval"));
const zero = renderToStaticMarkup(<MeasurementResponse3D points={[point("P1", .1, 0), point("P2", .2, 0)]} />);
assert(zero.includes('data-response-interval="P1:P2"'));assert(!zero.includes("NaN"));
console.log("PASS response 3D: metre coordinates, missing/unknown/duplicate point isolation, no root/tip extrapolation, zero response, unchanged inputs, static SSR");
