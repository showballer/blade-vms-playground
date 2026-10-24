"use client";
import React, { Children, Fragment, forwardRef, isValidElement, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

/** Single-select replacement. The native element is retained only for forms and change events. */
export type CustomSelectProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "multiple" | "size"> & { multiple?: false; size?: 1; searchable?: boolean; searchPlaceholder?: string };
type Choice = { value: string; label: string; disabled: boolean; hidden: boolean; index: number };
type ChoiceGroup = { label?: string; choices: Choice[] };
const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function nodeText(node: React.ReactNode): string {
  return Children.toArray(node).map(child => typeof child === "string" || typeof child === "number" ? String(child) : isValidElement<{ children?: React.ReactNode }>(child) ? nodeText(child.props.children) : "").join("");
}
function collectChoices(children: React.ReactNode): { choices: Choice[]; groups: ChoiceGroup[] } {
  const choices: Choice[] = [], groups: ChoiceGroup[] = [];
  function visit(nodes: React.ReactNode, group?: ChoiceGroup, groupDisabled = false) {
    Children.forEach(nodes, child => {
      if (!isValidElement<Record<string, any>>(child)) return;
      if (child.type === Fragment) { visit(child.props.children, group, groupDisabled); return; }
      if (child.type === "optgroup") {
        const next: ChoiceGroup = { label: String(child.props.label || ""), choices: [] };
        groups.push(next); visit(child.props.children, next, groupDisabled || Boolean(child.props.disabled));
      } else if (child.type === "option") {
        const text = nodeText(child.props.children), label = child.props.label == null ? text : String(child.props.label);
        const choice = { value: child.props.value == null ? text : String(child.props.value), label, disabled: groupDisabled || Boolean(child.props.disabled), hidden: Boolean(child.props.hidden), index: choices.length };
        choices.push(choice);
        if (group) group.choices.push(choice);
        else { const last = groups.at(-1); if (last && last.label === undefined) last.choices.push(choice); else groups.push({ choices: [choice] }); }
      }
    });
  }
  visit(children);
  return { choices, groups };
}

export const CustomSelect = forwardRef<HTMLSelectElement, CustomSelectProps>(function CustomSelect({
  children, value, defaultValue, onChange, onInvalid, onFocus, className = "", style, id, disabled = false,
  required, tabIndex, autoFocus, multiple: _multiple, size: _size, searchable = false, searchPlaceholder = "搜索选项", ...props
}, forwardedRef) {
  const generatedId = useId(), triggerId = id || `custom-select-${generatedId}`, listId = `${triggerId}-listbox`, errorId = `${triggerId}-error`;
  const rootRef = useRef<HTMLSpanElement>(null), nativeRef = useRef<HTMLSelectElement>(null), triggerRef = useRef<HTMLButtonElement>(null), popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null), listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  useImperativeHandle(forwardedRef, () => nativeRef.current!, []);
  const { choices, groups } = useMemo(() => collectChoices(children), [children]);
  const [uncontrolledValue, setUncontrolledValue] = useState(() => String(defaultValue ?? choices.find(choice => !choice.disabled)?.value ?? ""));
  const controlled = value !== undefined, currentValue = controlled ? String(value ?? "") : uncontrolledValue;
  const selected = choices.find(choice => choice.value === currentValue) ?? choices.find(choice => !choice.disabled);
  const [open, setOpen] = useState(false), [activeIndex, setActiveIndex] = useState(-1), [inheritedDisabled, setInheritedDisabled] = useState(false);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null), [validationMessage, setValidationMessage] = useState("");
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 320 });
  const typeahead = useRef({ text: "", time: 0 });
  const isDisabled = disabled || inheritedDisabled;
  const terms = searchable ? query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean) : [];
  const visible = choices.filter(choice => !choice.hidden && terms.every(term => choice.label.toLocaleLowerCase().includes(term)));
  const enabled = visible.filter(choice => !choice.disabled);
  const longestLabel = choices.reduce((longest, choice) => choice.label.length > longest.length ? choice.label : longest, "");
  const ariaProps = Object.fromEntries(Object.entries(props).filter(([key]) => key.startsWith("aria-"))) as React.AriaAttributes;

  const close = useCallback((restoreFocus = false) => {
    setOpen(false); setQuery(""); typeahead.current = { text: "", time: 0 };
    if (restoreFocus && !triggerRef.current?.matches(":disabled")) triggerRef.current?.focus({ preventScroll: true });
  }, []);
  const blocked = () => Boolean(disabled || nativeRef.current?.matches(":disabled"));
  function openList(edge?: "first" | "last") {
    if (blocked() || !choices.length) return;
    setQuery("");
    setPortalHost(triggerRef.current?.closest("dialog") || document.body);
    setActiveIndex((edge === "first" ? enabled[0] : edge === "last" ? enabled.at(-1) : enabled.find(choice => choice.index === selected?.index) ?? enabled[0])?.index ?? -1);
    setOpen(true);
  }
  function choose(choice?: Choice) {
    if (!choice || choice.disabled || choice.hidden || blocked()) return;
    const native = nativeRef.current;
    if (native && native.value !== choice.value) {
      native.value = choice.value;
      // React receives a real select change event, preserving target/currentTarget and form libraries.
      native.dispatchEvent(new Event("change", { bubbles: true }));
    }
    close(true);
  }

  useClientLayoutEffect(() => {
    const native = nativeRef.current;
    if (!native) return;
    const sync = () => {
      const nextDisabled = native.matches(":disabled"); setInheritedDisabled(nextDisabled);
      if (nextDisabled) close();
    };
    sync();
    const observer = new MutationObserver(sync);
    const ancestors: Element[] = []; let ancestor = native.parentElement;
    while (ancestor) { if (ancestor.tagName === "FIELDSET") ancestors.push(ancestor); ancestor = ancestor.parentElement; }
    ancestors.forEach(fieldset => observer.observe(fieldset, { attributes: true, attributeFilter: ["disabled"] }));
    return () => observer.disconnect();
  }, [disabled, close]);
  useEffect(() => {
    const native = nativeRef.current, form = native?.form;
    if (!native || !form) return;
    const reset = (event: Event) => queueMicrotask(() => {
      if (event.defaultPrevented || !native.isConnected) return;
      if (controlled) native.value = currentValue; else setUncontrolledValue(native.value);
      setValidationMessage(""); close();
    });
    form.addEventListener("reset", reset);
    return () => form.removeEventListener("reset", reset);
  }, [controlled, currentValue, close, props.form]);
  useClientLayoutEffect(() => {
    const native = nativeRef.current;
    if (native && !controlled && native.value !== uncontrolledValue) setUncontrolledValue(native.value);
    if (native?.validity.valid) setValidationMessage("");
  }, [choices, controlled, currentValue, uncontrolledValue]);
  useEffect(() => {
    if (open && !enabled.some(choice => choice.index === activeIndex)) {
      setActiveIndex(enabled.find(choice => choice.index === selected?.index)?.index ?? enabled[0]?.index ?? -1);
    }
  }, [open, choices, activeIndex, query]);
  useEffect(() => { if (autoFocus && !blocked()) triggerRef.current?.focus(); }, [autoFocus]);

  useClientLayoutEffect(() => {
    if (!open || !popupRef.current || !triggerRef.current) return;
    const popup = popupRef.current, trigger = triggerRef.current;
    // Popovers join the browser top layer, including inside modal dialogs, without clipping.
    if (typeof popup.showPopover === "function") { try { popup.showPopover(); } catch { popup.removeAttribute("popover"); } }
    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = trigger.getBoundingClientRect(), viewport = window.visualViewport;
      const leftEdge = viewport?.offsetLeft || 0, topEdge = viewport?.offsetTop || 0;
      const rightEdge = leftEdge + (viewport?.width || window.innerWidth), bottomEdge = topEdge + (viewport?.height || window.innerHeight);
      const gap = 6, margin = 8, availableBelow = Math.max(0, bottomEdge - rect.bottom - gap - margin), availableAbove = Math.max(0, rect.top - topEdge - gap - margin);
      const desired = Math.min(320, popup.scrollHeight || 320), upward = availableBelow < desired && availableAbove > availableBelow;
      const maxHeight = Math.min(320, upward ? availableAbove : availableBelow), width = Math.min(Math.max(rect.width, 120), rightEdge - leftEdge - margin * 2);
      const next = { left: Math.max(leftEdge + margin, Math.min(rect.left, rightEdge - width - margin)), top: upward ? Math.max(topEdge + margin, rect.top - gap - Math.min(desired, maxHeight)) : rect.bottom + gap, width, maxHeight };
      setPosition(previous => Object.keys(next).every(key => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    const observer = new ResizeObserver(schedule); observer.observe(trigger); observer.observe(popup);
    window.addEventListener("resize", schedule); window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule); window.visualViewport?.addEventListener("scroll", schedule);
    const outside = (event: Event) => { const target = event.target as Node; if (!rootRef.current?.contains(target) && !popup.contains(target)) close(); };
    document.addEventListener("pointerdown", outside, true); document.addEventListener("focusin", outside);
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      window.removeEventListener("resize", schedule); window.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule); window.visualViewport?.removeEventListener("scroll", schedule);
      document.removeEventListener("pointerdown", outside, true); document.removeEventListener("focusin", outside);
      if (typeof popup.hidePopover === "function" && popup.matches(":popover-open")) popup.hidePopover();
    };
  }, [open, portalHost, close]);
  useClientLayoutEffect(() => {
    if (open && searchable && position.width > 0) searchRef.current?.focus({ preventScroll: true });
  }, [open, searchable, portalHost, position.width]);
  useClientLayoutEffect(() => {
    if (!open || !popupRef.current) return;
    const item = document.getElementById(`${listId}-${activeIndex}`), popup = listRef.current;
    if (!item || !popup) return;
    const bounds = item.getBoundingClientRect(), visible = popup.getBoundingClientRect();
    if (bounds.top < visible.top + 5) popup.scrollTop -= visible.top + 5 - bounds.top;
    else if (bounds.bottom > visible.bottom - 5) popup.scrollTop += bounds.bottom - visible.bottom + 5;
  }, [open, activeIndex, listId, position.maxHeight]);

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === "Tab") close(true);
    else if (event.key === "Enter") { event.preventDefault(); choose(enabled.find(choice => choice.index === activeIndex)); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = enabled.findIndex(choice => choice.index === activeIndex);
      const next = Math.max(0, Math.min(enabled.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      setActiveIndex(enabled[next]?.index ?? -1);
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (blocked()) return;
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === "Tab") { close(); return; }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!open) { openList(event.key === "Home" ? "first" : event.key === "End" ? "last" : undefined); return; }
      const index = enabled.findIndex(choice => choice.index === activeIndex);
      const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1 : Math.max(0, Math.min(enabled.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      setActiveIndex(enabled[next]?.index ?? -1); return;
    }
    if (event.key === "Enter" || (event.key === " " && (!typeahead.current.text || Date.now() - typeahead.current.time > 700))) {
      event.preventDefault(); if (open) choose(choices[activeIndex]); else openList(); return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now(), previous = now - typeahead.current.time < 700 ? typeahead.current.text : "";
      const text = `${previous}${event.key.toLocaleLowerCase()}`, repeated = [...text].every(character => character === text[0]);
      const query = repeated ? text[0] : text, starting = enabled.findIndex(choice => choice.index === (open ? activeIndex : selected?.index));
      const offset = query.length === 1 ? 1 : 0;
      const ordered = enabled.map((_, i) => enabled[(Math.max(0, starting) + i + offset) % enabled.length]);
      const match = ordered.find(choice => choice.label.trim().toLocaleLowerCase().startsWith(query));
      typeahead.current = { text, time: now };
      if (!open) openList();
      if (match) setActiveIndex(match.index);
    }
  }

  return <span className={`custom-select ${className}`} style={style} ref={rootRef} data-disabled={isDisabled || undefined} data-open={open || undefined}>
    <span className="custom-select-measure" aria-hidden="true">{longestLabel || "请选择"}</span>
    <button {...ariaProps} ref={triggerRef} id={triggerId} type="button" className="custom-select-trigger" role="combobox"
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
      aria-required={required || undefined} aria-invalid={validationMessage ? true : ariaProps["aria-invalid"]} aria-describedby={[ariaProps["aria-describedby"], validationMessage ? errorId : ""].filter(Boolean).join(" ") || undefined}
      disabled={isDisabled} tabIndex={tabIndex} title={props.title} onKeyDown={onKeyDown}
      onClick={() => { if (open) close(); else openList(); }}>
      <span className="custom-select-value">{selected?.label || "请选择"}</span><ChevronDown className="custom-select-arrow" size={15} aria-hidden="true" />
    </button>
    <select {...props} id={`${triggerId}-native`} ref={nativeRef} className="custom-select-native" tabIndex={-1} aria-hidden="true" autoFocus={false}
      disabled={disabled} required={required} value={value} defaultValue={defaultValue}
      onFocus={event => { triggerRef.current?.focus({ preventScroll: true }); onFocus?.(event); }}
      onChange={event => { if (!controlled) setUncontrolledValue(event.currentTarget.value); if (event.currentTarget.validity.valid) setValidationMessage(""); onChange?.(event); }}
      onInvalid={event => {
        onInvalid?.(event); event.preventDefault(); setValidationMessage(event.currentTarget.validationMessage || "请选择一个选项。");
        const form = event.currentTarget.form, firstInvalid = form && Array.from(form.elements).find(element => "willValidate" in element && element.willValidate === true && element.matches(":invalid"));
        if (!firstInvalid || firstInvalid === event.currentTarget) triggerRef.current?.focus({ preventScroll: false });
      }}>{children}</select>
    {validationMessage && <span id={errorId} className="custom-select-validation" role="alert">{validationMessage}</span>}
    {open && portalHost && createPortal(<div ref={popupRef}
      className="custom-select-popup" popover="manual" style={{ ...position, visibility: position.width ? "visible" : "hidden" }} onPointerDown={event => { if (event.target !== searchRef.current) event.preventDefault(); }}>
      {searchable && <div className="custom-select-search"><input ref={searchRef} type="search" role="combobox" autoComplete="off"
        aria-label={`${props["aria-label"] || "选项"}搜索`} aria-expanded="true" aria-autocomplete="list" aria-controls={listId}
        aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        placeholder={searchPlaceholder} value={query} onChange={event => { setQuery(event.target.value); setActiveIndex(-1); }} onKeyDown={onSearchKeyDown} /></div>}
      <div ref={listRef} id={listId} role="listbox" className="custom-select-options" aria-label={props["aria-label"] || undefined} aria-labelledby={props["aria-labelledby"] || (!props["aria-label"] ? triggerId : undefined)}>
      {groups.filter(group => group.choices.some(choice => visible.includes(choice))).map((group, index) => <div key={index} role={group.label === undefined ? "presentation" : "group"} aria-label={group.label}>
        {group.label !== undefined && <div className="custom-select-group" aria-hidden="true">{group.label}</div>}
        {group.choices.filter(choice => visible.includes(choice)).map(choice => <div key={choice.index} id={`${listId}-${choice.index}`} role="option" aria-selected={choice.index === selected?.index} aria-disabled={choice.disabled || undefined}
          className={`custom-select-option ${choice.index === activeIndex ? "is-active" : ""} ${choice.index === selected?.index ? "is-selected" : ""}`}
          onPointerMove={() => { if (!choice.disabled) setActiveIndex(choice.index); }} onClick={() => choose(choice)}>
          <span>{choice.label}</span>{choice.index === selected?.index && <Check size={15} aria-hidden="true" />}
        </div>)}
      </div>)}
      {!visible.length && <div className="custom-select-empty" role="status">{query.trim() ? "没有匹配的选项" : "暂无可选项"}</div>}
      </div>
    </div>, portalHost)}
  </span>;
});
