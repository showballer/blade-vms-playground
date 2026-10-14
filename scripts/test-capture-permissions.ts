/** Pure policy checks: no database, network, credentials or capture hardware. */
import assert from "node:assert/strict";
import { canReadCapture, captureScope, HttpError, permission, recordScope, requireCaptureAnalysis, requireCaptureWrite, type User } from "../apps/web/lib/db";

let checks = 0;
const roles: User["role"][] = ["admin", "analyst", "operator", "viewer"];
const captures = [
  { ownerId: "self", tenant: "team-a", relation: "own" },
  { ownerId: "colleague", tenant: "team-a", relation: "team" },
  { ownerId: "other", tenant: "team-b", relation: "other" },
  { ownerId: "self", tenant: "old-team", relation: "moved" },
];
function denied(operation: () => void) {
  assert.throws(operation, error => error instanceof HttpError && error.status === 403);
}
for (const role of roles) {
  const user: User = { id: "self", username: "policy-test", name: "Policy fixture", role, tenant: "team-a", active: 1 };
  for (const capture of captures) {
    const allowed = role === "admin" || (capture.relation === "own" || capture.relation === "team" && role !== "operator");
    assert.equal(canReadCapture(user, capture), allowed, `${role} cannot cross ${capture.relation} boundary`); checks++;
  }
  if (role === "viewer") denied(() => requireCaptureWrite(user));
  else assert.doesNotThrow(() => requireCaptureWrite(user));
  if (role === "operator" || role === "viewer") denied(() => requireCaptureAnalysis(user));
  else assert.doesNotThrow(() => requireCaptureAnalysis(user));
  if (role !== "admin") denied(() => permission(user, "users", true));
  else assert.doesNotThrow(() => permission(user, "users", true));
  checks += 3;
  const scope = captureScope(user);
  assert.deepEqual(scope.args, role === "admin" ? [] : role === "operator" ? [user.tenant, user.id] : [user.tenant]);
  assert.equal(scope.sql.includes("c.owner_id=?"), role === "operator");
  assert.equal(scope.sql.includes("c.tenant=?"), role !== "admin");
  // Existing task ownership rules must remain stricter for operators.
  assert.equal(recordScope(user, "tasks").sql.includes("r.created_by=?"), role === "operator");
  checks += 4;
}
console.log(JSON.stringify({ ok: true, checks, scope: "Capture role, group and ownership policy; existing task scope preserved" }, null, 2));
