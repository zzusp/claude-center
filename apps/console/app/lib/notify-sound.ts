"use client";

// 新通知提示音：用 Web Audio 现场合成一段轻短的双音「叮咚」，不引入二进制音频资源
// （仓库无 public 资源目录，也不想为一个提示音入库 binary）。
//
// 浏览器自动播放策略：AudioContext 初次创建为 suspended，需用户在页面上有过交互才能 resume。
// 用户在用 Console 时通常已有点击 / 导航等交互，resume() 会成功；拿不到权限则静默放弃——
// 提示音只是锦上添花，红点与下拉列表才是权威，失声不降级。

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  return ctx;
}

// 在给定起点播一个单音：sine 波 + 指数淡入淡出包络，防爆音。
function playTone(ac: AudioContext, freq: number, startAt: number, dur: number): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  const end = startAt + dur;
  // exponentialRamp 不能到 0，用极小值代替。
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.18, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(gain).connect(ac.destination);
  osc.start(startAt);
  osc.stop(end + 0.02);
}

// 约 0.4s 的双音上行提示（A5 → E6），与系统通知音区分、又不刺耳。
function ding(ac: AudioContext): void {
  const now = ac.currentTime;
  playTone(ac, 880, now, 0.18);
  playTone(ac, 1318.5, now + 0.16, 0.26);
}

export function playNotifySound(): void {
  const ac = getCtx();
  if (!ac) return;
  if (ac.state === "running") {
    ding(ac);
    return;
  }
  // suspended：尝试 resume（仅在有用户交互时成功），成功后再发声。
  void ac
    .resume()
    .then(() => {
      if (ac.state === "running") ding(ac);
    })
    .catch(() => {
      /* 无用户手势，静默跳过 */
    });
}
