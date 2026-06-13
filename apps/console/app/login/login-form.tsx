"use client";

import { Boxes, LogIn } from "lucide-react";
import { FormEvent, useState } from "react";

export default function LoginForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: data.get("username"), password: data.get("password") })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `登录失败：${response.status}`);
      }
      // 登录成功，整页跳转到中控台（服务端会带上新 cookie 渲染）。
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark">
            <Boxes size={20} />
          </span>
          <span className="brand-text">ClaudeCenter</span>
        </div>
        <h1 className="login-title">登录中控台</h1>
        <p className="login-sub">AI 编码协作中央控制台</p>
        <form className="form" onSubmit={handleSubmit}>
          <div className="field">
            <label className="field-label">用户名</label>
            <input name="username" autoComplete="username" placeholder="admin" required autoFocus />
          </div>
          <div className="field">
            <label className="field-label">密码</label>
            <input name="password" type="password" autoComplete="current-password" placeholder="••••••••" required />
          </div>
          {error ? <div className="error-box">{error}</div> : null}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            <LogIn size={16} />
            {busy ? "登录中…" : "登录"}
          </button>
        </form>
      </div>
    </div>
  );
}
