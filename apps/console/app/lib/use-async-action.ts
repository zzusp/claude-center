"use client";

import { useCallback, useState } from "react";

// 异步动作的 busy/error 三元组 + try/catch/finally 收敛。取代散落 7+ 处的:
//   const [busy, setBusy] = useState(false); const [error, setError] = useState<string|null>(null);
//   ... setBusy(true); setError(null); try { await ... } catch { setError(...) } finally { setBusy(false) }
//
// 用法:
//   const { busy, error, setError, run } = useAsyncAction();
//   <button disabled={busy} onClick={() => run(async () => { await postJson(...); onDone(); })}>
//   {error && <p className="err">{error}</p>}
//
// run 返回是否成功(true=无异常),便于调用方在成功后做后续(如关闭抽屉)。
export function useAsyncAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, setError, run };
}
