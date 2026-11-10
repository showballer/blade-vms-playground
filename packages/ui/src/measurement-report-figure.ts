import {finiteRadius, finiteAmplitude, responseEnvelopeIntervals, responseProjection, type Response3DPoint} from './measurement-response-geometry';

const esc=(v:unknown)=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export type ReportFigurePoint={name:string;radiusM:number|null;displacementMm:number|null};
/** Static positive-amplitude pose of the same displacement envelope shown by health monitoring. */
export function reportSpatialFigure(points:ReportFigurePoint[],estimated=false):string|null {
 const max=Math.max(0,...points.map(p=>finiteAmplitude(p.displacementMm)?p.displacementMm:0));
 const data:Response3DPoint[]=points.map(p=>({id:p.name,name:p.name,radiusM:p.radiusM,displacementRmsM:null,normalizedAmplitude:finiteAmplitude(p.displacementMm)?max?p.displacementMm/max:0:null}));
 const located=data.filter(p=>finiteRadius(p.radiusM)),valid=located.filter(p=>finiteAmplitude(p.normalizedAmplitude));
 const extent=Math.max(0,...located.map(p=>p.radiusM!));
 if(!extent||!valid.length)return null;
 const {project,polygon}=responseProjection(extent);
 const intervals=responseEnvelopeIntervals(data);
 let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="640" viewBox="0 0 1000 400"><rect width="1000" height="400" fill="#f8fafc"/><g font-family="Microsoft YaHei,Heiti SC,sans-serif" font-size="18" fill="#435870"><text x="24" y="28">位移振幅空间分布${estimated?' · 估算位置':''}</text>`;
 svg+=`<g transform="translate(-150,-57) scale(1.3)"><polygon points="${polygon(0,extent,0,0)}" fill="#e7edf4" stroke="#92a2b5" stroke-dasharray="5 4"/>`;
 for(const {from,to} of intervals){
  const n=Math.max(2,Math.ceil(80*(to.radiusM-from.radiusM)/extent));
  for(let i=0;i<n;i++){
   const t=i/n,u=(i+1)/n,a=from.radiusM+(to.radiusM-from.radiusM)*t,b=from.radiusM+(to.radiusM-from.radiusM)*u;
   const va=from.normalizedAmplitude!+(to.normalizedAmplitude!-from.normalizedAmplitude!)*t,vb=from.normalizedAmplitude!+(to.normalizedAmplitude!-from.normalizedAmplitude!)*u;
   const hue=220-210*Math.min(1,(va+vb)/2),color=`hsl(${hue},76%,49%)`;
   svg+=`<polygon data-interval="${esc(from.id)}:${esc(to.id)}" points="${polygon(a,b,va,vb)}" fill="${color}" stroke="${color}" stroke-width=".5"/>`;
  }
 }
 for(const p of located){
  const known=finiteAmplitude(p.normalizedAmplitude),pos=project(p.radiusM!,0,known?p.normalizedAmplitude!:0),zero=project(p.radiusM!,0,0);
  svg+=`<g data-point="${esc(p.id)}" data-radius-m="${p.radiusM}" data-amplitude="${known?p.normalizedAmplitude:'missing'}"><line x1="${pos[0]}" y1="${pos[1]}" x2="${zero[0]}" y2="${zero[1]}" stroke="#92a2b5" stroke-dasharray="3 4"/><circle cx="${pos[0]}" cy="${pos[1]}" r="5" fill="${known?'#174775':'white'}" stroke="${known?'white':'#72859d'}" stroke-width="2"/><text x="${pos[0]}" y="${pos[1]-14}" text-anchor="middle" font-weight="bold">${esc(p.name)}${known?'':' · 缺测'}</text></g>`;
 }
 svg+=`</g><text x="24" y="352">0 = 风机中心 · 最远测点 ${esc(Number(extent.toPrecision(5)))} m</text><text x="24" y="380" font-size="16">归一化位移幅值 · 灰面为零位参考；静态示意，非同步实测振型。</text></g></svg>`;
 return svg;
}
