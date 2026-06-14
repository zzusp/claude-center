// 为 git worktree 准备 console 验证环境：装依赖(暖缓存) + 从主检出复制 .env + 清 apps/console/.next。
// worktree 不继承主检出的 node_modules / .env（均 gitignore），不准备直接跑验证会把环境问题误判成代码问题。
//
// ⚠️ 不整体 junction/symlink 主检出 node_modules：本仓是 npm workspaces，
//    node_modules/@claude-center/* 是指回 apps/packages 源码的 junction；整体复用会让
//    worktree 解析到主检出的源码而非本分支改动。用 npm install --prefer-offline（暖缓存）。
//
// 用法：node scripts/setup-worktree.mjs [--check] [worktreeDir]
//   --check   只打印将执行的步骤，不做任何改动
import { execFileSync, execSync } from "node:child_process";
import { existsSync, copyFileSync, rmSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const check = args.includes("--check");
const worktreeRoot = path.resolve(args.find((a) => !a.startsWith("--")) ?? process.cwd());

if (!existsSync(path.join(worktreeRoot, "package.json"))) {
  throw new Error(`${worktreeRoot} 不像仓库根（无 package.json）`);
}

// 主检出根 = worktree 的 git common dir（<main>/.git）的父目录。在主检出里跑也成立。
const commonDir = execFileSync(
  "git",
  ["-C", worktreeRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
  { encoding: "utf8" }
).trim();
const mainRoot = path.dirname(commonDir);

const srcEnv = path.join(mainRoot, ".env");
const dstEnv = path.join(worktreeRoot, ".env");
const nextDir = path.join(worktreeRoot, "apps", "console", ".next");

const envStep = existsSync(dstEnv)
  ? ".env 已存在，跳过"
  : existsSync(srcEnv)
    ? `从主检出复制 .env（${mainRoot}）`
    : "主检出无 .env，跳过";
const nextStep = existsSync(nextDir) ? "删除 apps/console/.next" : ".next 不存在，跳过";

console.log(`worktree:      ${worktreeRoot}`);
console.log(`main checkout: ${mainRoot}`);
console.log("步骤：");
console.log("  1. npm install --prefer-offline --no-audit --no-fund");
console.log(`  2. ${envStep}`);
console.log(`  3. ${nextStep}`);

if (check) {
  console.log("\n[--check] 仅打印计划，未做任何改动。");
  process.exit(0);
}

console.log("\n>> npm install --prefer-offline --no-audit --no-fund");
execSync("npm install --prefer-offline --no-audit --no-fund", {
  cwd: worktreeRoot,
  stdio: "inherit",
  windowsHide: true
});

if (!existsSync(dstEnv) && existsSync(srcEnv)) {
  copyFileSync(srcEnv, dstEnv);
  console.log(">> copied .env");
}

if (existsSync(nextDir)) {
  rmSync(nextDir, { recursive: true, force: true });
  console.log(">> removed apps/console/.next");
}

console.log("\nworktree 准备完成。可跑：npm run typecheck / npm run verify:console");
