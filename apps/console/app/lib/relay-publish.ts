import { createPublisher, projectChannel, workerChannel, type Publisher, type RelayPublish } from "@claude-center/relay-client";

// Console 服务端的 SSE 中转发布 helper：在各 mutating route【落库成功后】best-effort 推全量负载。
// 失败仅 warn、绝不阻塞用户请求——数据已落库，Worker/浏览器的轮询兜底。origin 固定 "console"。
// 仅在 route handler（nodejs runtime）import，切勿被 instrumentation/edge 引用。

let cached: Publisher | null = null;

function publisher(): Publisher | null {
  if (cached) {
    return cached;
  }
  // 容器/同机部署：INTERNAL_URL 走内网（如 docker compose service name http://relay:8787）省公网回环；
  // 未配时回退 RELAY_URL（与浏览器/Worker 共用同一公网 URL，向后兼容、本地 dev 也只配一项）。
  const url =
    process.env.CLAUDE_CENTER_RELAY_INTERNAL_URL?.trim() ||
    process.env.CLAUDE_CENTER_RELAY_URL?.trim() ||
    "";
  const token = process.env.CLAUDE_CENTER_RELAY_PUBLISH_TOKEN?.trim() || "";
  if (!url || !token) {
    return null;
  }
  cached = createPublisher({
    url,
    token,
    onError: (error) => console.warn(`[relay] publish failed: ${error.message}`)
  });
  return cached;
}

export function publishRelay(event: RelayPublish): void {
  const instance = publisher();
  if (!instance) {
    return;
  }
  instance.publish({ origin: "console", ...event });
}

export { projectChannel, workerChannel };
