// relay 自验证：起一个临时 relay（ephemeral 端口），用真实 publish/subscribe 走一遍核心路径。
// 覆盖：① 落库后发布秒级投递 ② 保活 ping 不误断 ③ Last-Event-ID 断点重放
//       ④ 无凭据订阅被拒(401) ⑤ ticket 频道白名单过滤 ⑥ /healthz ⑦ /connections 鉴权与字段。
// 运行：先 build relay-client + relay，再 `node scripts/selftest.mjs`（package.json: npm run selftest）。

import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createPublisher, signTicket, subscribeRelay } from "@claude-center/relay-client";
import { createRelayServer } from "../dist/server.js";

const config = {
  host: "127.0.0.1",
  port: 0,
  secret: "test-secret",
  publishToken: "pub-token",
  workerToken: "worker-token",
  pingIntervalMs: 200,
  ringSize: 50,
  maxBodyBytes: 1_000_000
};

const handle = createRelayServer(config);
const subs = [];

function cleanup(code) {
  for (const sub of subs) {
    try {
      sub.close();
    } catch {
      /* ignore */
    }
  }
  handle.server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 1_500).unref();
}

function waitFor(check, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timeout waiting for: ${label}`));
      }
    }, 20);
  });
}

function rawCollect(base, channels, headers, ms) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${base}/events`);
    url.searchParams.set("channels", channels);
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { accept: "text/event-stream", ...headers }
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve({ status: res.statusCode, events: [] });
          return;
        }
        let buffer = "";
        const events = [];
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buffer += chunk;
          let idx = buffer.indexOf("\n\n");
          while (idx >= 0) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const data = raw
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /, ""))
              .join("\n");
            if (data) {
              try {
                events.push(JSON.parse(data));
              } catch {
                /* ignore */
              }
            }
            idx = buffer.indexOf("\n\n");
          }
        });
        setTimeout(() => {
          req.destroy();
          resolve({ status: 200, events });
        }, ms);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function rawGetJson(base, pathname, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${base}${pathname}`);
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: "GET", headers },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buf += chunk;
        });
        res.on("end", () => {
          // 非 2xx 通常是 text/plain（如 "unauthorized"），不解析。
          if (res.statusCode && res.statusCode >= 400) {
            resolve({ status: res.statusCode, body: buf });
            return;
          }
          try {
            resolve({ status: res.statusCode, body: JSON.parse(buf) });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function rawStatus(base, channels, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${base}/events`);
    url.searchParams.set("channels", channels);
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { accept: "text/event-stream", ...headers }
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
        req.destroy();
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function run() {
  await new Promise((resolve) => handle.server.listen(0, "127.0.0.1", resolve));
  const port = handle.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const publisher = createPublisher({ url: base, token: "pub-token" });
  assert.equal(publisher.enabled, true, "publisher should be enabled");

  // ① 投递：worker token 订阅 project:test，publish 后秒级收到全量负载。
  const received = [];
  let opened = false;
  const errors = [];
  const sub = subscribeRelay({
    url: base,
    channels: ["project:test"],
    token: "worker-token",
    pingTimeoutMs: 1_000,
    onOpen: () => {
      opened = true;
    },
    onEvent: (event) => received.push(event),
    onError: (error) => errors.push(error)
  });
  subs.push(sub);
  await waitFor(() => opened, 3_000, "subscriber connected");

  publisher.publish({ channel: "project:test", type: "task.upserted", entityId: "t1", seq: 1, payload: { a: 1 } });
  await waitFor(() => received.length >= 1, 3_000, "deliver event A");
  assert.equal(received[0].type, "task.upserted");
  assert.equal(received[0].payload.a, 1);
  const firstId = received[0].id;
  console.log(`  [1] 投递 OK（id=${firstId}, type=${received[0].type}）`);

  // ② 保活：pingIntervalMs=200，等 ~700ms 仍未触发断线（onError 无新增、连接仍 open）。
  await waitFor(() => false, 700, "keepalive window").catch(() => {});
  assert.equal(errors.length, 0, `keepalive should not error, got: ${errors.map((e) => e.message).join(";")}`);
  console.log("  [2] 保活 OK（700ms 内无误断）");

  // ③ Last-Event-ID 重放：再发 B、C，用 raw 连接带 last-event-id=firstId 重连，应补回 B、C。
  publisher.publish({ channel: "project:test", type: "task.comment", entityId: "t2", seq: 2, payload: { b: 2 } });
  publisher.publish({ channel: "project:test", type: "task.event", entityId: "t3", seq: 3, payload: { c: 3 } });
  await waitFor(() => received.length >= 3, 3_000, "deliver B,C to live sub");
  const replay = await rawCollect(base, "project:test", { authorization: "Bearer worker-token", "last-event-id": firstId }, 400);
  assert.equal(replay.status, 200);
  assert.ok(
    replay.events.some((e) => e.payload?.b === 2) && replay.events.some((e) => e.payload?.c === 3),
    `replay should contain B and C, got ${JSON.stringify(replay.events.map((e) => e.id))}`
  );
  assert.ok(
    !replay.events.some((e) => e.id === firstId),
    "replay should NOT re-send the already-seen firstId"
  );
  console.log(`  [3] Last-Event-ID 重放 OK（补回 ${replay.events.length} 条 id>${firstId}）`);

  // ④ 无凭据订阅被拒。
  const noAuthStatus = await rawStatus(base, "project:test", {});
  assert.equal(noAuthStatus, 401, "no-credential subscribe must be 401");
  console.log("  [4] 鉴权 OK（无票据/无 token → 401）");

  // ⑤ ticket 频道白名单：票据只授 project:allowed，订阅请求含 denied，denied 不应投递。
  const ticket = signTicket({ uid: "u1", channels: ["project:allowed"], exp: Date.now() + 60_000 }, "test-secret");
  // ticket 走 query；连接建立后再 publish，allowed 应投递、denied 被票据白名单过滤掉。
  const ticketEvents = await collectWithTicket(base, "project:allowed,project:denied", ticket, async () => {
    publisher.publish({ channel: "project:allowed", type: "worker.upserted", entityId: "w1", payload: { ok: true } });
    publisher.publish({ channel: "project:denied", type: "worker.upserted", entityId: "w2", payload: { ok: false } });
  });
  assert.ok(ticketEvents.some((e) => e.entityId === "w1"), "allowed channel should deliver");
  assert.ok(!ticketEvents.some((e) => e.entityId === "w2"), "denied channel must be filtered out by ticket");
  console.log("  [5] ticket 频道过滤 OK（allowed 投递、denied 被拒）");

  // ⑥ /healthz 返回运行计数。
  const health = await rawGetJson(base, "/healthz");
  assert.equal(health.status, 200, "/healthz must be 200");
  assert.ok(typeof health.body.events === "number" && typeof health.body.clients === "number", "/healthz must report counts");
  console.log(`  [6] /healthz OK（events=${health.body.events}, clients=${health.body.clients}）`);

  // ⑦ /connections 鉴权 + 字段。无 token → 401；带 publishToken → 列出当前连接（含 source/connectedAt/channels）。
  const connNoAuth = await rawGetJson(base, "/connections");
  assert.equal(connNoAuth.status, 401, "/connections without token must be 401");
  const conn = await rawGetJson(base, "/connections", { authorization: `Bearer ${config.publishToken}` });
  assert.equal(conn.status, 200, "/connections with publishToken must be 200");
  assert.ok(Array.isArray(conn.body.clients), "/connections must return clients array");
  assert.ok(conn.body.clients.length > 0, "should have at least one live connection during selftest");
  const sample = conn.body.clients[0];
  assert.ok(typeof sample.id === "number", "client.id must be number");
  assert.ok(sample.source === "worker" || sample.source === "ticket", "client.source must be worker|ticket");
  assert.ok(Array.isArray(sample.channels) && sample.channels.length > 0, "client.channels must be non-empty array");
  assert.ok(typeof sample.connectedAt === "number", "client.connectedAt must be number");
  console.log(`  [7] /connections OK（${conn.body.clients.length} 路在线，示例 source=${sample.source} channels=${sample.channels.length}）`);

  console.log("\nrelay selftest: ALL PASS ✅");
  cleanup(0);
}

// 带 ticket 的订阅 + 在连接建立后触发 publish，收集一段时间内的事件。
function collectWithTicket(base, channels, ticket, afterConnect) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${base}/events`);
    url.searchParams.set("channels", channels);
    url.searchParams.set("ticket", ticket);
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: "GET", headers: { accept: "text/event-stream" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`ticket subscribe status ${res.statusCode}`));
          return;
        }
        let buffer = "";
        const events = [];
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buffer += chunk;
          let idx = buffer.indexOf("\n\n");
          while (idx >= 0) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const data = raw
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /, ""))
              .join("\n");
            if (data) {
              try {
                events.push(JSON.parse(data));
              } catch {
                /* ignore */
              }
            }
            idx = buffer.indexOf("\n\n");
          }
        });
        // 连接已建立，触发 publish，再等一会儿收集。
        setTimeout(() => {
          void afterConnect();
        }, 100);
        setTimeout(() => {
          req.destroy();
          resolve(events);
        }, 700);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

run().catch((error) => {
  console.error("relay selftest FAILED ❌:", error.message);
  cleanup(1);
});
