import React from "react";
import { LoaderCircle } from "lucide-react";

/** Reserves chart space so a pending read cannot be mistaken for an empty signal. */
export function ChartLoading({ label = "正在加载图表…", height = 240 }: { label?: string; height?: React.CSSProperties["minHeight"] }) {
  return <div role="status" aria-live="polite" className="chart-loading" style={{ minHeight: height, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--text-muted, #67758a)", background: "var(--bg-muted, #f7f9fc)", borderRadius: 8 }}>
    <LoaderCircle className="spin" size={20} aria-hidden="true" /><span>{label}</span>
  </div>;
}
