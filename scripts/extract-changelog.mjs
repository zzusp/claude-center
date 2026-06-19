#!/usr/bin/env node
// 从 CHANGELOG-{console,worker}.md 抽取指定版本节，给 CI release notes 与本地发版自检共用。
//
// 用法：
//   node scripts/extract-changelog.mjs CHANGELOG-console.md 0.2.0
//   node scripts/extract-changelog.mjs CHANGELOG-worker.md  0.1.0 --check
//
// 行为：
//   stdout 打印 ## [0.2.0] 行下方、直到下一个 ## 标题前的正文（不含标题行本身）；
//   --check 时不输出，仅校验节存在且非空；
//   找不到节 → exit 1，error 写 stderr。
//
// 规则：
//   - 严格匹配 `## [VERSION]` 或 `## [VERSION] - YYYY-MM-DD`；
//   - 正文 trim 后必须非空（防写半截 release notes 就 push tag）；
//   - 抽出内容会把 Markdown 直接交给 gh release --notes，需保持有效 Markdown。
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const [, , file, version, ...rest] = process.argv;
const checkOnly = rest.includes("--check");

if (!file || !version) {
  console.error("用法：node scripts/extract-changelog.mjs <file> <version> [--check]");
  process.exit(2);
}

const path = resolve(process.cwd(), file);
if (!existsSync(path)) {
  console.error(`[extract-changelog] 文件不存在：${path}`);
  process.exit(1);
}

const text = readFileSync(path, "utf-8");
const lines = text.split(/\r?\n/);

// 寻找 `## [VERSION]` 起始行（允许 `## [VERSION]` 或 `## [VERSION] - 2026-06-19`）。
const startRe = new RegExp(`^##\\s+\\[${version.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\](\\s|$)`);
let startIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (startRe.test(lines[i])) {
    startIdx = i;
    break;
  }
}
if (startIdx === -1) {
  console.error(`[extract-changelog] 未在 ${file} 找到 \`## [${version}]\` 节`);
  process.exit(1);
}

// 找下一个 `## ` 标题或文件末尾。
let endIdx = lines.length;
for (let i = startIdx + 1; i < lines.length; i++) {
  if (/^##\s+/.test(lines[i])) {
    endIdx = i;
    break;
  }
}

const body = lines.slice(startIdx + 1, endIdx).join("\n").trim();
if (!body) {
  console.error(`[extract-changelog] \`## [${version}]\` 节正文为空，请先写好 release notes 再发版`);
  process.exit(1);
}

if (checkOnly) {
  console.error(`[extract-changelog] OK: ${file} 包含非空 [${version}] 节（${body.split("\n").length} 行）`);
  process.exit(0);
}

process.stdout.write(body);
process.stdout.write("\n");
