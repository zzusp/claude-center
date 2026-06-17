// Suspense fallback：路由切换时立刻顶上去，避免点击后停留在旧页等服务端 RSC 返回。
// 用 view 容器的 padding 维持版式一致，骨架走轻量灰块 + cc-skeleton 呼吸闪烁动画。
// 系统级 header 由 Shell 统一渲染，loading 只负责 view 内的卡片骨架。
export default function Loading() {
  return (
    <div className="view" aria-busy="true" aria-live="polite">
      <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
        <span style={skeletonStyle("40%", 16)} />
        <span style={skeletonStyle("100%", 12)} />
        <span style={skeletonStyle("90%", 12)} />
        <span style={skeletonStyle("75%", 12)} />
      </div>
    </div>
  );
}

function skeletonStyle(width: number | string, height: number): React.CSSProperties {
  return {
    display: "inline-block",
    width: typeof width === "number" ? `${width}px` : width,
    height: `${height}px`,
    borderRadius: 6,
    background: "var(--surface-2)",
    animation: "cc-skeleton 1.4s ease-in-out infinite"
  };
}
