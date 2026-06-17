// 对 probe 产出的 timeline.json 做统一口径分析：
//  (A) 真·重复签名——每次导航窗口内，同一初始化接口(method+path+query)在 <300ms 内出现 ≥2 次
//      （这是 StrictMode 二重挂载/二次 effect 的特征；relay/interval 触发的二次刷新都在秒级，不算）。
//  (B) 通知节奏——home-dwell 窗口内 /api/notifications 相邻间隔。
// 用法：node analyze.mjs <timeline.json 路径>
import { readFileSync } from "node:fs";

const file = process.argv[2];
const d = JSON.parse(readFileSync(file, "utf8"));
const tl = d.timeline;
const DUP_MS = 300;

console.log(`\n#### ${d.label}  (${file})`);

// (B) 通知节奏
const notif = tl.filter((e) => e.path === "/api/notifications" && e.t >= d.dwellMark);
const cad = [];
for (let i = 1; i < notif.length; i++) cad.push(((notif[i].t - notif[i - 1].t) / 1000).toFixed(2));
console.log(`通知(home-dwell): ${notif.length} 次  间隔(s)=[${cad.join(", ")}]`);

// (A) 每次导航窗口内的真·重复
console.log("各导航初始化接口 — 同接口 <300ms 内重复次数：");
for (let i = 0; i < d.navMarks.length; i++) {
  const start = d.navMarks[i].at;
  const end = i + 1 < d.navMarks.length ? d.navMarks[i + 1].at : start + 4500; // 统一窗口 4.5s，避免末段窗口无界
  const win = tl.filter((e) => e.t >= start && e.t < end);
  const byKey = {};
  for (const e of win) {
    const k = `${e.method} ${e.path}${e.search}`;
    (byKey[k] = byKey[k] || []).push(e.t);
  }
  const dups = [];
  for (const [k, ts] of Object.entries(byKey)) {
    ts.sort((a, b) => a - b);
    for (let j = 1; j < ts.length; j++) if (ts[j] - ts[j - 1] < DUP_MS) dups.push(`${k} (Δ${ts[j] - ts[j - 1]}ms)`);
  }
  console.log(`  nav ${d.navMarks[i].route.padEnd(9)} -> ${dups.length ? dups.join("; ") : "无重复"}`);
}
