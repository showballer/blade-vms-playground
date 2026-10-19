import assert from "node:assert/strict";
import { bladeCaptureSelection, hasBladePassMetadata, prepareBladeCaptures } from "../packages/ui/src/web-blade-capture-selection";
import type { CaptureSummary } from "../packages/ui/src/capture-types";
const capture = (id: string, changes: Record<string, unknown> = {}) => ({ id, ownerId: "u1", clientId: "c1", uploadState: "complete",
  recording: { id, status: "complete", pointCycle: { mode: "automatic_stations", collectionId: "a".repeat(32), bladeId: "2", sessionId: id, radialPointId: "p1" } }, ...changes }) as CaptureSummary;
const first = capture("first");
const otherPoint = capture("second", { recording: { ...first.recording, id: "second", pointCycle: { ...first.recording.pointCycle, radialPointId: "p2" } } });
const pending = capture("pending", { uploadState: "uploading" });
const unrelated = [capture("other-owner", { ownerId: "u2" }), capture("other-client", { clientId: "c2" }),
  capture("other-task", { recording: { ...first.recording, pointCycle: { ...first.recording.pointCycle, collectionId: "b".repeat(32) } } }),
  capture("other-blade", { recording: { ...first.recording, pointCycle: { ...first.recording.pointCycle, bladeId: "3" } } })];
const selected = bladeCaptureSelection([first, otherPoint, pending, ...unrelated], first);
assert.deepEqual(selected.captures.map(item => item.id), ["first", "second"]);
assert.equal(selected.pending, 1);
assert.equal(selected.automatic, true);
assert.equal(bladeCaptureSelection([{ ...first, uploadState: "uploading" }], first).captures.length, 1, "Fresh selected detail wins over stale polling list");
const ordinary = capture("ordinary", { recording: { id: "ordinary", name: "same name" } });
assert.deepEqual(bladeCaptureSelection([first, ordinary], ordinary).captures.map(item => item.id), ["ordinary"]);
assert.equal(hasBladePassMetadata(first.recording), true);
assert.equal(hasBladePassMetadata(ordinary.recording), false);
assert.equal(hasBladePassMetadata({ ...ordinary.recording, sourceMetadata: { pointCycle: {} } } as any), true);
console.log("PASS same task/blade preparation, owner/client boundaries, pending records and intermittent metadata isolation");
void (async () => {
  let current = true;
  let release!: (record: typeof first.recording) => void;
  const calls: string[] = [];
  const pending = prepareBladeCaptures([first, otherPoint], async id => { calls.push(id); return new Promise(resolve => { release = resolve; }); }, () => current);
  current = false; release(first.recording);
  assert.equal(await pending, null, "Unmounted or superseded preparation must not return old results");
  assert.deepEqual(calls, ["first"], "Do not continue batch writes after cancellation");
  const result = await prepareBladeCaptures([first, otherPoint], async id => ({ ...first.recording, id }), () => true);
  assert.deepEqual(result?.map(record => record.id), ["first", "second"]);
  console.log("PASS cancelled batch discards late response and stops subsequent preparations");
})();
