#!/usr/bin/env node
// 零副作用自检：electron-builder 配置可解析 + 必要文件存在。CI 跑前先校验一次，避免到上传 artifact 阶段才发现。
//
// 用法：node apps/worker/scripts/dist-check.mjs
// 退出码：0 OK；非 0 输出原因。
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(here, "..");

const issues = [];

function check(condition, message) {
  if (!condition) issues.push(message);
}

const pkg = JSON.parse(readFileSync(resolve(workerDir, "package.json"), "utf-8"));

check(pkg.build, "package.json 缺少 build 字段（electron-builder 配置）");
check(pkg.build?.appId, "build.appId 缺失");
check(pkg.build?.productName, "build.productName 缺失");
check(pkg.build?.directories?.output, "build.directories.output 缺失");
check(pkg.build?.win?.target?.length, "build.win.target 缺失或为空");
check(pkg.build?.mac?.target?.length, "build.mac.target 缺失或为空");

check(existsSync(resolve(workerDir, "preload.cjs")), "缺 preload.cjs");
check(existsSync(resolve(workerDir, "prompts")), "缺 prompts/ 目录");
check(existsSync(resolve(workerDir, "config")), "缺 config/ 目录");

// dist 不存在不报错：CI 在 dist:check 后跑 build，本机也可能没 build 过。
if (!existsSync(resolve(workerDir, "dist/main.js"))) {
  console.log("[dist-check] 提示：dist/main.js 不存在，需要先跑 npm -w @claude-center/worker run build");
}

if (issues.length === 0) {
  console.log("[dist-check] OK");
  console.log(`  appId:       ${pkg.build.appId}`);
  console.log(`  productName: ${pkg.build.productName}`);
  console.log(`  version:     ${pkg.version}`);
  console.log(`  win:         ${JSON.stringify(pkg.build.win.target)}`);
  console.log(`  mac:         ${JSON.stringify(pkg.build.mac.target)}`);
  process.exit(0);
}

console.error("[dist-check] 失败：");
for (const issue of issues) console.error(`  - ${issue}`);
process.exit(1);
