/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@claude-center/db"],
  webpack: (config, { nextRuntime }) => {
    // instrumentation.ts 会被 Node.js 与 Edge 两个 runtime 分别编译。它静态依赖的 merge-check.ts 用
    // `node:` scheme 导入 child_process/fs 等内置模块，Edge 编译无法解析 `node:` scheme，直接抛
    // UnhandledSchemeError 拖垮 dev/build。本应用无 edge runtime（无 middleware / 无 runtime="edge"），
    // 这些代码受 instrumentation 内 NEXT_RUNTIME==="nodejs" guard 保护、edge 运行时永不执行；只需在
    // Edge 编译里把 `node:` 内置模块标为 external，让 webpack 跳过解析即可让编译通过。Node.js 编译原生
    // 支持 `node:` scheme，不受影响。
    if (nextRuntime === "edge") {
      const externalizeNodeScheme = ({ request }, callback) =>
        request && request.startsWith("node:")
          ? callback(null, `commonjs ${request}`)
          : callback();
      const prev = config.externals;
      config.externals = [externalizeNodeScheme, ...(Array.isArray(prev) ? prev : prev ? [prev] : [])];
    }
    return config;
  }
};

export default nextConfig;
