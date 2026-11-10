import sharp from 'sharp';
import {Document,Packer,Paragraph,TextRun,Table,TableRow,TableCell,WidthType,BorderStyle,ImageRun,Header,Footer,PageNumber,AlignmentType,ShadingType} from 'docx';
import {measurementReportModel,reportNumber as num} from '@blade/ui/measurement-report-model';
import {reportSpatialFigure} from '@blade/ui/measurement-report-figure';
import {PRODUCT_NAME} from '@blade/ui/product-name';

const blue='265FA3', ink='202D3D', muted='62758B';
const text=(value:string,options:any={})=>new Paragraph({spacing:{after:120,line:290},children:[new TextRun({text:value,color:ink,...options})]});
const heading=(value:string)=>new Paragraph({heading:'Heading2',spacing:{before:220,after:160},keepNext:true,children:[new TextRun({text:value,bold:true,size:27,color:'000000'})]});
function table(headers:string[],rows:string[][],widths:number[]){
 return new Table({width:{size:100,type:WidthType.PERCENTAGE},columnWidths:widths,
  rows:[headers,...rows].map((row,i)=>new TableRow({tableHeader:i===0,cantSplit:true,children:row.map((v,j)=>new TableCell({width:{size:widths[j],type:WidthType.DXA},margins:{top:100,bottom:100,left:125,right:125},
   shading:{type:ShadingType.CLEAR,fill:i===0?'EAF0F7':i%2?'FFFFFF':'F7F9FC'},
   verticalAlign:'center',
   borders:{top:{style:BorderStyle.SINGLE,size:3,color:'D9D9D9'},bottom:{style:BorderStyle.SINGLE,size:3,color:'D9D9D9'},left:{style:BorderStyle.SINGLE,size:3,color:'D9D9D9'},right:{style:BorderStyle.SINGLE,size:3,color:'D9D9D9'}},
   children:[new Paragraph({spacing:{after:0,line:270},children:[new TextRun({text:v,color:i===0?'000000':ink,bold:i===0,size:20})]})]}))}))});
}
const esc=(v:any)=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function responseChart(points:any[],metric:'velocityMmS'|'displacementMm',width=640){
 const height=340,left=105,right=60,top=98,bottom=50,w=width-left-right,h=height-top-bottom;
 const vals=points.map(p=>p[metric]),finite=vals.filter(Number.isFinite);
 const rawMax=Math.max(...finite,1e-10)*1.15;
 const tickScale=10**Math.floor(Math.log10(rawMax/4));
 const tickStep=Math.ceil(rawMax/4/tickScale)*tickScale;
 const ymax=tickStep*4;
 const x=(i:number)=>left+w*(points.length===1?.5:i/(points.length-1));
 const y=(v:number)=>top+h-h*v/ymax;
 const unit=metric==='velocityMmS'?'半峰峰值 / mm/s':'位移半峰峰值 / mm';
 let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/><g font-family="Microsoft YaHei,Heiti SC,sans-serif" font-size="24" fill="#62758b"><text x="24" y="30" font-size="28" font-weight="bold" fill="#202d3d">${metric==='velocityMmS'?'各测点响应':'各测点位移振幅'}</text><text x="${left}" y="65">${unit}</text>`;
 for(let i=0;i<=4;i++){const v=ymax*i/4;svg+=`<path d="M${left},${y(v)}H${width-right}" stroke="#e3eaf3"/><text x="${left-16}" y="${y(v)+7}" text-anchor="end">${esc(v&&v<.01?v.toExponential(1):num(v,2))}</text>`;}
 let path='';vals.forEach((v,i)=>{if(Number.isFinite(v))path+=`${i&&Number.isFinite(vals[i-1])?'L':'M'}${x(i)},${y(v)} `;});
 svg+=`<path d="${path}" fill="none" stroke="#3569bb" stroke-width="4"/>`;
 points.forEach((p,i)=>{svg+=`<text x="${x(i)}" y="${height-30}" text-anchor="middle">${esc(p.name)}</text>`;if(Number.isFinite(p[metric]))svg+=`<circle cx="${x(i)}" cy="${y(p[metric])}" r="6" fill="white" stroke="#3569bb" stroke-width="3"/>`;});
 return svg+'</g></svg>';
}
export async function buildBladeReportDocx(report:any){
 const m=measurementReportModel(report),children:any[]=[];
 children.push(text('MEASUREMENT REPORT',{color:'000000',bold:true,size:22}),new Paragraph({style:'Title',spacing:{before:120,after:260},children:[new TextRun({text:m.title,bold:true,size:44,color:'000000'})]}),text(m.task,{size:26}),text(`${m.farm}  /  ${m.turbine}`,{color:muted}),
  table(['报告信息','内容'],[['报告编号',m.number],['测量时间',m.measured],['生成时间',m.created],['编制人员',m.author]], [2100,8100]),heading('测量概况'),text(`本批次采到 ${m.acquired} 条记录，其中 ${m.analyzable} 条可用于响应分析。`),
  table(['叶片','可分析 / 采到','健康核验状态'],m.blades.map((b:any)=>[b.name,`${b.analyzable} / ${b.acquired}`,b.status]),[1600,2400,6200]));
 for(const b of m.blades){
  children.push(new Paragraph({heading:'Heading1',pageBreakBefore:true,spacing:{after:200},children:[new TextRun({text:`${b.name}  /  测量结果`,bold:true,size:36,color:'000000'})]}),text(b.status,{bold:true,color:blue,size:26}),text(`可分析 ${b.analyzable} / 采到 ${b.acquired} 条 · 待复核 ${b.review} 条`,{color:muted}));
  const hasDisplacement=b.points.some((p:any)=>Number.isFinite(p.displacementMm));
  const metrics=(['velocityMmS','displacementMm'] as const).filter(metric=>b.points.some((p:any)=>Number.isFinite(p[metric])));
  if(metrics.length){
   const images=await Promise.all(metrics.map(async(metric,i)=>({input:await sharp(Buffer.from(responseChart(b.points,metric,1280/metrics.length))).png().toBuffer(),left:i*1280/metrics.length,top:0})));
   const paired=await sharp({create:{width:1280,height:340,channels:4,background:'white'}}).composite(images).png().toBuffer();
   children.push(new Paragraph({spacing:{before:100,after:120},children:[new ImageRun({data:paired,type:'png',transformation:{width:670,height:178}})]}));
  }
  children.push(heading('三维空间幅值'+(b.estimatedPositions?' · 估算位置':'')));
  const spatial=reportSpatialFigure(b.points,b.estimatedPositions);
  if(spatial)children.push(new Paragraph({spacing:{after:140},children:[new ImageRun({data:await sharp(Buffer.from(spatial)).png().toBuffer(),type:'png',transformation:{width:670,height:268}})]}));
  else children.push(text('缺少有效位移幅值或测点位置，暂不能绘制三维分布。',{size:21,color:muted}));
  if(b.points.length)children.push(table(['测点','距中心 m','速度半峰峰值 mm/s',...(hasDisplacement?['位移半峰峰值 mm']:[])],b.points.map((p:any)=>[p.name,num(p.radiusM,2),num(p.velocityMmS,3),...(hasDisplacement?[num(p.displacementMm,5)]:[])]),hasDisplacement?[1300,2200,3350,3350]:[1800,2800,5600]));
  children.push(heading('关联工况'),text(`匹配 ${b.matched} / ${b.conditionCount} 条 · 风速 ${b.wind} · 转速 ${b.rpm}`,{size:21}));
  if(b.shiftedConditions)children.push(text('工况来源：时间平移关联，非同期实测。',{size:19,color:muted}));
 }
 const doc=new Document({creator:PRODUCT_NAME,title:m.title,description:m.task,styles:{default:{document:{run:{font:'Microsoft YaHei',size:22,color:ink},paragraph:{spacing:{after:100}}}}},sections:[{properties:{page:{size:{width:11906,height:16838},margin:{top:850,bottom:850,left:850,right:850,header:360,footer:360}}},
  headers:{default:new Header({children:[new Paragraph({spacing:{after:70},border:{bottom:{style:BorderStyle.SINGLE,size:5,color:'DCE5EF'}},children:[new TextRun({text:PRODUCT_NAME,color:'000000',size:17}),new TextRun({text:'   |   BladeVMS',color:'000000',size:17})]})]})},
  footers:{default:new Footer({children:[new Paragraph({alignment:AlignmentType.RIGHT,children:[new TextRun({text:`${m.number}   ·   `,size:16,color:muted}),new TextRun({children:[PageNumber.CURRENT,' / ',PageNumber.TOTAL_PAGES],size:16,color:muted})]})]})},children}]});
 return Packer.toBuffer(doc);
}
