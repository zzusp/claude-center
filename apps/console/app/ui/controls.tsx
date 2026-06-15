"use client";

import {
  Activity, ArrowDown, ArrowUp, Boxes, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert,
  Clock, Cpu, Database, ExternalLink, FolderGit2, GitBranch, Inbox, LayoutGrid, ListTodo, LogOut,
  MessageSquare, Network, Pencil, Plus, Power, RadioTower, RotateCcw, Save, Search, Send, Server,
  ShieldCheck, Tag, Trash2, UserRound, Users, X
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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

export { Drawer, Select, ConfirmDialog, useConfirm };
