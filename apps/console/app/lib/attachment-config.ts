// 附件上传校验常量与工具。Console API 与（未来）任务表单共用。
// 方案见 docs/spec/task-attachments.md。

import type { AttachmentKind } from "@claude-center/db";

const MB = 1024 * 1024;

// 单文件上限：图片 10MB / 通用文件 50MB。可经环境变量调（部署侧覆盖）。
export const MAX_IMAGE_BYTES =
  parseIntFromEnv(process.env.CLAUDE_CENTER_UPLOAD_MAX_IMAGE_MB) * MB || 10 * MB;
export const MAX_FILE_BYTES =
  parseIntFromEnv(process.env.CLAUDE_CENTER_UPLOAD_MAX_FILE_MB) * MB || 50 * MB;

// 单次任务/评论附件数上限——前端 + 后端绑定时校验。
export const MAX_ATTACHMENTS_PER_OWNER = 10;

function parseIntFromEnv(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// MIME 白名单：图片走 Claude vision；通用文件作引用资料。
export const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const FILE_MIMES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/zip",
  "application/octet-stream"
]);

// 根据 MIME 决定 kind；返回 null 表示不在白名单。
export function classifyMime(mime: string): AttachmentKind | null {
  const m = mime.toLowerCase().trim();
  if (IMAGE_MIMES.has(m)) {
    return "image";
  }
  if (FILE_MIMES.has(m)) {
    return "file";
  }
  return null;
}

// 文件名清洗：去路径分隔符 / 控制字符 / .. ；长度截到 200。空字符串回退为 'file'。
export function sanitizeOriginalName(raw: string): string {
  // 去掉路径前缀（IE 上传偶有 full path）
  const last = raw.replace(/^.*[\\/]/, "");
  // 仅保留可打印字符；去控制字符；不允许 '..'
  const cleaned = last.replace(/[\x00-\x1f\x7f]/g, "").replace(/\.\./g, "_").trim();
  const limited = cleaned.slice(0, 200);
  return limited || "file";
}

// magic bytes 嗅探：仅图片做强校验；通用文件做"非可执行"反向校验。
// 不做的话仅信 Content-Type，用户传 .exe 改 application/pdf 会被收。
export function detectMimeFromMagic(buf: Buffer): string | null {
  if (buf.length < 4) {
    return null;
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF: 47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return "image/gif";
  }
  // WebP: 52 49 46 46 .... 57 45 42 50
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return "image/webp";
  }
  // PDF: 25 50 44 46 ('%PDF')
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return "application/pdf";
  }
  // ZIP / Office docx (PK..): 50 4B 03 04
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return "application/zip";
  }
  return null;
}

// 已知可执行/危险 magic — 直接拒收。
export function isDangerousMagic(buf: Buffer): boolean {
  if (buf.length < 4) {
    return false;
  }
  // Windows PE / DOS MZ
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    return true;
  }
  // ELF
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    return true;
  }
  // Mach-O 32 / 64 / fat
  const first4 = buf.readUInt32BE(0);
  if (
    first4 === 0xfeedface || first4 === 0xfeedfacf ||
    first4 === 0xcefaedfe || first4 === 0xcffaedfe ||
    first4 === 0xcafebabe
  ) {
    return true;
  }
  return false;
}
