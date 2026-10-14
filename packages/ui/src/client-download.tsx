"use client";
import React, { useEffect, useState } from "react";
import { Download, LoaderCircle, Monitor } from "lucide-react";
import { Button, Dialog, Tag } from "./common";

type DesktopDownload = {
  version: string | null;
  filename: string | null;
  size: number | null;
  available: boolean;
  url: string | null;
};

function DownloadDialog({ onClose }: { onClose: () => void }) {
  const [release, setRelease] = useState<DesktopDownload | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setRelease(null);
    setError(false);
    fetch("/api/desktop-download", { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("Download information unavailable");
        return response.json() as Promise<DesktopDownload>;
      })
      .then(setRelease)
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [attempt]);

  return <Dialog title="下载客户端" onClose={onClose}>
    <div className="client-download-intro">
      <span className="client-download-icon"><Monitor size={24} aria-hidden="true" /></span>
      <div><h3>BladeVMS 桌面端</h3><p>设备数据采集与实时分析</p></div>
    </div>
    <div className="client-download-content" aria-live="polite" aria-busy={!release && !error}>
      {error ? <div className="client-download-feedback">
        <p>暂时无法获取安装包信息，请重试。</p>
        <Button onClick={() => setAttempt(value => value + 1)}>重新加载</Button>
      </div> : !release ? <div className="client-download-feedback"><LoaderCircle size={18} className="spin" aria-hidden="true" /><span>正在获取安装包…</span></div> : <>
        <div className="client-download-package">
          <div className="client-download-package-info">
            <strong>Windows <span>x64</span></strong>
            <p>{[
              release.version ? `v${release.version}` : null,
              release.available ? ".exe 安装包" : "安装包暂未提供",
              release.size !== null && release.available ? `${(release.size / 1024 / 1024).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} MB` : null,
            ].filter(Boolean).join(" · ")}</p>
          </div>
          {release.available && release.url ? <a className="btn primary client-download-link" href={release.url} download={release.filename || undefined} target="_blank" rel="noopener noreferrer"><Download size={15} aria-hidden="true" />下载安装包</a> : <Tag tone="gray">暂不可用</Tag>}
        </div>
        <p className="client-download-note">macOS 安装包暂未提供</p>
      </>}
    </div>
  </Dialog>;
}

export function ClientDownload() {
  const [open, setOpen] = useState(false);
  return <>
    <Button className="client-download-trigger" aria-label="下载客户端" title="下载客户端" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <Download size={16} aria-hidden="true" /><span>下载客户端</span>
    </Button>
    {open && <DownloadDialog onClose={() => setOpen(false)} />}
  </>;
}
