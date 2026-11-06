import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FieldModalCapture } from './field-modal-capture';
for (const method of ['frf', 'ssi_cov'] as const) {
 const html = renderToStaticMarkup(<FieldModalCapture method={method} request={async <T,>()=>({} as T)} onActive={()=>{}} onSaved={()=>{}} />);
 for (const label of ['试验任务','同步采集设备编号','采样率','采集时长','开始同步采集','停止并保存','标定依据','核对通道']) assert.ok(html.includes(label),label);
 assert.equal(html.includes('同步测点数'),method==='ssi_cov');
 assert.equal(html.includes('激励力 · N'),method==='frf');
 assert.ok(!html.includes('导入采集文件'));
}
console.log('PASS FRF and SSI provide acquisition configuration, channel mapping, Start and Stop controls');
