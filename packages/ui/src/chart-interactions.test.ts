import assert from 'node:assert/strict';
import * as echarts from 'echarts';
import { sliderOnlyZoom } from './chart-interactions';

const input = {
  animation: false, grid: {left: 60, right: 30, top: 30, bottom: 70},
  xAxis: {type: 'value'}, yAxis: {type: 'value'},
  dataZoom: [{id:'inside',type:'inside',start:10,end:90,throttle:0}, {id:'slider',type:'slider',bottom:10,height:20,throttle:0}],
  series: [{type:'line',data:Array.from({length:101},(_,i)=>[i,Math.sin(i)])}],
};
const before=JSON.stringify(input),option=sliderOnlyZoom(input);
assert.equal(JSON.stringify(input),before,'Keep source chart options intact');
assert.equal(option.dataZoom[1],input.dataZoom[1],'Keep axis slider options intact');
assert.equal(sliderOnlyZoom({series:[]}).dataZoom,undefined);
assert.equal(sliderOnlyZoom({dataZoom:{type:'inside',yAxisIndex:0}}).dataZoom.disabled,true);

function chartWith(opt:Record<string,any>){
 const chart=echarts.init(null,undefined,{renderer:'svg',ssr:true,width:900,height:340});
 chart.setOption(opt);return chart;
}
function wheel(chart:echarts.ECharts){
 chart.getZr().handler.dispatch('mousewheel',{zrX:450,zrY:150,zrDelta:1,preventDefault(){},stopPropagation(){}} as any);
}
const original=chartWith(input),changed=chartWith(option);
try{
 wheel(original);
 assert.notEqual((original.getOption().dataZoom as any[])[0].start,10,'Control: original plot reacts to wheel');
 wheel(changed);
 const dz=changed.getOption().dataZoom as any[];
 assert.equal(dz[0].start,10);assert.equal(dz[0].end,90,'Wheel leaves the displayed range unchanged');
 assert.equal(dz[0].zoomOnMouseWheel,false);assert.equal(dz[0].moveOnMouseWheel,false);
 changed.dispatchAction({type:'dataZoom',dataZoomId:'slider',start:25,end:75});
 const zoomed=changed.getOption().dataZoom as any[];
 assert.equal(zoomed[0].start,25);assert.equal(zoomed[0].end,75,'Slider still updates the linked axis');
 changed.setOption(sliderOnlyZoom({...input,dataZoom:input.dataZoom.map(({start,end,...z})=>z)}),{notMerge:false,replaceMerge:['series']});
 assert.equal((changed.getOption().dataZoom as any[])[0].start,25,'Live updates retain the manually selected range');
 assert.match(changed.renderToSVGString(),/<svg/);
}finally{original.dispose();changed.dispose();}
console.log('PASS chart interactions: original wheel positive control, wheel disabled, slider retained, live range retained');
