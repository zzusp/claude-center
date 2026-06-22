// 验证 parseTestPlan（自动合并门禁的核心判定）。
// 跑：npx tsx docs/acceptance/pr-testplan-gate/scripts/verify-parse-testplan.mts
import { parseTestPlan } from "../../../../apps/worker/src/test-plan.ts";

type Case = { name: string; md: string; wantFound: boolean; wantAllPassed: boolean; wantTotal: number; wantPassed: number };

const cases: Case[] = [
  {
    name: "全部打勾 → 放行",
    md: [
      "## Summary", "改了点东西。", "",
      "## Test Plan",
      "- [x] typecheck 通过",
      "- [x] build 通过"
    ].join("\n"),
    wantFound: true, wantAllPassed: true, wantTotal: 2, wantPassed: 2
  },
  {
    name: "含未测试（空 checkbox）→ 拦截",
    md: ["## Test Plan", "- [x] typecheck", "- [ ] e2e 未跑"].join("\n"),
    wantFound: true, wantAllPassed: false, wantTotal: 2, wantPassed: 1
  },
  {
    name: "含未通过（❌）→ 拦截",
    md: ["## Test Plan", "- [x] typecheck", "- [ ] build 失败 ❌"].join("\n"),
    wantFound: true, wantAllPassed: false, wantTotal: 2, wantPassed: 1
  },
  {
    name: "打勾但带 ❌（自相矛盾）→ 该条判未通过",
    md: ["## Test Plan", "- [x] 看似通过其实失败 ❌"].join("\n"),
    wantFound: true, wantAllPassed: false, wantTotal: 1, wantPassed: 0
  },
  {
    // 回归：用例描述里出现英文 "failed/fail" 是正常文案，勾选了就算通过，不能误判失败。
    // 真实触发：任务 a262645f 的 case C「仍含 `Command failed: curl ... Bearer ***`」被错拦自动合并。
    name: "勾选项描述含英文 failed/fails → 仍判通过（回归）",
    md: [
      "## Test Plan",
      "- [x] runCommand 非零退出：error.message 仍含 `Command failed: curl ... Bearer ***`",
      "- [x] assert it fails when token missing",
      "- [x] 处理 failing input 不崩溃"
    ].join("\n"),
    wantFound: true, wantAllPassed: true, wantTotal: 3, wantPassed: 3
  },
  {
    // 用户确认的规则：checkbox 状态即真值——只勾选通过项，失败 / 未验证都不勾选。
    // 三态混排：通过(勾) + 失败(不勾 ❌) + 未验证(不勾) → 仅 1/3 通过 → 拦截自动合并。
    name: "只勾选通过项（失败/未验证不勾选）→ 未全通过则拦截",
    md: [
      "## Test Plan",
      "- [x] 通过的用例（已验证）",
      "- [ ] 失败的用例 ❌",
      "- [ ] 未验证的用例"
    ].join("\n"),
    wantFound: true, wantAllPassed: false, wantTotal: 3, wantPassed: 1
  },
  {
    name: "无 Test Plan → found=false → 拦截",
    md: ["## Summary", "只有总结，没有测试计划。", "", "## Changes", "- a.ts:1 改了"].join("\n"),
    wantFound: false, wantAllPassed: false, wantTotal: 0, wantPassed: 0
  },
  {
    name: "Test Plan 后接其它标题 → 不误收后续 checkbox",
    md: [
      "## Test Plan",
      "- [x] case A",
      "## Follow-up",
      "- [ ] 后续待办（不算测试用例）"
    ].join("\n"),
    wantFound: true, wantAllPassed: true, wantTotal: 1, wantPassed: 1
  },
  {
    name: "大小写 [X] + 星号 bullet + 大写标题",
    md: ["### TEST PLAN", "* [X] 大写勾", "* [ ] 空"].join("\n"),
    wantFound: true, wantAllPassed: false, wantTotal: 2, wantPassed: 1
  },
  {
    name: "CRLF 换行",
    md: "## Test Plan\r\n- [x] a\r\n- [x] b\r\n",
    wantFound: true, wantAllPassed: true, wantTotal: 2, wantPassed: 2
  }
];

let failures = 0;
for (const c of cases) {
  const r = parseTestPlan(c.md);
  const ok =
    r.found === c.wantFound &&
    r.allPassed === c.wantAllPassed &&
    r.total === c.wantTotal &&
    r.passed === c.wantPassed;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.name}  -> found=${r.found} allPassed=${r.allPassed} ${r.passed}/${r.total}`
  );
  if (!ok) {
    failures++;
    console.log(
      `      want: found=${c.wantFound} allPassed=${c.wantAllPassed} ${c.wantPassed}/${c.wantTotal}`
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} case(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} cases PASS`);
