"use client";
import React, { useEffect, useRef, useState } from "react";
import { X, LoaderCircle, Download, Search } from "lucide-react";
import { api, download, isOffline, type Item } from "./api";
import { CustomSelect } from "./custom-select";
export { CustomSelect } from "./custom-select";
export function Button({
  children,
  variant = "outline",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "success" | "danger" | "cyan" | "ghost";
}) {
  return (
    <button {...props} className={`btn ${variant} ${className}`}>
      {children}
    </button>
  );
}
export function Card({
  title,
  tools,
  children,
  className = "",
}: {
  title?: string;
  tools?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <div className="card-heading">
          <h2>{title}</h2>
          {tools}
        </div>
      )}
      {children}
    </section>
  );
}
export function Tag({
  children,
  tone = "blue",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={`tag ${tone}`}>{children}</span>;
}
export function Select({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label?: string;
  options: (string | { value: string; label: string })[];
  value: string | number;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const current = String(value ?? "");
  const known = options.some((o) => (typeof o === "string" ? o : o.value) === current);
  return (
    <label className="inline-field">
      {label && <span>{label}</span>}
      <CustomSelect
        aria-label={label}
        disabled={disabled}
        value={current}
        onChange={(e) => onChange(e.target.value)}
      >
        {!known && <option value={current}>{current || "未选择"}</option>}
        {options.map((o) =>
          typeof o === "string" ? (
            <option key={o}>{o}</option>
          ) : (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ),
        )}
      </CustomSelect>
    </label>
  );
}
export function Tabs({
  items,
  value,
  onChange,
}: {
  items: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === value}
          className={t.id === value ? "active" : ""}
          onClick={() => onChange(t.id)}
        >
          {t.name}
        </button>
      ))}
    </div>
  );
}
export function Empty({ text = "暂无数据" }: { text?: string }) {
  return <div className="empty">{text}</div>;
}
export function Progress({
  value,
  color = "green",
}: {
  value: number;
  color?: string;
}) {
  return (
    <div className="progress">
      <span
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        className={color}
      />
    </div>
  );
}
export function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={wide ? "dialog wide" : "dialog"}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <Button variant="ghost" aria-label="关闭弹窗" onClick={onClose}>
          <X size={18} />
        </Button>
      </div>
      {children}
    </dialog>
  );
}
export type Field = {
  key: string;
  label: string;
  type?: "text" | "number" | "password" | "textarea" | "select" | "checkbox";
  options?: string[] | { value: string; label: string }[];
  required?: boolean;
  min?: number;
  max?: number;
  placeholder?: string;
  emptyAsUndefined?: boolean;
};
export function EditDialog({
  title,
  fields,
  initial = {},
  onClose,
  onSave,
}: {
  title: string;
  fields: Field[];
  initial?: Record<string, any>;
  onClose: () => void;
  onSave: (v: Record<string, any>) => Promise<void>;
}) {
  const [values, setValues] = useState(initial),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await onSave(values);
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          {fields.map((f) => (
            <label
              key={f.key}
              className={`form-field ${f.type === "textarea" ? "span-2" : ""}`}
            >
              <span>
                {f.label}
                {f.required && <em> *</em>}
              </span>
              {f.type === "select" ? (
                <CustomSelect
                  aria-label={f.label}
                  value={values[f.key] ?? ""}
                  onChange={(e) =>
                    setValues({ ...values, [f.key]: e.target.value })
                  }
                  required={f.required}
                >
                  <option value="" disabled>
                    请选择
                  </option>
                  {values[f.key] && !f.options?.some((o) => (typeof o === "string" ? o : o.value) === values[f.key]) && <option value={values[f.key]}>{values[f.key]}</option>}
                  {f.options?.map((o) =>
                    typeof o === "string" ? (
                      <option key={o}>{o}</option>
                    ) : (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ),
                  )}
                </CustomSelect>
              ) : f.type === "textarea" ? (
                <textarea
                  required={f.required}
                  value={values[f.key] || ""}
                  onChange={(e) =>
                    setValues({ ...values, [f.key]: e.target.value })
                  }
                  rows={3}
                />
              ) : f.type === "checkbox" ? (
                <input
                  type="checkbox"
                  checked={!!values[f.key]}
                  onChange={(e) =>
                    setValues({ ...values, [f.key]: e.target.checked })
                  }
                />
              ) : (
                <input
                  type={f.type || "text"}
                  value={values[f.key] ?? ""}
                  min={f.min}
                  max={f.max}
                  step={f.type === "number" ? "any" : undefined}
                  placeholder={f.placeholder}
                  required={f.required}
                  onChange={(e) =>
                    setValues({
                      ...values,
                      [f.key]:
                        f.type === "number"
                          ? f.emptyAsUndefined && e.target.value === "" ? undefined : Number(e.target.value)
                          : e.target.value,
                    })
                  }
                />
              )}
            </label>
          ))}
        </div>
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={busy}>
            {busy ? <LoaderCircle size={15} className="spin" /> : null}保存
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
export function Confirm({
  title,
  message,
  onClose,
  onConfirm,
}: {
  title: string;
  message: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Dialog title={title} onClose={onClose}>
      <p className="dialog-message">{message}</p>
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <Button onClick={onClose}>取消</Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
            }
          }}
        >
          确认
        </Button>
      </div>
    </Dialog>
  );
}
export function ExportButton({
  kind,
  id,
  notify,
  formats = ["csv", "txt", "xlsx", "json"],
}: {
  kind: string;
  id?: string;
  notify: (s: string) => void;
  formats?: string[];
}) {
  const [fmt, setFmt] = useState(formats[0]);
  return (
    <div className="joined">
      <CustomSelect
        aria-label="导出格式"
        value={fmt}
        onChange={(e) => setFmt(e.target.value)}
      >
        {formats
          .filter((f) => !isOffline() || f !== "xlsx")
          .map((f) => (
            <option key={f} value={f}>
              {f.toUpperCase()}
            </option>
          ))}
      </CustomSelect>
      <Button
        onClick={async () => {
          try {
            const saved = await download(`export/${kind}${id ? "/" + id : ""}?format=${fmt}`);
            notify(saved ? "已导出文件" : "已取消导出");
          } catch (e) {
            notify((e as Error).message);
          }
        }}
      >
        <Download size={14} />
        导出
      </Button>
    </div>
  );
}
export function Filter({
  value,
  onChange,
  placeholder = "搜索",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="search">
      <Search size={15} />
      <input
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
export function Table({
  headers,
  children,
}: {
  headers: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
export type ContextProps = {
  initialTaskId?: string;
  onTaskChange?: (task: Item | undefined) => void;
  data: any;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
  canWrite: boolean;
  go: (s: string, context?: { taskId: string }) => void;
};
export async function saveRecord(
  kind: string,
  value: Record<string, any>,
  id?: string,
) {
  return api(
    `records/${kind}${id ? "/" + id : ""}`,
    id ? "PUT" : "POST",
    value,
  );
}
