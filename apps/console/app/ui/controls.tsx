"use client";

import {
  Activity, ArrowDown, ArrowUp, Boxes, Bot, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert,
  Clock, Cpu, Database, ExternalLink, FolderGit2, GitBranch, Inbox, LayoutGrid, ListTodo, LogOut,
  MessageSquare, Network, Pencil, Plus, Power, RadioTower, RotateCcw, Save, Search, Send, Server,
  ShieldCheck, Tag, Trash2, UserRound, Users, X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

// 通用右侧抽屉外壳：backdrop + 滑入面板 + 头部标题/关闭 + 滚动内容区，Esc 关闭。
// 任务发布、新建项目、用户编辑等表单统一套用，保证三处列表的「点击 → 右侧抽屉」交互一致。
function Drawer({
  open,
  title,
  onClose,
  children
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={`drawer-backdrop${open ? " open" : ""}`} onClick={onClose} />
      <aside className={`drawer${open ? " open" : ""}`} aria-hidden={!open}>
        <div className="drawer-head">
          <h2 className="detail-title">{title}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <div className="drawer-scroll drawer-pad">{children}</div>
      </aside>
    </>
  );
}

/* ============================== Select ==============================
   自定义单选下拉：用 div 渲染展开面板，圆角 / 阴影 / hover / 选中态全部受控，
   与 Claude Light 设计系统统一（原生 <select> 的弹出面板无法 CSS 定制）。
   带 name 时渲染隐藏 input，保持 FormData 取值不变。 */

type SelectOption = { value: string; label: string };

function Select({
  value,
  onChange,
  options,
  name,
  className,
  placeholder,
  required,
  disabled,
  ariaLabel
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  name?: string;
  className?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  // 点击组件外部时收起面板
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  // 打开时把键盘高亮对齐到当前选中项
  useEffect(() => {
    if (open) setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [open, selectedIndex]);

  function commit(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (!open) {
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => Math.min(options.length - 1, prev + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => Math.max(0, prev - 1));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(activeIndex);
    }
  }

  return (
    <div className={`cc-select${open ? " open" : ""}${className ? ` ${className}` : ""}`} ref={rootRef}>
      {name ? <input type="hidden" name={name} value={value} required={required} /> : null}
      <button
        type="button"
        className="cc-select-trigger"
        onClick={() => (disabled ? undefined : setOpen((prev) => !prev))}
        onKeyDown={onKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className={`cc-select-label${selected ? "" : " placeholder"}`}>
          {selected ? selected.label : placeholder ?? ""}
        </span>
        <ChevronDown size={15} className="cc-select-caret" aria-hidden />
      </button>
      {open ? (
        <div className="cc-select-panel" role="listbox">
          {options.map((option, index) => (
            <div
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={`cc-select-option${option.value === value ? " selected" : ""}${
                index === activeIndex ? " active" : ""
              }`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => commit(index)}
            >
              <span className="cc-select-option-label">{option.label}</span>
              {option.value === value ? <Check size={14} className="cc-select-check" aria-hidden /> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ============================ ConfirmDialog ============================
   居中确认弹框：替代浏览器原生 window.confirm（样式不可控、丑）。受控展示，
   配 useConfirm() 可在异步流程里以 `await confirm({...})` 形式无缝替换 confirm()。
   Esc 取消；点 backdrop 取消；destructive 操作用 danger 让确认键变红。 */

type ConfirmOptions = {
  title: string;
  message: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
};

function ConfirmDialog({
  open,
  title,
  message,
  confirmText = "确认",
  cancelText = "取消",
  danger = false,
  onConfirm,
  onCancel
}: ConfirmOptions & { open: boolean; onConfirm: () => void; onCancel: () => void }) {
  // Esc 关闭（不绑 Enter，避免误触发破坏性确认）
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div className="modal-backdrop open" onClick={onCancel}>
      <div className="modal" role="alertdialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className={`modal-icon${danger ? " danger" : ""}`}>
            <CircleAlert size={18} />
          </span>
          <h2 className="modal-title">{title}</h2>
        </div>
        <div className="modal-body">{message}</div>
        <div className="modal-actions">
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            {cancelText}
          </button>
          <button type="button" className={`btn btn-sm ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

// Promise 化确认：`const { confirm, dialog } = useConfirm()`，把 `dialog` 渲染进组件，
// 在 handler 里 `if (!(await confirm({...}))) return;`，与原生 confirm 同形便于替换。
function useConfirm() {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ ...options, resolve })),
    []
  );

  function settle(ok: boolean) {
    setState((cur) => {
      cur?.resolve(ok);
      return null;
    });
  }

  const dialog = (
    <ConfirmDialog
      open={state !== null}
      title={state?.title ?? ""}
      message={state?.message ?? null}
      confirmText={state?.confirmText}
      cancelText={state?.cancelText}
      danger={state?.danger}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );

  return { confirm, dialog };
}

/* ============================== FormModal ==============================
   居中表单弹窗：替代 Drawer 用于"发布/编辑"类多字段表单——避免侧抽屉在宽屏下大量留白，
   且能并列两列字段。结构：backdrop（点击关）+ 居中卡片（head 标题 / 关闭 + scroll body）。
   Esc 关闭；点击内容区不冒泡到 backdrop；size 决定最大宽度（md=560，lg=720）。 */
function FormModal({
  open,
  title,
  onClose,
  size = "lg",
  children
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  size?: "md" | "lg";
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-backdrop open" onClick={onClose}>
      <div
        className={`modal modal-form modal-${size}`}
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-form-head">
          <h2 className="modal-title">{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <div className="modal-form-body">{children}</div>
      </div>
    </div>
  );
}

/* ============================== DateTimePicker ==============================
   自定义日期时间选择器：替换原生 <input type="datetime-local">（macOS/Windows 渲染丑、
   各浏览器不一致、且无法禁过去时间）。值格式与 datetime-local 一致：YYYY-MM-DDTHH:MM。
   - 带 name 时渲染隐藏 input，FormData 取值与原生 datetime-local 兼容。
   - minNow=true 时禁选过去日期 / 同日的过去时间。
   - 受控/非受控均支持：传 value+onChange 即受控；只传 defaultValue 走内部 state。 */

const MONTH_LABEL_CN = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
const WEEKDAY_LABEL_CN = ["日", "一", "二", "三", "四", "五", "六"];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// 序列化 / 反序列化 datetime-local 格式（"YYYY-MM-DDTHH:MM"）；避开 toISOString 的 UTC 偏移。
function formatLocal(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function parseLocal(value: string): Date | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

// 日历单元格的"日"序号网格：返回 [{date: Date, inMonth: boolean}] × 42（6 行 × 7 列），含上月末尾与下月开头补位。
function buildMonthGrid(year: number, month: number): Array<{ date: Date; inMonth: boolean }> {
  const first = new Date(year, month, 1);
  const startWeekday = first.getDay();
  const cells: Array<{ date: Date; inMonth: boolean }> = [];
  // 前置补位：上月末尾几天
  for (let i = startWeekday; i > 0; i -= 1) {
    cells.push({ date: new Date(year, month, 1 - i), inMonth: false });
  }
  // 本月
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d += 1) {
    cells.push({ date: new Date(year, month, d), inMonth: true });
  }
  // 后置补位至 42 格
  while (cells.length < 42) {
    const last = cells[cells.length - 1]!.date;
    cells.push({ date: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1), inMonth: false });
  }
  return cells;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function DateTimePicker({
  name,
  value,
  defaultValue = "",
  onChange,
  minNow = false,
  disabled = false,
  placeholder = "选择日期与时间",
  ariaLabel,
  required
}: {
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (next: string) => void;
  minNow?: boolean;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  required?: boolean;
}) {
  const isControlled = value !== undefined;
  const [internal, setInternal] = useState(defaultValue);
  const current = isControlled ? value ?? "" : internal;

  function setCurrent(next: string) {
    if (!isControlled) setInternal(next);
    onChange?.(next);
  }

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 初始视图：当前值所在月，否则今天所在月。
  const parsed = useMemo(() => parseLocal(current), [current]);
  const initialView = parsed ?? new Date();
  const [viewYear, setViewYear] = useState(initialView.getFullYear());
  const [viewMonth, setViewMonth] = useState(initialView.getMonth());

  // 打开面板时把视图对齐到当前选中值（或今天）。
  useEffect(() => {
    if (!open) return;
    const anchor = parseLocal(current) ?? new Date();
    setViewYear(anchor.getFullYear());
    setViewMonth(anchor.getMonth());
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // 点击组件外部时收起
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const grid = useMemo(() => buildMonthGrid(viewYear, viewMonth), [viewYear, viewMonth]);
  // minNow 锚点：组件 mount 后只取一次「现在」作为下界（避免每渲染都跳秒导致 hydration 抖动）。
  const minDate = useMemo(() => (minNow ? new Date() : null), [minNow, open]); // 打开时刷新

  function cellDisabled(date: Date): boolean {
    if (!minDate) return false;
    return startOfDay(date).getTime() < startOfDay(minDate).getTime();
  }

  function pickDate(date: Date) {
    // 选日期：保留已有时分；若没有，今天默认下一个整 5 分钟以避免立即过去。
    let hours = 9;
    let minutes = 0;
    if (parsed) {
      hours = parsed.getHours();
      minutes = parsed.getMinutes();
    } else if (minDate) {
      const m = minDate.getMinutes();
      const rounded = Math.min(59, Math.ceil((m + 1) / 5) * 5);
      hours = rounded >= 60 ? minDate.getHours() + 1 : minDate.getHours();
      minutes = rounded >= 60 ? 0 : rounded;
    }
    // 同日且时间已过下界，则上调到下界
    let next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes, 0, 0);
    if (minDate && next.getTime() < minDate.getTime()) {
      next = new Date(minDate);
      next.setSeconds(0, 0);
    }
    setCurrent(formatLocal(next));
  }

  function setHour(h: number) {
    const base = parsed ?? new Date();
    let next = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, base.getMinutes(), 0, 0);
    if (minDate && next.getTime() < minDate.getTime()) {
      next = new Date(minDate);
      next.setSeconds(0, 0);
    }
    setCurrent(formatLocal(next));
  }

  function setMinute(m: number) {
    const base = parsed ?? new Date();
    let next = new Date(base.getFullYear(), base.getMonth(), base.getDate(), base.getHours(), m, 0, 0);
    if (minDate && next.getTime() < minDate.getTime()) {
      next = new Date(minDate);
      next.setSeconds(0, 0);
    }
    setCurrent(formatLocal(next));
  }

  function jumpMonth(delta: number) {
    let y = viewYear;
    let m = viewMonth + delta;
    while (m < 0) {
      m += 12;
      y -= 1;
    }
    while (m > 11) {
      m -= 12;
      y += 1;
    }
    setViewYear(y);
    setViewMonth(m);
  }

  function clear() {
    setCurrent("");
    setOpen(false);
  }

  function selectNow() {
    const now = new Date();
    // 取下一个整 5 分钟，避免一打开就过期
    const m = now.getMinutes();
    const rounded = Math.ceil((m + 1) / 5) * 5;
    if (rounded >= 60) {
      now.setHours(now.getHours() + 1);
      now.setMinutes(0);
    } else {
      now.setMinutes(rounded);
    }
    now.setSeconds(0, 0);
    setCurrent(formatLocal(now));
    setViewYear(now.getFullYear());
    setViewMonth(now.getMonth());
  }

  const today = new Date();
  const displayLabel = parsed
    ? `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}  ${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}`
    : "";

  // 小时下拉范围：minNow 同日时只显示 ≥ 现在小时。
  const hours = useMemo(() => {
    if (!minDate || !parsed || !sameDay(parsed, minDate)) {
      return Array.from({ length: 24 }, (_, i) => i);
    }
    const start = minDate.getHours();
    return Array.from({ length: 24 - start }, (_, i) => start + i);
  }, [minDate, parsed]);

  // 分钟以 5 为步进；同日同小时则只允许 ≥ 现在分钟。
  const minutes = useMemo(() => {
    const step = 5;
    const all = Array.from({ length: 60 / step }, (_, i) => i * step);
    if (!minDate || !parsed) return all;
    if (!sameDay(parsed, minDate)) return all;
    if (parsed.getHours() !== minDate.getHours()) return all;
    return all.filter((m) => m >= minDate.getMinutes());
  }, [minDate, parsed]);

  return (
    <div className={`dt-picker${open ? " open" : ""}${disabled ? " disabled" : ""}`} ref={rootRef}>
      {name ? <input type="hidden" name={name} value={current} required={required} /> : null}
      <button
        type="button"
        className="dt-trigger"
        onClick={() => (disabled ? undefined : setOpen((prev) => !prev))}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <CalendarDays size={15} className="dt-trigger-ico" aria-hidden />
        <span className={`dt-trigger-label${current ? "" : " placeholder"}`}>
          {current ? displayLabel : placeholder}
        </span>
        {current ? (
          <span
            className="dt-trigger-clear"
            role="button"
            aria-label="清除"
            onClick={(event) => {
              event.stopPropagation();
              clear();
            }}
          >
            <X size={13} />
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="dt-panel" role="dialog" aria-label="选择日期与时间">
          <div className="dt-panel-head">
            <button type="button" className="dt-nav" onClick={() => jumpMonth(-1)} aria-label="上一月">
              <ChevronLeft size={14} />
            </button>
            <span className="dt-panel-title">
              {viewYear} 年 {MONTH_LABEL_CN[viewMonth]}
            </span>
            <button type="button" className="dt-nav" onClick={() => jumpMonth(1)} aria-label="下一月">
              <ChevronRight size={14} />
            </button>
          </div>
          <div className="dt-grid">
            {WEEKDAY_LABEL_CN.map((label) => (
              <div key={label} className="dt-weekday">
                {label}
              </div>
            ))}
            {grid.map(({ date, inMonth }) => {
              const isDisabled = cellDisabled(date);
              const isSelected = parsed != null && sameDay(parsed, date);
              const isToday = sameDay(today, date);
              const className = [
                "dt-cell",
                inMonth ? "" : "out",
                isDisabled ? "disabled" : "",
                isSelected ? "selected" : "",
                isToday ? "today" : ""
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <button
                  type="button"
                  key={`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`}
                  className={className}
                  disabled={isDisabled}
                  onClick={() => pickDate(date)}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
          <div className="dt-time-row">
            <Clock size={14} className="dt-time-ico" aria-hidden />
            <select
              className="dt-time-select"
              value={parsed ? parsed.getHours() : ""}
              onChange={(event) => setHour(Number(event.target.value))}
              disabled={!parsed}
              aria-label="小时"
            >
              {!parsed ? <option value="">--</option> : null}
              {hours.map((h) => (
                <option key={h} value={h}>
                  {pad2(h)}
                </option>
              ))}
            </select>
            <span className="dt-time-colon">:</span>
            <select
              className="dt-time-select"
              value={parsed ? parsed.getMinutes() - (parsed.getMinutes() % 5) : ""}
              onChange={(event) => setMinute(Number(event.target.value))}
              disabled={!parsed}
              aria-label="分钟"
            >
              {!parsed ? <option value="">--</option> : null}
              {minutes.map((m) => (
                <option key={m} value={m}>
                  {pad2(m)}
                </option>
              ))}
            </select>
            <div className="dt-time-actions">
              <button type="button" className="dt-time-link" onClick={selectNow}>
                现在
              </button>
              {current ? (
                <button type="button" className="dt-time-link" onClick={clear}>
                  清除
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export { Drawer, FormModal, Select, DateTimePicker, ConfirmDialog, useConfirm };
