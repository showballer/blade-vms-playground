// Static component checks only: no browser, layout, effects or clicks are tested.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Health, Reports } from "../packages/ui/src/web-screens";
import { ModalAnalysis } from "../packages/ui/src/modal-screen";
import { Developer, Administration } from "../packages/ui/src/admin-screens";
import type { Bootstrap, User } from "../packages/ui/src/api";
import { records } from "./seed-data.mjs";

const results: { name: string; result: string }[] = [];
function check(name: string, fn: () => unknown) { fn(); results.push({ name, result: "pass" }); console.log("PASS " + name); }
function buttons(markup: string, label: string) {
  return [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter(match => match[2].replace(/<[^>]*>/g, "").trim() === label);
}
function state(markup: string, label: string, disabled: boolean) {
  const matches = buttons(markup, label);
  assert.equal(matches.length, 1, "Expected one button: " + label);
  assert.equal(/\bdisabled(?:=|\s|$)/.test(matches[0][1]), disabled, label);
}
for (const role of ["admin", "analyst", "operator", "viewer"] as User["role"][]) {
  const user = { id: "qa-static-" + role, username: "static-" + role, name: "静态权限测试", role, tenant: "QA-markup" };
  const data = { ...structuredClone(records), user, analyses: [], reports: [] } as unknown as Bootstrap;
  data.tasks = data.tasks.map(task => ({ ...task, recordTenant: user.tenant, samples: [0, 1, 0, -1], channels: [{ no: 1, type: "velocity", unit: "mm/s" }] }));
  data.baselines = data.baselines.map(baseline => ({ ...baseline, recordTenant: user.tenant }));
  if (role !== "admin") { data.models = []; data.settings = []; }
  const canAnalyze = role === "admin" || role === "analyst";
  // Matches the screen-specific overrides in AppShell. API tests independently
  // enforce these rules; this does not simulate a logged-in browser session.
  const props = { data, canWrite: canAnalyze, refresh: async () => {}, notify: () => {}, go: () => {} };
  check(role + " 健康页保存/复核与只读入口", () => {
    const html = renderToStaticMarkup(createElement(Health, props));
    state(html, "重新运行演示检测", !canAnalyze);
    state(html, "基线管理", false);
    assert.ok(html.includes("当前组阈值"));
  });
  check(role + " 模态页保存/报告与查看入口", () => {
    const html = renderToStaticMarkup(createElement(ModalAnalysis, props));
    state(html, "保存演示模态结果", !canAnalyze);
    state(html, "生成模态报告", !canAnalyze);
    state(html, "基线管理", false);
  });
  check(role + " 报告页模板/批量入口", () => {
    const html = renderToStaticMarkup(createElement(Reports, props));
    state(html, "抬头 / Logo / 编号配置", !canAnalyze);
    state(html, "批量生成", !canAnalyze);
  });
  check(role + " 二次开发只读与管理员配置入口", () => {
    const html = renderToStaticMarkup(createElement(Developer, props));
    state(html, "读取当前数据", false);
    state(html, "接入算法模型", role !== "admin");
    state(html, "创建 API 令牌", role !== "admin");
    assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
    assert.equal((html.match(/aria-pressed="false"/g) || []).length, 5);
  });
  for (const initialTab of ["users", "logs", "backup", "alerts"]) {
    check(role + " 系统管理 " + initialTab + " 初始权限状态", () => {
      const html = renderToStaticMarkup(createElement(Administration, { ...props, initialTab }));
      if (initialTab !== "alerts") assert.equal(html.includes("权限提示"), role !== "admin");
      if (initialTab === "users") assert.equal(buttons(html, "新增用户").length, role === "admin" ? 1 : 0);
      if (initialTab === "alerts") {
        const actions = buttons(html, "处理");
        assert.ok(actions.length > 0);
        for (const action of actions) assert.equal(/\bdisabled(?:=|\s|$)/.test(action[1]), !canAnalyze);
      }
    });
  }
}
mkdirSync("artifacts", { recursive: true });
writeFileSync("artifacts/web-role-markup-results.json", JSON.stringify({ at: new Date().toISOString(), scope: "Static React initial markup; not browser, layout, effects, interaction or complete role coverage", results }, null, 2));
