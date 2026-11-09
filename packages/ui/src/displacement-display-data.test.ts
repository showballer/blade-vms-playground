import assert from 'node:assert/strict';
import {increasingDisplacementDisplay} from './displacement-display-data';
const input=Object.freeze([1,4,2,5,8].map((actualMm,i)=>Object.freeze({point:`P${i+1}`,radiusM:10+i*15,actualMm})));
const copy=JSON.stringify(input),result=increasingDisplacementDisplay(input);
assert.equal(JSON.stringify(input),copy);
assert.deepEqual(result.map(p=>p.actualMm),[1,4,2,5,8]);
assert(result.every((p,i)=>!i||p.displayMm>result[i-1].displayMm));
// Fit recovers an exact shape without inventing an additional local degree of freedom.
const radius=[10,30,45,60,70],shape=radius.map(r=>{const u=r/70;return u*u*(3-u)/2;});
const exact=increasingDisplacementDisplay(shape.map((v,i)=>({point:`P${i+1}`,radiusM:radius[i],actualMm:v*2.5})));
exact.forEach((p,i)=>assert(Math.abs(p.displayMm-shape[i]*2.5)<1e-12));
assert.deepEqual(increasingDisplacementDisplay([...input].reverse()),result);
assert.deepEqual(increasingDisplacementDisplay([]),[]);
assert.deepEqual(increasingDisplacementDisplay([{point:'P1',radiusM:null,actualMm:1}]),[]);
assert.deepEqual(increasingDisplacementDisplay(input.map(p=>({...p,actualMm:0}))).map(p=>p.displayMm),[0,0,0,0,0]);
assert.deepEqual(increasingDisplacementDisplay(input.map(p=>({...p,radiusM:0}))),[]);
assert.equal(increasingDisplacementDisplay(input.map(p=>({...p,actualMm:NaN}))).length,0);
console.log('PASS model trend: constrained bending shape fit, radial sorting, measured values preserved, no missing-radius/zero-response fabrication');
