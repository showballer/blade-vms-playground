import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import mysql from "mysql2/promise";

assert.equal(process.env.DB_NAME, "blade_vms_playground");
const db = await mysql.createConnection({ host:process.env.DB_HOST, port:Number(process.env.DB_PORT), user:process.env.DB_USER, password:process.env.DB_PASSWORD, database:process.env.DB_NAME });
const tag = "qa_audit_" + randomUUID().replaceAll("-", ""), results = [], sessions = [];
const base = "http://127.0.0.1:3210/api/v1/";
let token;
async function request(path, auth = token, method = "GET", body) {
  const response = await fetch(base + path, { method, headers:{ ...(auth ? { Authorization:"Bearer " + auth } : {}), ...(body ? {"Content-Type":"application/json"} : {}) }, body:body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status:response.status, text, json:response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : undefined };
}
async function login(username) {
  const response = await request("session", null, "POST", {username,password:process.env.BOOTSTRAP_PASSWORD});
  assert.equal(response.status, 200); sessions.push(response.json.token); return response.json.token;
}
async function check(name, test) { await test(); results.push({name,result:"pass"}); console.log("PASS " + name); }
const query = (filters = {}) => new URLSearchParams({paginated:"1",actor:tag,...filters}).toString();
try {
  token = await login("admin");
  const fixtures = [];
  for (let i=0;i<55;i++) fixtures.push([randomUUID(),tag,tag,"验收查询",`${tag}-regular-${i}`,i%2 ? "失败" : "成功",`2001-01-02 12:00:${String(i).padStart(2,"0")}`]);
  for (const [target,date] of [["before","2001-01-01 23:59:59"],["start","2001-01-02 00:00:00"],["end","2001-01-02 23:59:59"],["after","2001-01-03 00:00:00"],["literal%_\\","2001-01-02 10:00:00"]]) fixtures.push([randomUUID(),tag,tag,"边界",tag+"-"+target,"成功",date]);
  for (let i=0;i<10001;i++) fixtures.push([randomUUID(),tag,tag,"导出上限",tag+"-limit","成功","2003-01-01 00:00:00"]);
  // Synthetic, randomly scoped rows only; no genuine operational audit is changed.
  for(let i=0;i<fixtures.length;i+=250) {
    const batch = fixtures.slice(i,i+250);
    await db.query("INSERT INTO audit_logs(id,actor_name,tenant,action,target,result,created_at) VALUES " + batch.map(()=>"(?,?,?,?,?,?,?)").join(","),batch.flat());
  }
  await check("旧数组接口兼容且可按条件检索 500 条之外的旧日志", async()=>{
    const legacy = await request("logs?actor="+tag); assert.equal(legacy.json.length,500);
    const old = await request("logs?actor="+tag+"&target="+tag+"-before"); assert.equal(old.json.length,1); assert.match(old.json[0].time,/2001-01-01/);
  });
  await check("数据库分页总数和稳定排序，无重复或遗漏",async()=>{
    const ids=[];
    for(let page=1;page<=3;page++) {
      const result = await request("logs?"+query({target:tag+"-regular",page:String(page)}));
      assert.equal(result.status,200); assert.equal(result.json.total,55); assert.equal(result.json.page,page); assert.equal(result.json.items.length,page===3?5:25);
      ids.push(...result.json.items.map(row=>row.id)); assert.ok(result.json.actions.includes("验收查询"));
    }
    assert.equal(new Set(ids).size,55);
  });
  await check("时间范围包含开始零点和结束末秒，排除相邻日期",async()=>{
    const result=await request("logs?"+query({from:"2001-01-02",to:"2001-01-02",pageSize:"100"}));
    assert.equal(result.status,200); assert.equal(result.json.total,58);
    assert.ok(result.json.items.some(row=>row.target.endsWith("-start"))); assert.ok(result.json.items.some(row=>row.target.endsWith("-end")));
    assert.ok(result.json.items.every(row=>row.time.startsWith("2001-01-02")));
  });
  await check("操作人、动作、对象、结果组合查询与通配符字面匹配",async()=>{
    const result=await request("logs?"+query({action:"验收查询",target:tag+"-regular",result:"失败",pageSize:"100"})); assert.equal(result.json.total,27);
    const literal=await request("logs?"+query({target:"%_\\"})); assert.equal(literal.json.total,1); assert.ok(literal.json.results.includes("成功")); assert.ok(literal.json.results.includes("失败"));
    const injection=await request("logs?"+query({target:"' OR 1=1 --"})); assert.equal(injection.json.total,0);
  });
  await check("导出共享已应用筛选且包含全部页，字段兼容",async()=>{
    const filters=new URLSearchParams({actor:tag,target:tag+"-regular",format:"json",page:"2",pageSize:"25"});
    const exported=await request("export/logs?"+filters); assert.equal(exported.status,200); assert.equal(exported.json.length,55);
    assert.deepEqual(Object.keys(exported.json[0]).sort(),["actor_name","action","target","result","created_at"].sort());
    filters.set("format","csv"); filters.set("result","失败"); const csv=await request("export/logs?"+filters); assert.equal(csv.status,200); assert.equal(csv.text.trim().split(/\r?\n/).length,28);
  });
  await check("超过 10000 条导出明确拒绝而不是静默截断",async()=>{const result=await request("export/logs?"+new URLSearchParams({actor:tag,target:tag+"-limit",format:"json"})); assert.equal(result.status,413); assert.match(result.json.error,/10000/);});
  await check("非法日期、重复参数和分页值返回 400",async()=>{
    for(const suffix of ["from=2001-02-29","to=2001-99-99","from=2001-01-03&to=2001-01-02","from=oops","page=0","page=-1","page=1.5","pageSize=101","actor=x&actor=y","paginated=0"]) {
      const result=await request("logs?"+suffix); assert.equal(result.status,400,suffix+" : "+result.status);
    }
    const exported=await request("export/logs?format=json&from=2001-02-29"); assert.equal(exported.status,400);
  });
  await check("空结果和末页之后显示真实零项",async()=>{
    const result=await request("logs?"+query({target:tag+"-regular",page:"4"})); assert.equal(result.json.total,55); assert.equal(result.json.items.length,0);
    const empty=await request("logs?"+query({target:"does-not-exist"})); assert.equal(empty.json.total,0); assert.deepEqual(empty.json.items,[]);
  });
  await check("日志只读路径限制以及三类非管理员拒绝读取/导出",async()=>{
    assert.equal((await request("logs/unknown")).status,405); assert.equal((await request("logs",token,"POST",{})).status,405); assert.equal((await request("export/logs/unknown?format=json")).status,405);
    for(const username of ["zhang","li","guest"]) { const role=await login(username); assert.equal((await request("logs?"+query(),role)).status,403); assert.equal((await request("export/logs?format=json",role)).status,403); }
    assert.equal((await request("logs",null)).status,401);
  });
} finally {
  // Exact random tenant + actor resolve only synthetic fixtures inserted above.
  await db.execute("DELETE FROM audit_logs WHERE tenant=? AND actor_name=?",[tag,tag]);
  for(const session of sessions) await request("session",session,"DELETE");
  await db.end();
  writeFileSync("artifacts/audit-query-results.json",JSON.stringify({time:new Date().toISOString(),checks:results,syntheticRowsCleaned:true,note:"真实登录和导出审计保留；不修改用户或其他业务记录"},null,2));
}
