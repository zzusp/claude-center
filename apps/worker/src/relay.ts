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

// SSE 中转订阅连接状态：disabled=未配置/缺订阅 token(纯轮询)；connecting=建连中(未 open 过)；
// connected=流已打开；reconnecting=曾连通后断开、退避重连中。供桌面端展示连通性。
export type RelayStatus = "disabled" | "connecting" | "connected" | "reconnecting";

// Worker 侧的 SSE 中转接入：
//   - 发布：落库后 best-effort 推全量负载（自动附 origin=workerId）。
//   - 订阅：worker:<id> + 本机关联 project:<id>；收到「非自己发出」的事件即催一次相应 tick，
//     把认领延迟从轮询周期（默认 10s）降到亚秒级。
// relayUrl 为空时整体 no-op，Worker 退回纯数据库轮询，功能不降级。
export class WorkerRelay {
  private publisher: Publisher;
  private sub: Subscription | null = null;
  private channels: string[] = [];
  private status: RelayStatus = "disabled";

  constructor(
    private readonly config: WorkerConfig,
    private readonly onSignal: (event: RelayEvent) => void,
    private readonly log: LogFn
  ) {
    this.publisher = this.makePublisher();
  }

  private makePublisher(): Publisher {
    return createPublisher({
      url: this.config.relayUrl,
      token: this.config.relayPublishToken,
      onError: (error) => this.log("error", `relay publish: ${error.message}`)
    });
  }

  // 运行时重配（桌面端改 relayUrl/token 后调用，无需重启）：按最新 config 重建发布器、
  // 断开旧订阅并清空频道集，由调用方随后 subscribe(projectIds) 触发按新配置重订阅。
  // config 与 runner 共享同一对象引用，调用前 runner 已就地更新好 relayUrl/token。
  reconfigure(): void {
    this.publisher = this.makePublisher();
    this.sub?.close();
    this.sub = null;
    this.channels = [];
    this.status = "disabled";
  }

  get enabled(): boolean {
    return Boolean(this.config.relayUrl);
  }

  // 当前订阅连接状态（桌面端展示用）。未配置 relayUrl 恒为 disabled。
  get state(): RelayStatus {
    return this.enabled ? this.status : "disabled";
  }

  // 当前订阅的频道数（worker:<id> + 关联 project:<id>）。
  get channelCount(): number {
    return this.channels.length;
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
    // 频道集变化要重建订阅：先标记建连中（曾连通则属重连），open 后转 connected。
    this.status = this.status === "connected" ? "reconnecting" : "connecting";
    this.sub?.close();
    this.sub = subscribeRelay({
      url: this.config.relayUrl,
      channels: next,
      token: this.config.relayWorkerToken,
      onOpen: () => {
        if (this.status !== "connected") {
          this.log("info", `relay connected (${next.length} channels)`);
        }
        this.status = "connected";
      },
      onError: () => {
        // 重连/退避由 subscribeRelay 内部处理；这里只更新状态，避免日志刷屏。
        // 曾连通后断开 → reconnecting；首连未成则保持 connecting。
        if (this.status === "connected") {
          this.status = "reconnecting";
        }
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
    this.status = "disabled";
  }
}
