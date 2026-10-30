"use client";
import React from "react";
import {UnifiedWebAnalysis} from "./unified-web-analysis";
export function MeasurementAnalysis({canWrite,onImport,refreshKey=0}:{canWrite:boolean;refreshKey?:number;preferredIds?:string[];onImport?:()=>void}){
 return <UnifiedWebAnalysis key={refreshKey} purpose="signal" canWrite={canWrite} onImport={onImport}/>;
}
