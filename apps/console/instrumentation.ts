// Next.js 在服务进程启动时调用一次 register()。后台调度逻辑（定时任务提升 + 合并检查兜底验收）用
// node: 内置与 pg，只能跑在 nodejs 运行时；这里只做运行时分流：在正向 NEXT_RUNTIME==="nodejs" 分支里
// 动态 import 承载实现的 instrumentation-node。把判断写成「正向 if 包住动态 import」是 Next.js 官方
// 推荐写法——Turbopack/webpack 据此把整个 node-only 模块从 Edge 编译图里 DCE 掉，edge 编译不再因
// merge-check 的 node: 导入报 "node: not supported in Edge Runtime"（本应用无 edge runtime，仅为编译干净）。

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
