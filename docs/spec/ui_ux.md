# ClaudeCenter · Claude 风格 UI/UX 设计系统说明（产品级）

---

# 1. 设计理念（Design Philosophy）

## 1.1 核心定位

ClaudeCenter 不是传统 Dashboard，而是：

> **AI 编码任务调度系统（AI Ops Control Plane）**

它的设计目标：

- 让用户像“指挥系统”一样调度 AI Worker
- 让复杂系统状态“一眼可读”
- 支持高密度信息长期监控而不疲劳

---

## 1.2 Claude 风格本质（不是“白色简洁 UI”）

### A. Calm Intelligence（克制智能感）

- 降低视觉噪音
- 弱化颜色存在感
- 强化信息结构而非装饰

---

### B. Soft but Professional

- 圆角（8~12px）
- 极轻阴影
- 几乎无边框干扰
- 通过灰阶区分层级

---

### C. 文档感 UI（Documentation UI System）

UI 结构类似“技术文档”：

- 卡片 = 段落
- 表格 = 数据结构
- 面板 = 模块章节

---

### D. 状态优先设计（AI 系统特征）

重点不是展示内容，而是：

> **展示系统正在发生什么**

---

# 2. 信息架构（Information Architecture）

## 2.1 四大核心模块

```
ClaudeCenter
├── Dashboard（全局态势）
├── Tasks（任务调度中心）
├── Workers（执行集群）
├── Projects（代码资源）
```

---

## 2.2 Sidebar 设计原则

Sidebar 不只是菜单，而是：

> System Index（系统索引）

特点：

- 永久可见
- icon + 极短 label
- 当前项使用浅灰背景高亮
- 不使用强品牌色

---

## 2.3 页面职责

### Dashboard
- 系统健康状态
- Worker 在线率
- Task backlog
- 异常提示

👉 战情室视图

---

### Tasks（核心页面）

- 任务流列表（高密度表格）
- 状态流转
- PR / branch tracking
- Worker 分配

👉 指挥调度台

---

### Workers

- 在线 / 离线
- 当前任务
- 心跳状态
- 历史执行

👉 执行机群视图

---

### Projects

- repo 管理
- branch 默认配置
- 任务绑定关系

---

# 3. 视觉系统（Design System）

---

# 3.1 色彩系统（Claude Light AI）

## Neutral Colors

```
--bg:        #FAFAF9
--surface-1: #FFFFFF
--surface-2: #F5F5F4
--border:    #E7E5E4
```

---

## Text Colors

```
--text-1: #1C1917
--text-2: #44403C
--text-3: #78716C
--text-4: #A8A29E
```

---

## 状态色（重点：不依赖颜色）

```
Success   #16A34A + ●
Running   #2563EB + ◐
Pending   #F59E0B + ○
Failed    #DC2626 + ✕
Cancelled #6B7280 + —
Queued    #A855F7 + ◻
```

核心原则：

> 状态必须“颜色 + 图标 + 文本”三重表达

---

# 3.2 字体系统（Typography）

```
Font EN: Inter / system-ui
Font CN: PingFang SC / Microsoft YaHei
Mono: JetBrains Mono
```

---

## 字体层级

```
H1: 28px / 600
H2: 20px / 600
H3: 16px / 600
Body: 14px / 400
Caption: 12px / 400
```

---

核心原则：

- 少装饰
- 强层级
- 行高 1.5 ~ 1.7

---

# 3.3 间距系统（8px Grid）

```
4px   micro spacing
8px   base
12px  compact
16px  default
24px  section
32px  block
48px  page
```

---

# 3.4 卡片系统（Card System）

## 基础规则

```
border: 1px solid #E7E5E4
radius: 12px
shadow: minimal (hover only)
```

---

## 卡片类型

### 1. Stat Card（指标）

- KPI 数字
- sparkline
- 状态摘要

---

### 2. List Card（列表）

- Tasks / Workers
- 高密度信息

---

### 3. Detail Panel（详情）

- Task full lifecycle
- log / timeline

---

# 3.5 表格系统（核心）

特点：

- 高密度（dense table）
- 行高 44px
- hover 高亮行
- 状态 badge 左侧
- 操作右对齐

---

# 3.6 状态系统（Task Lifecycle）

```
Pending   ○
Queued    ◻
Running   ◐
Success   ●
Failed    ✕
Cancelled —
```

---

## 设计原则

### 1. 状态不可只靠颜色
必须有：
- icon
- text
- color

---

### 2. Running 状态必须有 motion

- breathing dot
- subtle pulse
- progress transition

---

# 3.7 交互系统（Interaction）

## 实时更新

- 1~3 秒 polling
- diff update（非整页刷新）
- 数值 transition（0.2~0.3s）

---

## Task Detail 结构

```
Header
├── 状态 + PR + branch

Tabs
├── Overview
├── Timeline
├── Logs
├── Errors
```

---

## Logs 设计

- JetBrains Mono
- 灰底非纯黑 terminal
- 支持折叠阶段
- 支持关键行 highlight

---

# 3.8 Worker 设计

```
[●] worker-01
10.0.0.12
v1.4.2
heartbeat: 3s ago
current: task-xxx
```

hover：

- CPU mini chart
- memory mini chart

---

# 3.9 动效系统（Motion）

```
hover: 120ms
transition: 200–300ms
panel open: 250ms ease-out
```

禁止：

- bounce
- elastic
- overshoot

---

# 3.10 Layout Grid

## Desktop

```
Sidebar: 240px
Main: fluid
Right panel: 360px (optional)
```

---

## Task Page

```
| Task Table (70%) | Worker Panel (30%) |
```

---

# 4. Claude 风格总结

核心不是“好看 UI”，而是：

> **AI 系统操作语言（System UI Language）**

三大原则：

### 1. 信息 > 视觉
### 2. 状态 > 装饰
### 3. 结构 > 风格

---
