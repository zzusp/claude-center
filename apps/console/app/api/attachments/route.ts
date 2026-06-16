import { createAttachment, getPool } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { requireUser } from "../../lib/session";
import { errorResponse, badRequest } from "../../lib/api";
import {
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  classifyMime,
  detectMimeFromMagic,
  isDangerousMagic,
  sanitizeOriginalName
} from "../../lib/attachment-config";

export const dynamic = "force-dynamic";
// 上传走 multipart + bytea；nodejs runtime 必需（pg + Buffer + Web Streams）。
export const runtime = "nodejs";

// POST /api/attachments  multipart/form-data { file }
// 两阶段上传第一步：落 attachments 行 + attachment_blobs 行，归属字段为空（待绑定）。
// 创建任务 / 评论时把返回的 id 加进 attachmentIds[] 一并提交即可完成绑定。
export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return badRequest("缺少 file 字段");
    }

    const declaredMime = (file.type || "application/octet-stream").toLowerCase();
    const kind = classifyMime(declaredMime);
    if (!kind) {
      return NextResponse.json(
        { error: `不支持的 MIME 类型：${declaredMime}` },
        { status: 415 }
      );
    }
    // 大小先按 declared kind 校验（图片 10MB / 文件 50MB）——避免读取后再拒绝。
    const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (file.size <= 0) {
      return badRequest("空文件");
    }
    if (file.size > limit) {
      const limitMB = (limit / (1024 * 1024)).toFixed(0);
      return NextResponse.json(
        { error: `${kind === "image" ? "图片" : "文件"}超过 ${limitMB}MB 上限` },
        { status: 413 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length !== file.size) {
      // 防御：FormData 偶尔出现 file.size 与实际不一致；以 buffer 长度为准重新校验。
      if (buffer.length > limit) {
        return NextResponse.json({ error: "文件超过上限" }, { status: 413 });
      }
    }

    if (isDangerousMagic(buffer)) {
      return NextResponse.json({ error: "可执行文件已拒收" }, { status: 415 });
    }
    // 图片强制 magic 校验：用户上传 .exe 改 Content-Type 也会被这里拦。
    // 通用文件仅 isDangerousMagic 兜底；扩展名做强校验代价过高、误杀偏多。
    let finalMime = declaredMime;
    if (kind === "image") {
      const detected = detectMimeFromMagic(buffer);
      if (!detected || classifyMime(detected) !== "image") {
        return badRequest("图片文件头校验失败");
      }
      finalMime = detected;
    }

    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const originalName = sanitizeOriginalName(file.name || "file");

    const attachment = await createAttachment(getPool(), {
      ownerUserId: user.id,
      kind,
      mime: finalMime,
      sizeBytes: buffer.length,
      sha256,
      originalName,
      data: buffer
    });

    return NextResponse.json(
      {
        attachment: {
          id: attachment.id,
          kind: attachment.kind,
          mime: attachment.mime,
          size_bytes: attachment.size_bytes,
          sha256: attachment.sha256,
          original_name: attachment.original_name,
          created_at: attachment.created_at
        }
      },
      { status: 201 }
    );
  } catch (error) {
    return errorResponse(error);
  }
}
