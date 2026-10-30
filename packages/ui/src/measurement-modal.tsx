"use client";
import React,{useState} from "react";
import {UnifiedWebAnalysis} from "./unified-web-analysis";
import {FormalModalWorkspace} from "./formal-modal-workspace";

export function MeasurementModal({canWrite}:{canWrite:boolean}){
 const [tab,setTab]=useState('response');
 return <div className="stack measurement-workspace unified-modal-page"><header className="measurement-heading"><h1>模态识别</h1></header><nav className="measurement-tabs" aria-label="模态识别子页">{[['response','叶片响应分析'],['parameters','模态参数识别']].map(([id,name])=><button key={id} className={tab===id?'active':''} onClick={()=>setTab(id)}>{name}</button>)}</nav>{tab==='response'?<UnifiedWebAnalysis purpose="synthesis" canWrite={canWrite}/>:<FormalModalWorkspace canWrite={canWrite} onResponse={()=>setTab("response")}/>}</div>;
}
