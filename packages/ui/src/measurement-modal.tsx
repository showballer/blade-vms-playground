"use client";
import {RetainedPanel} from "./retained-panel";
import React,{useState} from "react";
import {UnifiedWebAnalysis} from "./unified-web-analysis";
import {WebModalAnalysis} from "./web-modal-analysis";
import {FormalModalWorkspace} from "./formal-modal-workspace";

export function MeasurementModal({canWrite}:{canWrite:boolean}){
 const [tab,setTab]=useState('response');
 const [inputMode,setInputMode]=useState('batch');
 return <div className="stack measurement-workspace unified-modal-page"><header className="measurement-heading"><h1>模态识别</h1></header><nav className="measurement-tabs" aria-label="模态识别子页">{[['response','叶片响应分析'],['parameters','模态参数识别']].map(([id,name])=><button key={id} className={tab===id?'active':''} onClick={()=>setTab(id)}>{name}</button>)}</nav><RetainedPanel active={tab==='response'}><UnifiedWebAnalysis purpose="synthesis" canWrite={canWrite}/></RetainedPanel><RetainedPanel active={tab==='parameters'}><nav className="measurement-tabs unified-modal-input-tabs" aria-label="模态输入来源">{[['batch','模态批次识别'],['segment','已保存连续段识别']].map(([id,name])=><button key={id} className={inputMode===id?'active':''} onClick={()=>setInputMode(id)}>{name}</button>)}</nav><RetainedPanel active={inputMode==='batch'}><WebModalAnalysis canWrite={canWrite}/></RetainedPanel><RetainedPanel active={inputMode==='segment'}><FormalModalWorkspace canWrite={canWrite} onResponse={()=>setTab("response")}/></RetainedPanel></RetainedPanel></div>;
}
