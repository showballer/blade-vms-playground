"use client";
import React from 'react';
import {Button,Tag} from './common';

export function healthConditionSummary(conditions:any[]=[]){
 const matched=conditions.filter(c=>c.condition?.status==='matched'&&Number.isFinite(c.condition.windSpeed)&&Number.isFinite(c.condition.rpm));
 const range=(field:string)=>{const values=matched.map(c=>c.condition[field]);return values.length?[Math.min(...values),Math.max(...values)]:null;};
 return {total:conditions.length,matched:matched.length,shifted:matched.some(c=>c.condition.timeShiftedForTest===true),windRange:range('windSpeed'),rpmRange:range('rpm')};
}

export function HealthConditionSummary({conditions,onView,disabled=false}:{conditions:any[];onView:()=>void;disabled?:boolean}){
 const summary=healthConditionSummary(conditions);
 const text=(range:number[]|null)=>range?range.map(v=>v.toLocaleString('zh-CN',{maximumFractionDigits:2})).filter((v,i,a)=>i===0||v!==a[0]).join('～'):'—';
 return <div className="health-condition-summary" aria-label="工况关联结果">
  <div className="health-condition-summary-values">
   <Tag tone={summary.matched===summary.total&&summary.total>0?'blue':'amber'}>{summary.total?`工况已匹配 ${summary.matched} / ${summary.total} 条`:'暂无可关联记录'}</Tag>
   {summary.matched>0&&<><span>风速 {text(summary.windRange)} m/s</span><span>主轴转速 {text(summary.rpmRange)} rpm</span></>}
   {summary.shifted&&<Tag tone="amber">时间平移测试副本</Tag>}
  </div>
  <Button disabled={disabled||!summary.total} onClick={onView}>查看工况对比</Button>
 </div>;
}
