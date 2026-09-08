"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImportError = void 0;
exports.normalizeImportTask = normalizeImportTask;
exports.normalizeImportRequest = normalizeImportRequest;
exports.createImportJob = createImportJob;
exports.importView = importView;
exports.advanceImport = advanceImport;
exports.decodeImportFile = decodeImportFile;
exports.csvImportRecord = csvImportRecord;
const task_metadata_1 = require("./task-metadata.cjs");
class ImportError extends Error {
    status;
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}
exports.ImportError = ImportError;
const clone = (value) => JSON.parse(JSON.stringify(value));
const taskFields = ["name", "object", "turbine", "point", "direction", "rpm", "blades", "sampleRate", "range", "duration", "condition", "note", "samples", "channels", "segments", "testTime", "environment", "faultType"];
function normalizeImportTask(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new ImportError("每条任务须为 JSON 对象");
    const raw = input;
    if (raw.schema || raw.snapshot || raw.result)
        throw new ImportError("这不是任务记录；请使用任务记录 JSON，而非结果数据集或备份");
    const task = Object.fromEntries(taskFields.filter((key) => raw[key] !== undefined).map((key) => [key, clone(raw[key])]));
    for (const [key, label] of [["name", "任务名"], ["object", "测试对象"], ["turbine", "风机编号"], ["point", "测点"]]) {
        if (typeof task[key] !== "string" || !task[key].trim() || task[key].length > 200)
            throw new ImportError(`${label}不能为空且不能超过 200 字`);
        task[key] = task[key].trim();
    }
    for (const key of ["rpm", "blades", "sampleRate"])
        if (!Number.isFinite(task[key]) || task[key] < 0 ||
            (key === "blades" && (!Number.isInteger(task[key]) || task[key] < 1)) || (key === "sampleRate" && task[key] < 1))
            throw new ImportError("转速须非负，叶片数须为正整数，采样率须大于等于 1 Hz");
    if (task.duration !== undefined && (!Number.isFinite(task.duration) || task.duration < 0))
        throw new ImportError("任务时长须为非负数");
    if (task.samples !== undefined && (!Array.isArray(task.samples) || task.samples.length > 20000 || task.samples.some((value) => typeof value !== "number" || !Number.isFinite(value))))
        throw new ImportError("波形须为最多 20000 个有限数值，不接受空值或数值字符串");
    for (const key of ["direction", "condition"])
        if (task[key] !== undefined && (typeof task[key] !== "string" || task[key].length > 200))
            throw new ImportError("方向与工况须为不超过 200 字的文本");
    if (task.range !== undefined && (!Number.isFinite(task.range) || task.range <= 0))
        throw new ImportError("量程须为正数");
    const metadataError = (0, task_metadata_1.validateTaskMetadata)(task);
    if (metadataError)
        throw new ImportError(metadataError);
    const warnings = [];
    if (task.samples?.length) {
        const duration = task.samples.length / task.sampleRate;
        if (task.duration !== undefined && Math.abs(task.duration - duration) > 1e-9)
            warnings.push(`时长按 ${task.samples.length} 点 / ${task.sampleRate} Hz 校正为 ${duration} s`);
        task.duration = duration;
    }
    else {
        if (task.duration === undefined)
            throw new ImportError("无波形任务必须填写时长");
        warnings.push("仅导入任务元信息，未包含波形");
    }
    if (!task.channels?.length)
        warnings.push("未注明波形通道与单位，请导入后补充元信息");
    task.source = raw.source === "demo" ? "demo" : "import";
    task.status = "本地";
    task.raw_preserved = !!task.samples?.length;
    return { task, warnings };
}
function normalizeImportRequest(body) {
    if (!body || typeof body.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.id) || typeof body.filename !== "string" || !body.filename.trim() || body.filename.length > 180)
        throw new ImportError("导入文件名或批次标识无效");
    if (!Array.isArray(body.records) || !body.records.length || body.records.length > 50)
        throw new ImportError("一次须导入 1～50 条任务记录");
    if (new TextEncoder().encode(JSON.stringify(body.records)).length > 1_500_000)
        throw new ImportError("导入数据超过 1.5 MB，请拆分文件", 413);
    return { id: body.id, filename: body.filename.trim(), records: clone(body.records) };
}
function createImportJob(request, now = new Date().toISOString()) {
    return { id: request.id, name: request.filename, filename: request.filename, createdAt: now, updatedAt: now, items: request.records.map((input, index) => {
            const name = typeof input?.name === "string" ? input.name.slice(0, 200) : `第 ${index + 1} 条`;
            try {
                const prepared = normalizeImportTask(input);
                return { index, name: prepared.task.name, input: clone(input), ...prepared, state: "pending" };
            }
            catch (error) {
                return { index, name, input: clone(input), state: "invalid", warnings: [], error: error.message };
            }
        }) };
}
function importView(job) {
    const { requestHash: _, items, ...info } = job;
    return { ...info, items: items.map(({ input: _, task, ...entry }) => ({ ...entry, object: task?.object || "—", point: task?.point || "—", sampleRate: task?.sampleRate ?? null, sampleCount: task?.samples?.length || 0, duration: task?.duration ?? null, unit: task?.channels?.[0]?.unit || "未注明" })), completed: items.filter((item) => item.state === "completed").length, invalid: items.filter((item) => item.state === "invalid").length, pending: items.filter((item) => item.state === "pending").length, total: items.length };
}
function advanceImport(job, index, taskId, now = new Date().toISOString()) {
    if (!Number.isInteger(index) || index < 0 || index >= job.items.length)
        throw new ImportError("请选择导入批次中的有效条目");
    const original = job.items[index];
    if (original.state === "completed")
        return { job, task: null, replayed: true };
    if (original.state === "invalid" || !original.task)
        throw new ImportError(original.error || "此项校验未通过，请修正文件后新建导入批次");
    const next = clone(job), entry = next.items[index];
    entry.state = "completed";
    entry.taskId = taskId;
    entry.importedAt = now;
    next.updatedAt = now;
    const task = { ...clone(original.task), id: taskId, updatedAt: now, importOrigin: { batchId: job.id, itemIndex: index, filename: job.filename, importedAt: now } };
    return { job: next, task, replayed: false };
}
/** Minimal RFC-style delimited reader, including quoted metadata JSON and embedded newlines. */
function csvRows(text) {
    const first = text.split(/\r?\n/, 1)[0], delimiter = first.includes(",") ? "," : first.includes("\t") ? "\t" : first.includes(";") ? ";" : ",";
    const rows = [];
    let row = [], value = "", quoted = false, closed = false;
    const cell = () => { row.push(value.trim()); value = ""; closed = false; };
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (quoted) {
            if (char === '"') {
                if (text[i + 1] === '"') {
                    value += '"';
                    i++;
                }
                else {
                    quoted = false;
                    closed = true;
                }
            }
            else
                value += char;
        }
        else if (char === delimiter)
            cell();
        else if (char === "\n" || char === "\r") {
            cell();
            if (row.some((v) => v))
                rows.push(row);
            row = [];
            if (char === "\r" && text[i + 1] === "\n")
                i++;
        }
        else if (char === '"' && !value.trim() && !closed) {
            quoted = true;
            value = "";
        }
        else if (closed && char.trim())
            throw new ImportError("CSV 引号后有无效内容");
        else
            value += char;
    }
    if (quoted)
        throw new ImportError("CSV 引号未闭合");
    cell();
    if (row.some((v) => v))
        rows.push(row);
    return rows;
}
function decodeImportFile(text, filename) {
    if (new TextEncoder().encode(text).length > 1_500_000)
        throw new ImportError("单个文件不能超过 1.5 MB");
    text = text.replace(/^\uFEFF/, "");
    if (/\.json$/i.test(filename)) {
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            throw new ImportError("JSON 格式无效，请检查括号、逗号和引号");
        }
        const records = Array.isArray(parsed) ? parsed : [parsed];
        if (!records.length || records.length > 50)
            throw new ImportError("JSON 须包含 1～50 条任务");
        return { format: "json", records };
    }
    if (!/\.csv$/i.test(filename))
        throw new ImportError("请选择 JSON 或 CSV 文件");
    const rows = csvRows(text);
    let metadata = {};
    if (rows[0]?.[0] === "# BladeVMS dataset-v1") {
        let info;
        try {
            info = JSON.parse(rows[1]?.[1]);
        }
        catch {
            throw new ImportError("CSV 元信息 JSON 无效");
        }
        if (!info || info.schema !== "blade-vms/dataset-v1" || info.columns?.length !== 2 || info.columns[0].key !== "time" || info.columns[0].unit !== "s" || info.columns[1].key !== "value" || !info.metadata?.task || typeof info.metadata.task !== "object" || Array.isArray(info.metadata.task))
            throw new ImportError("此 CSV 不是任务原始波形，不能把频谱或特征结果当作原始数据导入");
        metadata = info.metadata.task;
        rows.splice(0, 2);
    }
    if (rows[0]?.every((value) => value && !Number.isFinite(Number(value))))
        rows.shift();
    if (!rows.length || rows.length > 20000 || ![1, 2].includes(rows[0].length))
        throw new ImportError("CSV 须为 1～20000 行的一列幅值或时间/幅值两列");
    const columns = rows[0].length;
    const data = rows.map((row, i) => { if (row.length !== columns || row.some((value) => !value || !Number.isFinite(Number(value))))
        throw new ImportError(`CSV 第 ${i + 1} 条数据有空值、非数值或列数不一致`); return row.map(Number); });
    return { format: "csv", samples: data.map((row) => row[columns - 1]), ...(columns === 2 ? { times: data.map((row) => row[0]) } : {}), metadata };
}
function csvImportRecord(file, metadata) {
    const rate = metadata.sampleRate;
    if (!Number.isFinite(rate) || rate < 1)
        throw new ImportError("请确认 CSV 采样率，须大于等于 1 Hz");
    if (file.times?.some((time, i) => Math.abs(time - i / rate) > Math.max(1e-6, .001 / rate)))
        throw new ImportError("CSV 时间列须从 0 开始，并与确认的采样率一致；不会静默丢弃时间或重新采样");
    return { ...metadata, samples: file.samples, duration: file.samples.length / rate, source: file.metadata.source === "demo" ? "demo" : "import" };
}
