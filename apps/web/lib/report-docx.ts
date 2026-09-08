import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ImageRun, BorderStyle, VerticalAlign, Footer, PageNumber, AlignmentType, TableLayoutType } from "docx";
import { reportContent } from "@blade/ui/report-data";
import { reportDetails, reportTaskFigure, type ReportFigure } from "@blade/ui/report-details";
import { reportFigurePng } from "./report-chart";
type Row = Record<string, any>;
const font = { ascii: "Microsoft YaHei", hAnsi: "Microsoft YaHei", eastAsia: "Microsoft YaHei", cs: "Microsoft YaHei" };
const p = (text: string, keepNext = false) => new Paragraph({ text, keepNext, widowControl: true, spacing: { after: 100, line: 290 } });
function table(headers: string[], rows: string[][]) {
  const widths = headers.length === 2 ? [2800,6838] : headers.length === 3 ? [2200,3000,4438] : Array.from({length:headers.length},(_,i)=>Math.floor(9638/headers.length)+(i===0?9638%headers.length:0));
  return new Table({ width:{size:9638,type:WidthType.DXA}, columnWidths:widths, layout:TableLayoutType.FIXED,
    margins:{top:85,bottom:85,left:110,right:110}, borders:Object.fromEntries(["top","bottom","left","right","insideHorizontal","insideVertical"].map(side=>[side,{style:BorderStyle.SINGLE,size:4,color:"D9D9D9"}])),
    rows:[headers,...rows].map((cells,i)=>new TableRow({tableHeader:i===0,cantSplit:true,children:cells.map((cell,j)=>new TableCell({width:{size:widths[j],type:WidthType.DXA},verticalAlign:VerticalAlign.CENTER,
      shading:i===0?{fill:"EAF1FB"}:undefined,children:[new Paragraph({children:[new TextRun({text:cell,font,size:20,bold:i===0,color:"000000"})],spacing:{after:0,line:270},widowControl:true})]}))})) });
}
async function figure(value: ReportFigure) {
  return [new Paragraph({ keepNext:true, children:[new ImageRun({type:"png",data:await reportFigurePng(value.option),transformation:{width:600,height:204},altText:{title:value.caption,description:value.caption,name:"Saved result chart"}})] }),p(value.caption)];
}
/** Product Word export. Input snapshots and section selection are also used by browser/PDF rendering. */
export async function reportDocx(report: Row, task: Row, analyses: Row[], userName: string) {
  const children: (Paragraph|Table)[] = [];
  if (report.logoData) children.push(new Paragraph({children:[new ImageRun({type:report.logoData.startsWith("data:image/png;")?"png":"jpg",data:Buffer.from(report.logoData.split(",")[1],"base64"),transformation:{width:Math.min(144,48*report.logoAspect),height:Math.min(144,48*report.logoAspect)/report.logoAspect},altText:{title:"报告单位 Logo",description:report.organization||"报告单位 Logo",name:"Report logo"}})]}));
  children.push(p(report.organization||"三维台架结构力学特征测试系统"),p("报告编号："+(report.reportNumber||"未填写")),
    new Paragraph({text:report.name||"旋转叶片检测报告",heading:HeadingLevel.TITLE}),
    p("本报告汇总所选任务保存时的对象信息、参数与分析结果，供分析人员复核。"),
    p(`保存时间：${report.generatedAt||report.updatedAt}；编制：${report.author||userName}`),
    p("设备与 Python 算法未接入。报告中的演示分析不作为真实检测依据，原始数据与演示结果分别注明来源。"));
  for (const [index,section] of reportContent(report,task,analyses).entries()) {
    children.push(new Paragraph({text:`${index+1} ${section.title}`,heading:HeadingLevel.HEADING_1}));
    const details=reportDetails(section.title,report.taskId,analyses);
    if (section.text) children.push(p(section.text));
    if (section.title==="原始波形") { const raw=reportTaskFigure(task); if(raw)children.push(...await figure(raw)); }
    // Narrative analysis records have full-width paragraphs, not a three-column JSON table.
    if (section.rows && (!details.length||section.title==="原始波形")) children.push(table(section.headers!,section.rows),p(""));
    for (const detail of details) {
      children.push(new Paragraph({text:detail.title,heading:HeadingLevel.HEADING_2}),p(detail.description));
      for (const line of detail.parameters) children.push(p(line));
      if (detail.figure) children.push(...await figure(detail.figure));
      for (const group of detail.tables || []) {
        if (group.caption) children.push(p(group.caption, true));
        children.push(table(group.headers, group.rows), p(""));
      }
      if (detail.rows) children.push(p(detail.tableNote||""));
    }
  }
  children.push(p("原始任务引用："+report.taskId));
  return Packer.toBuffer(new Document({creator:report.author||userName,title:report.name,styles:{default:{document:{run:{font,size:22,color:"000000"},paragraph:{spacing:{after:100,line:290}}},title:{run:{font,size:36,color:"000000"},paragraph:{spacing:{before:100,after:180},keepNext:true}},heading1:{run:{font,size:28,bold:true,color:"000000"},paragraph:{keepNext:true,spacing:{before:240,after:100}}},heading2:{run:{font,size:24,bold:true,color:"000000"},paragraph:{keepNext:true,spacing:{before:180,after:100}}}}},sections:[{properties:{page:{size:{width:11906,height:16838},margin:{top:1000,bottom:1000,left:1134,right:1134}}},footers:{default:new Footer({children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({font,size:18,color:"666666",children:["第 ",PageNumber.CURRENT," 页 / 共 ",PageNumber.TOTAL_PAGES," 页"]})]})]})},children}]}));
}
