"use client";

import type { AttachmentMeta } from "@claude-center/db";
import { FileText, ImageIcon, Loader2, Paperclip, X } from "lucide-react";
import { ChangeEvent, ClipboardEvent, DragEvent, useRef, useState } from "react";

// 上传器：受控组件。父组件持有 attachments 数组（已上传 attachments 元数据），通过 onChange 接收更新。
// 提交任务/评论时把 attachments.map(a => a.id) 作为 attachmentIds 一并 POST。
// 支持：点击选择 / 拖拽 / 粘贴（onPaste 抓 clipboardData.files）。
// compact=true：仅渲染圆形按钮（与发送按钮同款样式），附件 chips 由父组件渲染（实时对话输入框场景）。
export function AttachmentUploader({
  attachments,
  onChange,
  max = 10,
  disabled = false,
  compact = false,
  onError
}: {
  attachments: AttachmentMeta[];
  onChange: (next: AttachmentMeta[]) => void;
  max?: number;
  disabled?: boolean;
  compact?: boolean;
  onError?: (msg: string) => void;
}) {
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 多文件上传时 onChange 没有 functional setter，单纯依赖 closure attachments 会丢中间态。
  // 用 ref 实时跟踪上传后的列表，每次 setState 都基于 ref 推一份新数组。
  const localRef = useRef(attachments);
  localRef.current = attachments;

  async function uploadSerial(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) {
      return;
    }
    const remaining = max - localRef.current.length - uploading;
    if (remaining <= 0) {
      const msg = `最多 ${max} 个附件`;
      setError(msg);
      onError?.(msg);
      return;
    }
    const queue = list.slice(0, remaining);
    if (queue.length < list.length) {
      const msg = `最多 ${max} 个附件，多余的已忽略`;
      setError(msg);
      onError?.(msg);
    } else {
      setError(null);
    }
    setUploading((n) => n + queue.length);
    for (const file of queue) {
      try {
        const form = new FormData();
        form.append("file", file);
        const response = await fetch("/api/attachments", { method: "POST", body: form });
        const payload = (await response.json().catch(() => ({}))) as
          | { attachment: AttachmentMeta }
          | { error?: string };
        if (!response.ok || !("attachment" in payload)) {
          throw new Error(("error" in payload && payload.error) || `上传失败：${response.status}`);
        }
        const next = [...localRef.current, payload.attachment];
        localRef.current = next;
        onChange(next);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "上传失败";
        setError(msg);
        onError?.(msg);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  async function remove(id: string) {
    // 撤销已上传的草稿：服务端会做 unbound 校验，已绑定的不会进这里（创建态下都未绑定）。
    try {
      await fetch(`/api/attachments/${id}`, { method: "DELETE" });
    } catch {
      // best-effort；失败时仍从 UI 移除，孤儿由 cron 清。
    }
    const next = localRef.current.filter((a) => a.id !== id);
    localRef.current = next;
    onChange(next);
  }

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) {
      uploadSerial(event.target.files);
      event.target.value = "";
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    if (event.dataTransfer?.files?.length) {
      uploadSerial(event.dataTransfer.files);
    }
  }

  function onPaste(event: ClipboardEvent<HTMLDivElement>) {
    const files = event.clipboardData?.files;
    if (files && files.length > 0) {
      event.preventDefault();
      uploadSerial(files);
    }
  }

  const remaining = max - attachments.length - uploading;
  const placeholder = disabled
    ? "禁用"
    : `点击 / 拖拽 / 粘贴附件 · 还可加 ${Math.max(0, remaining)} 个 · 单张图 ≤ 10MB / 文件 ≤ 50MB`;

  // 紧凑模式：仅渲染一颗圆形按钮（同 .chat-send 样式），附件 chips 由父组件管理 / 渲染。
  // 拖拽 / 粘贴在此模式下由外层 composer 接管（textarea + composer wrapper）。
  if (compact) {
    const tip = disabled
      ? "禁用"
      : remaining <= 0
        ? `最多 ${max} 个附件`
        : `添加附件 · 还可加 ${Math.max(0, remaining)} 个 · 单张图 ≤ 10MB / 文件 ≤ 50MB`;
    return (
      <>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={onPick}
          disabled={disabled || remaining <= 0}
        />
        <button
          type="button"
          className="chat-composer-btn"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || remaining <= 0}
          title={tip}
          aria-label="添加附件"
        >
          {uploading > 0 ? <Loader2 size={16} className="spin" /> : <Paperclip size={16} />}
        </button>
      </>
    );
  }

  return (
    <div
      className={`attachment-uploader ${dragOver ? "is-drag" : ""}`}
      onDragOver={(e) => {
        if (!disabled) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      onPaste={onPaste}
      tabIndex={0}
      role="group"
      aria-label="附件上传"
      style={{
        border: `1px dashed ${dragOver ? "var(--accent, #6cf)" : "var(--border, #444)"}`,
        borderRadius: 6,
        padding: 10,
        marginTop: 4
      }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={onPick}
        disabled={disabled || remaining <= 0}
      />
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || remaining <= 0}
        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <Paperclip size={14} />
        添加附件
      </button>
      <span className="field-hint" style={{ marginLeft: 8 }}>
        {placeholder}
      </span>
      {error ? <div className="error-box" style={{ marginTop: 6 }}>{error}</div> : null}
      {(attachments.length > 0 || uploading > 0) && (
        <div className="attachment-chips" style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
          {attachments.map((a) => (
            <AttachmentChip
              key={a.id}
              meta={a}
              onRemove={disabled ? undefined : () => remove(a.id)}
            />
          ))}
          {uploading > 0 ? (
            <span
              className="tag"
              style={{ display: "inline-flex", alignItems: "center", gap: 4, opacity: 0.7 }}
            >
              <Loader2 size={12} className="spin" />
              上传中 ×{uploading}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

// 上传期 chip：图片缩略 + 文件名 + 删除按钮。详情页只读展示走另一个 attachment-list 组件。
export function AttachmentChip({
  meta,
  onRemove
}: {
  meta: AttachmentMeta;
  onRemove?: () => void;
}) {
  return (
    <span
      className="tag"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 6px",
        background: "var(--surface-2, #2a2a2a)",
        borderRadius: 4,
        fontSize: "0.85em"
      }}
      title={`${meta.original_name} (${fmtSize(meta.size_bytes)})`}
    >
      {meta.kind === "image" ? (
        <img
          src={`/api/attachments/${meta.id}`}
          alt=""
          style={{ width: 20, height: 20, objectFit: "cover", borderRadius: 2 }}
        />
      ) : (
        <FileText size={14} />
      )}
      <span style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {meta.original_name}
      </span>
      {onRemove ? (
        <button
          type="button"
          aria-label="移除"
          onClick={onRemove}
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit" }}
        >
          <X size={12} />
        </button>
      ) : null}
    </span>
  );
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// 已绑定附件的只读列表：任务描述 / 评论流下方展示。
export function AttachmentList({ attachments }: { attachments: AttachmentMeta[] }) {
  if (!attachments || attachments.length === 0) {
    return null;
  }
  return (
    <div className="attachment-list" style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 8 }}>
      {attachments.map((a) =>
        a.kind === "image" ? (
          <a
            key={a.id}
            href={`/api/attachments/${a.id}`}
            target="_blank"
            rel="noreferrer"
            title={`${a.original_name} (${fmtSize(a.size_bytes)})`}
          >
            <img
              src={`/api/attachments/${a.id}`}
              alt={a.original_name}
              style={{
                maxWidth: 240,
                maxHeight: 180,
                objectFit: "cover",
                borderRadius: 4,
                border: "1px solid var(--border, #444)"
              }}
            />
          </a>
        ) : (
          <a
            key={a.id}
            className="tag"
            href={`/api/attachments/${a.id}`}
            target="_blank"
            rel="noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "4px 8px",
              borderRadius: 4,
              border: "1px solid var(--border, #444)",
              textDecoration: "none"
            }}
            title={`${a.original_name} (${fmtSize(a.size_bytes)})`}
          >
            {a.mime.startsWith("image/") ? <ImageIcon size={14} /> : <FileText size={14} />}
            <span style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {a.original_name}
            </span>
            <span className="field-hint" style={{ marginLeft: 4 }}>
              {fmtSize(a.size_bytes)}
            </span>
          </a>
        )
      )}
    </div>
  );
}
