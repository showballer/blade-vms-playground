"use client";
import React, {useRef} from "react";

/** Lazy mount once per signed-in workspace; tab changes do not discard analysis. */
export function RetainedPanel({active, children}: {active:boolean; children:React.ReactNode}) {
 const visited=useRef(false);
 if(active)visited.current=true;
 return <div hidden={!active} style={!active?{display:'none'}:undefined}>{visited.current?children:null}</div>;
}
