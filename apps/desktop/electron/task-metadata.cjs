"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.channelTypes = void 0;
exports.validateTaskMetadata = validateTaskMetadata;
exports.taskMetadata = taskMetadata;
exports.channelTypes = ["displacement", "velocity", "acceleration", "keyphasor", "other"];
/** Validate descriptive metadata only; never infer sensor units or measurement results. */
function validateTaskMetadata(data) {
    for (const key of ["environment", "faultType", "note"])
        if (data[key] !== undefined && (typeof data[key] !== "string" || data[key].length > 2000))
            return "环境、故障类型和备注须为不超过 2000 字的文本";
    if (data.testTime !== undefined && data.testTime !== "" &&
        (typeof data.testTime !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(data.testTime) || !Number.isFinite(Date.parse(data.testTime))))
        return "测试时间必须是包含时区的 ISO 日期时间";
    if (data.channels !== undefined) {
        if (!Array.isArray(data.channels) || data.channels.length > 16)
            return "通道列表最多包含 16 个通道";
        const seen = new Set();
        for (const ch of data.channels) {
            if (!ch || !Number.isInteger(ch.no) || ch.no < 1 || ch.no > 256 || seen.has(ch.no) ||
                !exports.channelTypes.includes(ch.type) || typeof ch.unit !== "string" || !ch.unit.trim() || ch.unit.length > 30)
                return "通道编号须为 1～256 的不重复整数，并填写信号类型和单位";
            seen.add(ch.no);
        }
    }
    return null;
}
function taskMetadata(task) {
    const { samples, ...metadata } = task;
    return {
        ...metadata,
        raw_preserved: Array.isArray(samples) && samples.length > 0,
        sample_count: Array.isArray(samples) ? samples.length : 0,
        waveform_layout: "single-column amplitude; time = sample index / sampleRate",
    };
}
