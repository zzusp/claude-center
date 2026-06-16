🧭 左侧菜单（Sidebar Nav）设计规范
1. 字体（Font）
   👉 主字体（Primary）
   Inter
   fallback: system-ui, -apple-system, Segoe UI
   👉 中文 fallback
   PingFang SC / Microsoft YaHei
2. 字号（Font Size）
   Sidebar menu item：
   14px（标准）
   次级/辅助（如分组标题，如果有）：
   12px
3. 字重（Font Weight）

Claude 风格核心是“克制”，所以：

状态	字重
默认菜单项	400（Regular）
当前选中项	500（Medium）
hover	400（不变，仅背景变化）

👉 ❌ 不使用 bold（600/700）

4. 字体颜色（非常关键）

Claude 风格不是黑白强对比，而是灰阶体系：

默认状态
color: #44403C
hover 状态
color: #1C1917
inactive / disabled（如不可用菜单）
color: #A8A29E
5. 选中状态（Active State）

不是“蓝色高亮文字”，而是：

结构：
背景：#F5F5F4
左侧 2px indicator：#D6D3D1
文字：#1C1917
6. 行高 & 间距
   line-height: 20px
   padding: 10px 12px
   item gap: 4px（icon + text）
7. Icon 风格（配套）
   lucide-react / feather 风格
   stroke: 1.5px
   size: 16px
   color: inherit（跟随文字）
### 📐 Sidebar 菜单最终视觉规范（可直接做 design token）
```css
.sidebar-item {
  font-family: Inter, system-ui, sans-serif;
  font-size: 14px;
  font-weight: 400;
  color: #44403C;

  display: flex;
  align-items: center;
  gap: 8px;

  padding: 10px 12px;
  border-radius: 8px;

  line-height: 20px;
}

.sidebar-item:hover {
  background: #F5F5F4;
  color: #1C1917;
}

.sidebar-item.active {
  background: #F5F5F4;
  color: #1C1917;
  font-weight: 500;
  position: relative;
}

.sidebar-item.active::before {
  content: "";
  position: absolute;
  left: 0;
  width: 2px;
  height: 60%;
  background: #D6D3D1;
  border-radius: 2px;
}
```
🧠 Claude 风格核心结论（很重要）

左侧菜单的设计原则不是“强调导航”，而是：

弱存在感导航（Low-attention navigation）

它的目标是：

不抢主内容注意力
只在“需要切换时”出现存在感
默认像文档目录一样安静
🚫 常见错误（你这个项目一定要避开）
❌ 不要做：
加粗 600/700
纯黑文字 #000
蓝色高亮（SaaS 常见错误）
强阴影 active
大字号（16px+）
✅ Claude 风格正确理解

Sidebar 本质是：

“系统目录，而不是导航组件”