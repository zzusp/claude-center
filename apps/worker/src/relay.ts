import {
  createPublisher,
  projectChannel,
  subscribeRelay,
  workerChannel,
  type Publisher,
  type RelayEvent,
  type RelayPublish,
  type Subscription
} from "@claude-center/relay-client";
import type { WorkerConfig } from "./config.js";

type LogFn = (level: "info" | "error", message: string) => void;

// Worker 侧的 SSE 中转接入：
//   - 发布：落库后 best-effort 推全量负载（自动附 origin=workerId）。
//   - 订阅：worker:<id> + 本机关联 project:<id>；收到「非自己发出」的事件即催一次相应 tick，
//     把认领延迟从轮询周期（默认 10s）降到亚秒级。
// relayUrl 为空时整体 no-op，Worker 退回纯数据库轮询，功能不降级。
export class WorkerRelay {
  private readonly publisher: Publisher;
  private sub: Subscription | null = null;
  private channels: string[] = [];
  private connected = false;

  constructor(
    private readonly config: WorkerConfig,
    private readonly onSignal: (event: RelayEvent) => void,
    private readonly log: LogFn
  ) {
    this.publisher = createPublisher({
      url: config.relayUrl,
      token: config.relayPublishToken,
      onError: (error) => this.log("error", `relay publish: ${error.message}`)
    });
  }

  get enabled(): boolean {
    return Boolean(this.config.relayUrl);
  }

  // best-effort 发布；自动附 origin=workerId，供订阅端忽略自己发出的事件（防自触发循环）。
  publish(event: RelayPublish): void {
    if (!this.enabled) {
      return;
    }
    this.publisher.publish({ ...event, origin: this.config.workerId });
  }

  // 设定订阅频道（worker:<id> 恒在 + 本机关联项目）。频道集变化才重连。
  subscribe(projectIds: string[]): void {
    if (!this.enabled || !this.config.relayWorkerToken) {
      return;
    }
    const next = [workerChannel(this.config.workerId), ...projectIds.map(projectChannel)];
    if (next.length === this.channels.length && next.every((channel, index) => channel === this.channels[index])) {
      return;
    }
    this.channels = next;
    this.sub?.close();
    this.sub = subscribeRelay({
      url: this.config.relayUrl,
      channels: next,
      token: this.config.relayWorkerToken,
      onOpen: () => {
        if (!this.connected) {
          this.connected = true;
          this.log("info", `relay connected (${next.length} channels)`);
        }
      },
      onError: () => {
        // 重连/退避由 subscribeRelay 内部处理；这里只复位连接标记，避免日志刷屏。
        this.connected = false;
      },
      onEvent: (event) => {
        if (event.origin === this.config.workerId) {
          return;
        }
        this.onSignal(event);
      }
    });
  }

  stop(): void {
    this.sub?.close();
    this.sub = null;
  }
}
