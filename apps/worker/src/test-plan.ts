// Test Plan 解析（docs/spec/pr-body-testplan-merge-gate.md）。
// 纯函数、零依赖——独立成模块便于单测（避免为测一段正则而 import 整个 executor 把 pg/child_process 也拉进来）。
//
// 约定（见 apps/worker/prompts/center-rules.md）：Claude 最终产出含一段 `## Test Plan`，用 GitHub
// 任务列表，一条 checkbox 一个验证用例——通过 `- [x]`、未通过 `- [ ] … ❌`、未测试 `- [ ]`。
// 自动合并门禁：只有 found 且全部通过（allPassed）才放行。

export type TestPlanItem = { label: string; passed: boolean };
export type TestPlanResult = {
  found: boolean;
  total: number;
  passed: number;
  items: TestPlanItem[];
  allPassed: boolean;
};

// 失败标记：勾选了 [x] 但带 ❌/✗/FAIL 仍判未通过（防 Claude 自相矛盾地把失败项打了勾）。
const FAIL_MARK = /[❌✗✘]|\bFAIL(?:ED|ING)?\b/i;

export function parseTestPlan(output: string): TestPlanResult {
  const items: TestPlanItem[] = [];
  let inSection = false;
  for (const line of output.split(/\r?\n/)) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      // 命中 Test Plan 标题进入该段；段内再遇任意标题即结束。
      inSection = /test\s*plan/i.test(heading[1] ?? "");
      continue;
    }
    if (!inSection) continue;
    const box = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.*)$/);
    if (!box) continue;
    const checked = (box[1] ?? "").toLowerCase() === "x";
    const label = (box[2] ?? "").trim();
    items.push({ label, passed: checked && !FAIL_MARK.test(label) });
  }
  const total = items.length;
  const passed = items.filter((i) => i.passed).length;
  const found = total > 0;
  return { found, total, passed, items, allPassed: found && passed === total };
}
