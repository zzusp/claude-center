// 假 gh：通过 NODE_OPTIONS=--require 注入到 gh 子进程（gh 命令设为 node.exe）。
// gh 调用首个参数恒为 "pr"（无前导短横），node 据此停止解析自身选项、把 "pr" 当脚本名；本 hook 在
// bootstrap 阶段（脚本解析前）拦截、模拟 gh 行为后 process.exit，"pr" 脚本永不被加载。
// 行为受环境变量控制：FAKE_GH_MERGEABLE（"false" → 不可合并），FAKE_GH_CAPTURE（调用记录 JSONL 路径）。
const fs = require("fs");
const path = require("path");
const argv = process.argv; // [nodeExe, "<cwd>/pr"(被 node 解析成主模块绝对路径), <sub>, ...rest]
// node 把 gh 的首参 "pr"（无前导短横）当主模块名、解析成绝对路径，故按 basename 识别 gh 形态。
if (path.basename(argv[1] || "") !== "pr") return; // 非 gh 形态：放行

const sub = argv[2];
const capture = process.env.FAKE_GH_CAPTURE;
const record = (obj) => { if (capture) fs.appendFileSync(capture, JSON.stringify(obj) + "\n"); };
const out = (s) => fs.writeSync(1, s); // 同步写 fd1，避免 process.exit 截断管道

if (sub === "list") {
  record({ cmd: "list" });
  out("[]"); // 无已存在 PR → 走 gh pr create
  process.exit(0);
}
if (sub === "create") {
  const bi = argv.indexOf("--body");
  const ti = argv.indexOf("--title");
  record({ cmd: "create", title: ti >= 0 ? argv[ti + 1] : "", body: bi >= 0 ? argv[bi + 1] : "" });
  out("https://github.com/fake/repo/pull/1\n");
  process.exit(0);
}
if (sub === "view") {
  const bad = process.env.FAKE_GH_MERGEABLE === "false";
  const mergeable = bad ? "CONFLICTING" : "MERGEABLE";
  const mergeStateStatus = bad ? "DIRTY" : "CLEAN";
  record({ cmd: "view", mergeable, mergeStateStatus });
  out(JSON.stringify({ mergeable, mergeStateStatus }));
  process.exit(0);
}
if (sub === "merge") {
  record({ cmd: "merge" });
  process.exit(0);
}
record({ cmd: "unknown", argv: argv.slice(1) });
process.exit(0);
