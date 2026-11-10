"use client";
import React from 'react';
import {Chart} from './charts';
import {Table} from './common';
import {reportSpatialFigure} from './measurement-report-figure';
import {measurementReportModel,reportNumber as num} from './measurement-report-model';

export function MeasurementReportPreview({report}:{report:any}) {
 const m=measurementReportModel(report);
 const chart=(b:any,metric:string,unit:string)=>({tooltip:{trigger:'axis'},color:['#3569bb'],grid:{top:46,right:28,bottom:35,left:85,containLabel:true},
  xAxis:{type:'category',data:b.points.map((p:any)=>p.name)},yAxis:{type:'value',name:unit,nameGap:20},series:[{type:'line',connectNulls:false,symbolSize:7,data:b.points.map((p:any)=>p[metric])}]});
 return <article className="health-report-preview">
  <header className="health-report-cover"><small>MEASUREMENT REPORT</small><h2>{m.title}</h2><p>{m.task}</p><div className="health-report-meta"><span>{m.farm} / {m.turbine}</span><span>测量：{m.measured}</span><span>生成：{m.created} · {m.author}</span><span>{m.number}</span></div></header>
  <section><h3>测量概况</h3><p>本批次采到 {m.acquired} 条记录，其中 {m.analyzable} 条可用于响应分析。</p><Table headers={['叶片','可分析 / 采到','健康核验状态']}>{m.blades.map((b:any)=><tr key={b.id||b.name}><td>{b.name}</td><td>{b.analyzable} / {b.acquired}</td><td>{b.status}</td></tr>)}</Table></section>
  {m.blades.map((b:any)=>{const spatial=reportSpatialFigure(b.points,b.estimatedPositions);return <section className="health-report-blade" key={b.id||b.name}><header><h3>{b.name} · 测量结果</h3><span className="health-report-status">{b.status}</span></header>
   <div className="health-report-charts">{b.points.some((p:any)=>Number.isFinite(p.velocityMmS))&&<div><h4>各测点响应</h4><Chart height={260} label={`${b.name}各测点响应`} option={chart(b,'velocityMmS','半峰峰值 / mm/s')}/></div>}{b.points.some((p:any)=>Number.isFinite(p.displacementMm))&&<div><h4>各测点位移振幅</h4><Chart height={260} label={`${b.name}各测点位移振幅`} option={chart(b,'displacementMm','位移半峰峰值 / mm')}/></div>}</div>
   <div className="health-report-spatial"><h4>三维空间幅值{b.estimatedPositions?' · 估算位置':''}</h4>{spatial?<img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(spatial)}`} alt={`${b.name}位移振幅三维分布，静态示意，非同步振型`}/>:<p>缺少有效位移幅值或测点位置，暂不能绘制三维分布。</p>}</div>
   {!!b.points.length&&<Table headers={['测点','距中心 · m','速度半峰峰值 · mm/s','位移半峰峰值 · mm']}>{b.points.map((p:any)=><tr key={p.name}><td>{p.name}</td><td>{num(p.radiusM,2)}</td><td>{num(p.velocityMmS)}</td><td>{num(p.displacementMm,5)}</td></tr>)}</Table>}
   <p className="health-report-conditions">关联工况 {b.matched} / {b.conditionCount} 条 · 风速 {b.wind} · 转速 {b.rpm}{b.shiftedConditions&&<><br/>工况来源：时间平移关联，非同期实测。</>}</p>
  </section>;})}
 </article>;
}
