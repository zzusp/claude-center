import { createHmac, timingSafeEqual } from "node:crypto";

// 浏览器订阅票据：Console 用 CLAUDE_CENTER_RELAY_SECRET 对「允许订阅的频道集 + 用户 + 过期」做 HMAC 签名，
// relay 用同一 secret 验签。relay 因此业务无关：只判「票据是否授予此频道」，不查业务库。对称密钥、零额外鉴权基础设施。

export interface TicketPayload {
  // 用户 id（审计/排查用）。
  uid: string;
  // 允许订阅的频道白名单（如 ["project:abc", "project:def"]）。
  channels: string[];
  // 过期时刻（ms epoch）。
  exp: number;
}

function encode(payload: TicketPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

// 签发票据：`<base64url(payload)>.<base64url(hmac)>`。
export function signTicket(payload: TicketPayload, secret: string): string {
  const body = encode(payload);
  return `${body}.${sign(body, secret)}`;
}

// 验签 + 过期校验。通过返回 payload，否则 null。timing-safe 比较签名。
export function verifyTicket(token: string, secret: string, nowMs: number): TicketPayload | null {
  const dot = token.indexOf(".");
  if (dot <= 0) {
    return null;
  }
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(body, secret);
  const got = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TicketPayload;
    if (typeof payload.exp !== "number" || payload.exp < nowMs || !Array.isArray(payload.channels)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
