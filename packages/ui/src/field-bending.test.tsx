import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldBending, BladeBendingView, interpolateResponse, type BendingMatch } from "./field-bending";

const data: BendingMatch = {
  model: "uniform-cantilever-euler-bernoulli", status: "candidate", message: "候选，不代表模态确认",
  candidateMode: 1, macGap: .4, frequencyHz: 20, displacementUnit: "m", maxDisplacementAmplitude: .0001,
  referencePointIndex: 2, positions: [.2, .5, .8], measuredReal: [.1, .4, 1], measuredImag: [0, .2, 0],
  displacementAmplitudes: [.00001, .00004, .0001], curvePositions: [0, .2, .5, .8, 1], warnings: ["不包含扭转"],
  candidates: [1, 2, 3, 4].map(mode => ({ mode, beta: 1.875, mac: mode === 1 ? .99 : .5,
    normalizedMse: .01, theoryAtPoints: [.1, .4, .8], theoryCurve: [0, .1, .4, .8, 1],
    fittedReal: [.1, .4, .8], fittedImag: [0, 0, 0], fittedCurveReal: [0, .1, .4, .8, 1], fittedCurveImag: [0, 0, 0, 0, 0] })),
};
const points = [{ x: .2, real: 1, imag: 0 }, { x: .8, real: -1, imag: 2 }];
assert.equal(interpolateResponse(points, .1), null);
assert.equal(interpolateResponse(points, .9), null);
assert.equal(interpolateResponse([], .5), null);
const middle = interpolateResponse(points, .5)!;
assert.ok(Math.abs(middle.real) < 1e-10 && Math.abs(middle.imag - 1) < 1e-10);
const html = renderToStaticMarkup(<FieldBending data={data} />);
for (const text of ["MAC 相似度", "归一化复数 MSE", "播放动画", "查看第 4 阶", "不是物理放大倍数", "不是模态确认", "测点响应三维变形示意"]) assert.ok(html.includes(text), text);
assert.ok(!html.includes("NaN") && !html.includes("Infinity"));
const insufficient = renderToStaticMarkup(<BladeBendingView data={{ ...data, status: "insufficient-data" }} candidate={data.candidates[0]} />);
assert.ok(insufficient.includes("理论模型预览 · 非实测"));
assert.ok(insufficient.includes('value="measured" disabled=""'));
const legacy = renderToStaticMarkup(<FieldBending />);
assert.ok(legacy.includes("请更新 Python 采集服务"));
console.log("PASS bending interpolation, four candidates, animation labeling, insufficient data and legacy service fallback");
