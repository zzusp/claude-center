#!/usr/bin/env node
// 本地辅助：自检 → 打 worker-vX.Y.Z tag 并推 origin，触发 CI 桌面端打包发版。
// 与 deploy-web-trigger.mjs 同构，只差校验 CHANGELOG-worker.md。
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
  console.error("用法：node scripts/release-worker-trigger.mjs <X.Y.Z> [--check|--dry-run]");
  process.exit(2);
}

const tag = `worker-v${version}`;

function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}

const issues = [];
const check = (cond, msg) => { if (!cond) issues.push(msg); };

try { check(sh("git status --porcelain") === "", "工作树有未提交改动"); } catch (e) { issues.push(`git status: ${e.message}`); }
try { const b = sh("git rev-parse --abbrev-ref HEAD"); check(b === "main", `当前不在 main 分支（实际：${b}）`); } catch (e) { issues.push(`git rev-parse: ${e.message}`); }

const cl = resolve(repoRoot, "CHANGELOG-worker.md");
check(existsSync(cl), "缺 CHANGELOG-worker.md");
if (existsSync(cl)) {
  try {
    sh(`node scripts/extract-changelog.mjs CHANGELOG-worker.md ${version} --check`);
  } catch (e) {
    issues.push(`CHANGELOG-worker.md 没有非空 [${version}] 节：${e.stderr?.toString().trim() || e.message}`);
  }
}

try { check(sh(`git tag -l ${tag}`) === "", `本地已存在 tag ${tag}`); } catch (_) {}
try { check(sh(`git ls-remote --tags origin refs/tags/${tag}`) === "", `远程已存在 tag ${tag}`); } catch (_) {}

if (issues.length) {
  console.error("[release-worker-trigger] 自检失败：");
  for (const i of issues) console.error(`  - ${i}`);
  process.exit(1);
}

console.log(`[release-worker-trigger] 自检通过：${tag}`);
if (checkOnly) process.exit(0);

const tagCmd = `git tag -a ${tag} -m "Release ${tag}"`;
const pushCmd = `git push origin ${tag}`;

if (dryRun) {
  console.log(`[dry-run] $ ${tagCmd}`);
  console.log(`[dry-run] $ ${pushCmd}`);
  process.exit(0);
}

sh(tagCmd, { stdio: "inherit" });
sh(pushCmd, { stdio: "inherit" });
console.log(`[release-worker-trigger] 已推送 ${tag}，CI 将开始多平台打包（windows + macos，约 10-15 分钟）。`);
console.log("跟踪：gh run watch  /  https://github.com/zzusp/claude-center/actions");
