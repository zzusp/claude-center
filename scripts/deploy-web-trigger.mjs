#!/usr/bin/env node
// 本地辅助：自检 → 打 cc-vX.Y.Z tag 并推 origin，触发 CI 部署。
//
// 用法：
//   node scripts/deploy-web-trigger.mjs 0.2.0
//   node scripts/deploy-web-trigger.mjs 0.2.0 --check   # 只跑自检
//   node scripts/deploy-web-trigger.mjs 0.2.0 --dry-run # 自检 + 打印将执行的 git 命令但不推送
//
// 自检项：
//   - 工作树 clean（git status --porcelain 空）
//   - 在 main 分支（避免误打）
//   - CHANGELOG-console.md 有非空 [VERSION] 节
//   - tag cc-vVERSION 在 local/remote 都不存在
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const [, , version, ...flags] = process.argv;
const checkOnly = flags.includes("--check");
const dryRun = flags.includes("--dry-run");

if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
  console.error("用法：node scripts/deploy-web-trigger.mjs <X.Y.Z> [--check|--dry-run]");
  process.exit(2);
}

const tag = `cc-v${version}`;

function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}

const issues = [];
function check(cond, msg) {
  if (!cond) issues.push(msg);
}

// 1) clean tree
try {
  const status = sh("git status --porcelain");
  check(status === "", `工作树有未提交改动:\n${status}`);
} catch (e) {
  issues.push(`git status 失败：${e.message}`);
}

// 2) on main
try {
  const branch = sh("git rev-parse --abbrev-ref HEAD");
  check(branch === "main", `当前不在 main 分支（实际：${branch}）`);
} catch (e) {
  issues.push(`git rev-parse 失败：${e.message}`);
}

// 3) CHANGELOG 节存在
const changelog = resolve(repoRoot, "CHANGELOG-console.md");
check(existsSync(changelog), "缺 CHANGELOG-console.md");
if (existsSync(changelog)) {
  try {
    sh(`node scripts/extract-changelog.mjs CHANGELOG-console.md ${version} --check`);
  } catch (e) {
    issues.push(`CHANGELOG-console.md 没有非空 [${version}] 节：${e.stderr?.toString().trim() || e.message}`);
  }
}

// 4) tag 不冲突
try {
  const local = sh(`git tag -l ${tag}`);
  check(local === "", `本地已存在 tag ${tag}`);
} catch (_) {}
try {
  const remote = sh(`git ls-remote --tags origin refs/tags/${tag}`);
  check(remote === "", `远程已存在 tag ${tag}`);
} catch (_) {}

if (issues.length > 0) {
  console.error("[deploy-web-trigger] 自检失败：");
  for (const i of issues) console.error(`  - ${i}`);
  process.exit(1);
}

console.log(`[deploy-web-trigger] 自检通过：${tag}`);
if (checkOnly) {
  process.exit(0);
}

const tagCmd = `git tag -a ${tag} -m "Release ${tag}"`;
const pushCmd = `git push origin ${tag}`;

if (dryRun) {
  console.log(`[dry-run] $ ${tagCmd}`);
  console.log(`[dry-run] $ ${pushCmd}`);
  process.exit(0);
}

console.log(`[deploy-web-trigger] $ ${tagCmd}`);
sh(tagCmd, { stdio: "inherit" });
console.log(`[deploy-web-trigger] $ ${pushCmd}`);
sh(pushCmd, { stdio: "inherit" });
console.log(`[deploy-web-trigger] 已推送 ${tag}，CI 将在 1-2 分钟内开始部署。`);
console.log(`[deploy-web-trigger] 跟踪：gh run watch  /  https://github.com/zzusp/claude-center/actions`);
