/** Display adapters only. Signal processing and admission stay in the local worker. */
export type AnalysisJson = Record<string, any>;
export type RecordAnalysisCommand = { action: "catalog" | "start" | "status" | "result" | "preview" | "extended" | "export" | "cancel"; [key: string]: unknown };
export type RecordAnalysisBridge = <T>(options: { action: "recordAnalysis"; request: RecordAnalysisCommand }) => Promise<T>;
export type AnalysisCatalogRecord = {
  id: string; bladeId?: string; pointName?: string; pointId?: string; radiusM?: number | null;
  azimuthDeg?: number | null; createdAt?: number | string; sourceQuality?: AnalysisJson; measurementInputs?: AnalysisJson;
  plannedAzimuths?: number[]; sampleRate?: number; samples?: number;
};
export type AnalysisTask = {
  id: string; name: string; windFarm?: string; turbine?: string; recordingIds: string[]; records: AnalysisCatalogRecord[];
  plannedPoints?: { bladeId?: string; radialPointName?: string; radiusM?: number; azimuthDeg?: number }[];
  plan?: { blades?: { bladeId: string; points?: { id?: string; name: string; radiusM?: number; azimuths?: number[] }[] }[] };
};
export type AnalysisCatalog = { tasks: AnalysisTask[]; revision?: string; algorithmVersion?: string };
export type AnalysisReport = AnalysisJson & { records: AnalysisJson[]; aggregates: AnalysisJson[]; scope?: "diagnostic" | "analysis" };
export type AnalysisPoint = { key: string; bladeId: string; name: string; radiusM: number | null; records: AnalysisCatalogRecord[]; plannedAzimuths: number[]; radiusConflict?: boolean };
export const analysisTabs = [
  ["overview", "风机总览"], ["blade", "叶片分析"], ["point", "点位分析"],
  ["waveform", "单次波形"], ["extended", "扩展分析"], ["events", "趋势与事件"],
] as const;
export type AnalysisTab = typeof analysisTabs[number][0];
export const analysisChartNames: Record<string, string> = {
  A01: "原始速度波形", A02: "RSSI 回波", A03: "有效区间与质量", A04: "有效经过波形", A05: "处理图层对比", A06: "位移与加速度",
  A07: "FFT 幅度谱", A08: "PSD 与频带能量", A09: "响应峰", A10: "时频分析", A11: "包络与包络谱", A12: "同方位经过过程平均波形",
  A13: "同方位平均 PSD", A14: "有效片段排列", A15: "特征与点位统计", A16: "各方位平均振幅", A17: "径向测点平均振幅",
  A18: "同频带响应", A19: "多测点频谱", A20: "振幅示意", A21: "多叶片响应对比", A22: "质量与复核事件", A23: "批次特征趋势", A24: "高阶统计特征",
};
export const layerNames: Record<string, string> = { raw_los: "原始视线速度", calibrated_los: "校准视线速度", nominal_rotation: "转动模型", nominal_rotation_model: "转动模型", rotation_compensated_los: "转动补偿后视线", extra_background: "额外经验背景", estimated_extra_background: "额外经验背景", los_residual: "视线残差", axial_equivalent_residual: "轴向等效残差", filtered_residual: "滤波残差", removed_by_filter: "被滤除分量" };
export const reasonNames: Record<string, string> = {
  HARD_INVALID: "设备无效、超量程或非有限样本，已排除", RSSI_RULE_INVALID: "已验证的失光规则判为无效，已排除",
  ZERO_RUN_SUSPECT: "连续零值待复核，缺少独立无效证据，保留原值", FROZEN_RUN_SUSPECT: "疑似冻结待复核，缺少独立无效证据，保留原值",
  ZERO_RUN_CONFIRMED_INVALID: "连续零值与已验证失光证据一致，已排除", FROZEN_RUN_CONFIRMED_INVALID: "冻结区间与已验证失光证据一致，已排除",
  DECODER_INVALID: "已验证的解码异常区间，已排除", SIGNAL_LOST: "已验证的失光区间，已排除",
  PASS_DURING_MOTION: "实际经过发生在停稳前，待复核", PASS_INCOMPLETE: "本次经过不完整，待复核", SIMULATION_SOURCE: "模拟来源不纳入实测分析", MANUAL_WINDOW_REVIEW: "人工复核窗口，保留原始判定", HISTORICAL_QUALITY_FLAGS_RETAINED: "历史诊断标记已保留，不单独阻断分析", MOTION_EVIDENCE_UNAVAILABLE: "缺少本次停稳证据，不代表数据无效", HEALTH_REVIEW_NOT_PERFORMED: "尚未进行正式健康评估",
  GEOMETRY_UNVERIFIED_FOR_HISTORY: "几何尚未核验，保留诊断，不连接为跨批次趋势", ANALYSIS_SIZE_UNSUPPORTED: "当前计算规模过大，请减小显示或分析范围",
  PASS_BOUNDARY_OUTSIDE_RECORDING: "事件窗口超出记录范围，需复核映射", CLOCK_REFERENCE_MISMATCH: "事件与采样时钟不一致", SOURCE_METADATA_CONFLICT: "来源元数据冲突",
  TARGET_IDENTITY_UNVERIFIED: "目标叶片身份未核验", DATA_GAP: "存在采样缺口", OVERRANGE: "设备超量程", DEVICE_INVALID: "设备标记无效",
  RSSI_RULE_UNCALIBRATED: "回波判据未经标定", RSSI_TIME_ALIGNMENT_UNKNOWN: "回波时延未核验", SPIKE_SUSPECT: "疑似测量脉冲，待复核", SPIKE_SCALE_UNDEFINED: "尖峰尺度不足以判定",
  GEOMETRY_MISSING: "缺少几何坐标，保留视线结果", GEOMETRY_ASSUMED: "几何采用记录内的假设", SIGN_CALIBRATION_MISSING: "仪器符号未标定", RPM_REFERENCE_MISSING: "缺少记录同期转速参考",
  RPM_NOT_SYNCHRONIZED: "转速未与本次记录同步", PROJECTION_ILL_CONDITIONED: "投影增益过大，轴向换算不可用", MODEL_UNCERTAINTY_EXCEEDED: "模型误差超出门槛", PROJECTION_LIMITS_UNCONFIGURED: "尚未配置正式投影门槛",
  BACKGROUND_NOT_UNIQUE: "经验背景与转动项不能唯一分离", FILTER_SEGMENT_TOO_SHORT: "连续片段不足以使用该滤波参数", FILTER_EDGE_EXHAUSTED: "排除滤波边缘后无可用片段",
  INSUFFICIENT_OBSERVATION: "真实连续观测时长不足", SPECTRAL_PROFILE_MISMATCH: "频谱配置或频率网格不可比", JOIN_PREVIEW_UNSUPPORTED: "拟合条件不足，保持片段断线",
  SYNTHETIC_INPUT_FORBIDDEN: "展示合成数据禁止进入真实分析", AGGREGATION_BASIS_MISMATCH: "方向或处理层不同，不能混合汇总", CROSS_TASK_ASSOCIATION_REQUIRED: "跨任务数据需要明确业务关联",
  DIAGNOSTIC_ONLY: "原始记录仅供诊断", NO_FORMAL_ELIGIBLE_DATA: "暂无符合正式条件的数据", REPEATED_PASSES_REQUIRED: "当前方位不足两次独立经过", ANALYSIS_NOT_CONFIGURED: "待选择分析配置",
  SOURCE_QUALITY_NOT_FORMAL: "原始质量条件不满足正式纳入，保留诊断查看", REPEAT_COUNT_INSUFFICIENT: "当前方位不足两次独立经过", REPEAT_TIME_GRID_MISMATCH: "重复经过的时长或时间网格不一致", COMPARABLE_HISTORY_NOT_ANALYZED: "尚无已分析的可比历史批次", BOUNDARY_QUALITY_REVIEW_REQUIRED:"可疑边界或平台需复核", AZIMUTH_PLAN_CONFLICT:"方位不能唯一匹配计划", TARGET_BAND_NOT_CONFIGURED:"未配置有来源的结构目标频带", NO_ELIGIBLE_SEGMENT: "当前集合没有可纳入的连续片段",
  RSSI_ZERO_SUSPECT: "回波零值仅标记为疑点，未自动判为无效", CLOCK_REFERENCE_MISSING: "缺少事件与样本的时钟映射", PASS_EVENT_MISSING: "缺少完整的进入或离开事件", RECORDING_INCOMPLETE: "原始记录尚未完整保存", SOURCE_SAMPLE_CLOCK_GAP: "原始样本时钟存在缺口", GEOMETRY_CONVENTION_REQUIRED: "几何坐标与方向约定尚未核验", MEASUREMENT_INPUT_CONFLICT: "测量输入与保存快照冲突", DUPLICATE_CAPTURE_REQUIRES_SELECTION: "同次采集存在多个版本，请明确选择", SOURCE_CHANGED_DURING_ANALYSIS: "分析期间原始来源发生变化，需要重新分析", REPEAT_COUNT_OR_GRID_INSUFFICIENT: "重复次数不足或时间网格不一致", NOTCH_EVIDENCE_REQUIRED: "陷波缺少已核验干扰依据",
};
export const array = <T = AnalysisJson>(value: unknown): T[] => Array.isArray(value) ? value : [];
export const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
export const numeric = (value: unknown): number | null => finite(value) ? value : null;
export const label = (value: unknown): string => typeof value === "string" ? value : "";
export const valueText = (value: unknown, digits = 3) => finite(value) ? Number(value.toPrecision(6)).toLocaleString("zh-CN", { maximumFractionDigits: digits }) : "—";
export function epochMs(value: unknown): number | null {
  if (finite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") { const time = Date.parse(value); return Number.isFinite(time) ? time : null; }
  return null;
}
export const dateText = (value: unknown) => { const time = epochMs(value); return time === null ? "未记录" : new Date(time).toLocaleString("zh-CN", { hour12: false }); };
export const reasonText = (code: unknown) => reasonNames[label(code)] || label(code) || "当前条件不足";
export function issueCodes(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.flatMap(item => typeof item === "string" ? [item] : issueCodes(item)))];
  if (!value || typeof value !== "object") return [];
  const item = value as AnalysisJson;
  return [...new Set([...(typeof item.code === "string" ? [item.code] : []), ...array<string>(item.reasonCodes), ...array<string>(item.reason_codes), ...array<string>(item.issues), ...issueCodes(item.status), ...issueCodes(item.quality_assessment)])];
}
export function taskHasFormalData(task: AnalysisTask): boolean {
  return task.records.some(record => { const q = record.sourceQuality || {}; return typeof q.source_flags_allow_formal_review === "boolean" ? q.source_flags_allow_formal_review : q.diagnostic_only === false && q.valid_measurement === true && q.identity_verified === true; });
}
export function pointsForTask(task?: AnalysisTask): AnalysisPoint[] {
  if (!task) return [];
  const map = new Map<string, AnalysisPoint>();
  for (const point of task.plannedPoints || []) {
    if (!point.bladeId || !point.radialPointName) continue;
    const key = JSON.stringify([point.bladeId, point.radialPointName]);
    const existing = map.get(key);
    if (existing) { if (finite(point.azimuthDeg) && !existing.plannedAzimuths.includes(point.azimuthDeg)) existing.plannedAzimuths.push(point.azimuthDeg); if (finite(existing.radiusM) && finite(point.radiusM) && Math.abs(existing.radiusM - point.radiusM) > 1e-9) { existing.radiusConflict = true; existing.radiusM = null; } }
    else map.set(key, { key, bladeId: point.bladeId, name: point.radialPointName, radiusM: numeric(point.radiusM), records: [], plannedAzimuths: finite(point.azimuthDeg) ? [point.azimuthDeg] : [] });
  }
  for (const blade of task.plan?.blades || []) for (const point of blade.points || []) {
    const key = JSON.stringify([blade.bladeId, point.name]);
    map.set(key, { key, bladeId: blade.bladeId, name: point.name, radiusM: numeric(point.radiusM), records: [], plannedAzimuths: array<number>(point.azimuths).filter(finite) });
  }
  for (const record of task.records) {
    const bladeId = label(record.bladeId) || "未标注叶片", name = label(record.pointName) || "未标注测点", key = JSON.stringify([bladeId, name]);
    let point = map.get(key);
    if (!point) { point = { key, bladeId, name, radiusM: numeric(record.radiusM), records: [], plannedAzimuths: [] }; map.set(key, point); }
    point.records.push(record);
    if (!point.radiusConflict && finite(point.radiusM) && finite(record.radiusM) && Math.abs(point.radiusM - record.radiusM) > 1e-9) { point.radiusConflict = true; point.radiusM = null; }
    if (!point.radiusConflict && point.radiusM === null) point.radiusM = numeric(record.radiusM);
    point.plannedAzimuths = [...new Set([...point.plannedAzimuths, ...array<number>(record.plannedAzimuths).filter(finite)])].sort((a, b) => a - b);
  }
  return [...map.values()].sort((a, b) => a.bladeId.localeCompare(b.bladeId, "zh-CN", { numeric: true }) || (a.radiusM ?? Infinity) - (b.radiusM ?? Infinity) || a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
}
export function bundleFor(report: AnalysisReport | null, recordingId?: string): AnalysisJson | undefined { return report?.records.find(item => item.recording_id === recordingId); }
export function representativeFor(bundle?: AnalysisJson): AnalysisJson | undefined { return array(bundle?.segments).find(item => item.result_id === (bundle?.representative ?? bundle?.record?.representative)); }
export function aggregatesFor(report: AnalysisReport | null, layer?: string): AnalysisJson[] { return array(report?.aggregates).filter(item => !layer || item.layer === layer); }
export function aggregateFor(report: AnalysisReport | null, point: AnalysisPoint | undefined, layer?: string): AnalysisJson | undefined {
  if (!point || point.radiusConflict) return undefined;
  const matches = aggregatesFor(report, layer).filter(item => String(item.blade) === point.bladeId && String(item.point) === point.name);
  // Multiple comparison/configuration groups are never silently merged by the UI.
  return matches.length === 1 ? matches[0] : undefined;
}
export function pointCounts(point: AnalysisPoint, report: AnalysisReport | null) {
  const records = point.records.map(item => bundleFor(report, item.id)).filter(Boolean) as AnalysisJson[];
  return { saved: point.records.length, analyzable: records.filter(item => item.quality_assessment?.analysis_eligible === true).length,
    formal: records.filter(item => !!item.representative && item.source_quality?.source_flags_allow_formal_review === true).length,
    measuredAngles: [...new Set(point.records.map(item => item.azimuthDeg).filter(finite))],
    review: records.filter(item => item.quality_assessment?.analysis_eligible !== true).length };
}
export function resultEvents(report: AnalysisReport | null, task?: AnalysisTask): AnalysisJson[] {
  const result = new Map<string, AnalysisJson>();
  for (const bundle of report?.records || []) {
    const meta = task?.records.find(item => item.id === bundle.recording_id);
    const events: AnalysisJson[] = [...array(bundle.quality_events), ...array(bundle.segments).flatMap(segment => array(segment.events).map(event => ({ ...event, segment_id: segment.segment_id, result_id: segment.result_id })))];
    for (const [index, event] of events.entries()) {
      const id = event.id || JSON.stringify([bundle.recording_id, event.segment_id, event.code, event.source_start, event.source_end, event.peak_source_index, event.message]);
      if (!result.has(id)) result.set(id, { ...event, id, recording_id: bundle.recording_id, meta });
    }
  }
  return [...result.values()];
}
export function chartUnavailable(report: AnalysisReport | null, id: string, fallback: string) {
  const availability = report?.chartAvailability?.[id] ?? report?.chart_availability?.[id];
  if (typeof availability === "string") return reasonText(availability);
  if (!availability || availability.status === "ready" || fallback.includes("暂无通过逐条")) return fallback;
  const known = issueCodes(availability).filter(code => reasonNames[code]);
  return known.length ? known.map(reasonText).join("；") : fallback || label(availability?.message);
}
export function plotPairs(x: unknown, y: unknown, factor = 1): [number, number | null][] {
  const xs = array<unknown>(x), ys = array<unknown>(y);
  return xs.flatMap((value, index) => finite(value) ? [[value, finite(ys[index]) ? (ys[index] as number) * factor : null] as [number, number | null]] : []);
}
export function spectrumPairs(spectrum: AnalysisJson | undefined, type: "fft" | "psd") {
  return type === "fft" ? plotPairs(spectrum?.fft_frequency_hz, spectrum?.fft_peak_amplitude_m_s, 1000)
    : plotPairs(spectrum?.psd_frequency_hz ?? spectrum?.frequency_hz, spectrum?.psd_m2_s2_per_hz, 1e6);
}
export function orderedRecords(point: AnalysisPoint | undefined): AnalysisCatalogRecord[] {
  return [...(point?.records || [])].sort((a, b) => (a.azimuthDeg ?? Infinity) - (b.azimuthDeg ?? Infinity) || (epochMs(a.createdAt) ?? 0) - (epochMs(b.createdAt) ?? 0) || a.id.localeCompare(b.id));
}
