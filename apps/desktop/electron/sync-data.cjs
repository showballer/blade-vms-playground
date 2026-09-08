"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stableJson = stableJson;
/** Stable JSON for revision identifiers; no tokens or server settings belong here. */
function stableJson(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return "[" + value.map(stableJson).join(",") + "]";
    return "{" + Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
}
