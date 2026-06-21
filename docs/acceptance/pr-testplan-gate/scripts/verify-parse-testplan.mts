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
