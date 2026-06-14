// 删除 apps/console/.next（Next 构建缓存）。
// next build 与 dev server 同写 .next 会在 "Collecting page data" 阶段报
// `Cannot find module './chunks/vendor-chunks/next.js'`（并非代码错）；
// worktree 内、或 dev↔build 切换前清一次即可。
// 用法：node scripts/clean-next.mjs [repoRoot]   （默认脚本所在仓库根）
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(process.argv[2] ?? path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const nextDir = path.join(root, "apps", "console", ".next");

if (existsSync(nextDir)) {
  rmSync(nextDir, { recursive: true, force: true });
  console.log(`removed ${nextDir}`);
} else {
  console.log(`nothing to clean: ${nextDir} 不存在`);
}
