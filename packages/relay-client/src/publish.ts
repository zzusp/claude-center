import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { RelayPublish } from "./events.js";

// Node 侧发布 helper（Console 服务端 + Worker 用）。best-effort、fire-and-forget：
// 落库成功后才调用，发布失败仅回调 onError，绝不抛错/不阻塞主流程——数据已落库，轮询兜底。

export interface PublisherOptions {
  // relay 基址（如 http://127.0.0.1:8787）。空字符串表示禁用，publish 变 no-op。
  url: string;
  // 发布鉴权 token（CLAUDE_CENTER_RELAY_PUBLISH_TOKEN）。
  token: string;
  timeoutMs?: number;
  onError?: (error: Error) => void;
}

export interface Publisher {
  publish(event: RelayPublish): void;
  readonly enabled: boolean;
}

export function createPublisher(options: PublisherOptions): Publisher {
  const base = options.url.replace(/\/+$/, "");
  const enabled = Boolean(base && options.token);
  const timeoutMs = options.timeoutMs ?? 3_000;

  return {
    enabled,
    publish(event: RelayPublish): void {
      if (!enabled) {
        return;
      }
      try {
        const url = new URL(`${base}/publish`);
        const data = Buffer.from(JSON.stringify(event), "utf8");
        const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
        const req = transport(
          {
            hostname: url.hostname,
            port: url.port || (url.protocol === "https:" ? 443 : 80),
            path: url.pathname,
            method: "POST",
            timeout: timeoutMs,
            headers: {
              "content-type": "application/json",
              "content-length": data.length,
              authorization: `Bearer ${options.token}`
            }
          },
          (res) => {
            // 排空响应体释放 socket；2xx 之外仅作 best-effort 忽略（数据已落库）。
            res.resume();
          }
        );
        req.on("error", (error) => options.onError?.(error));
        req.on("timeout", () => req.destroy());
        req.end(data);
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };
}
