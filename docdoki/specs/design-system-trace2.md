# Trace 2 Design System

## 文档定位

建议仓库路径：

```text
docdoki/specs/design-system-trace2.md
```

批准前状态：

```yaml
status: proposed-design-authority
supersedes-on-approval: docdoki/specs/design-system.md
```

它沿用原仓库设计规范的形式，包含 YAML frontmatter、覆盖文件范围、完整 token、组件合同、响应式、无障碍与测试要求。

## 品牌合同

### 可见名称

```text
InsΠRe
```

### 无障碍与发音

```text
Inspire
```

### 技术标识

以下标识不随视觉品牌迁移：

```text
pi-inspire
inspire
inspire-pi-gui
现有 package / executable / URL / storage key / RPC identifier
```

### Logo

主标默认采用 Open Reticle：

- 纯几何。
- 不包含字母或希腊字母。
- 左上和右下外框开放。
- 单色下也必须成立。
- 不依赖 teal 才能辨识。
- 16px favicon 必须进行独立 optical 调整。
- 不使用圆形外框、发光、渐变、玻璃或 3D 效果。

正式字标使用自定义 SVG `InsΠRe`，`Π` 使用 accent，其余字母使用 ink。外层 accessible name 为 `Inspire`。

## 核心颜色 Token

### Light

```yaml
canvas: "#F3F5F3"
rail: "#E5E9E6"
stage: "#FBFCFB"
surface: "#FFFFFF"
surface-inset: "#E9ECEA"

line: "#D6DBD8"
line-strong: "#AAB3AE"

ink: "#141816"
body: "#2B322E"
muted: "#606963"
faint: "#6A736E"

accent: "#007D78"
accent-hover: "#008B85"
accent-fill: "#00746F"
accent-deep: "#005E5A"
accent-active: "#004D49"
accent-tint: "rgba(0, 125, 120, 0.07)"
on-accent: "#FFFFFF"

success: "#2F774C"
warning: "#8C6200"
error: "#B43731"
info: "#3F638A"
think: "#675B99"
```

### Dark

```yaml
canvas: "#101210"
rail: "#131614"
stage: "#171A18"
surface: "#1E221F"
surface-raised: "#252A27"
surface-inset: "#0B0D0C"

line: "#2B302D"
line-strong: "#454D48"

ink: "#F0F2F1"
body: "#CDD2CF"
muted: "#9AA39E"
faint: "#8D9691"

accent: "#52D2C9"
accent-hover: "#6DE2D9"
accent-fill: "#42C5BC"
accent-active: "#2FAAA2"
on-accent: "#071D1B"

success: "#63C78E"
warning: "#E1B35E"
error: "#EA8A82"
info: "#86AEDD"
think: "#B8A8E8"
```

色彩纪律：

- Neutral surface 应覆盖 settled screen 约 95% 或以上。
- Teal 只承担品牌、链接、焦点、当前项和主操作。
- Success、warning、error 不得被品牌 teal 替代。
- 任何状态不得只靠颜色表达。
- 灰阶状态下，页面空间层级仍必须成立。

## 字体

```yaml
sans: "'IBM Plex Sans SC', system-ui, sans-serif"
mono: "'Flux Mono SC', ui-monospace, monospace"
wordmark: "custom outlined SVG"
```

字号：

```yaml
xs: 11.5px
sm: 12.5px
base: 14px
reading: 15.5px
h3: 17px
h2: 21px
h1: 26px
display: 32px
```

规则：

- 600 是系统最大字重。
- 普通 UI 和正文使用 IBM Plex Sans SC。
- 路径、模型 ID、时间、计数、快捷键和代码使用 Flux Mono SC。
- 普通按钮和段落禁止为了技术感改为 monospace。
- KaTeX 保持自己的字体。

## 间距与几何

```yaml
spacing:
  unit: 4px
  scale: [4, 8, 12, 16, 20, 24, 32, 40, 48, 64]

geometry:
  radius-none: 0px
  radius-xs: 2px
  radius-control: 3px
  radius-surface: 4px
  radius-overlay: 6px
  line: 1px
  witness: 2px
  resize-hit-area: 8px
```

`999px` 只允许用于真正的圆形进度、spinner 或 OS icon mask，不再作为普通 chip、tab、input 和 badge 的默认形状。

## 工作台框架

```text
Nav rail | Center workbench | Context pane
```

尺寸合同：

```yaml
reading-column: 820px
reading-column-medium: 760px
reading-column-compact: 700px

nav-default: 272px
nav-range: 220px–460px
nav-collapsed: 48px

context-default: clamp(360px, 38vw, 760px)
context-range: 320px–920px

topbar-desktop: 52px
topbar-mobile: 48px
```

Reading stage：

- 使用独立 stage 材质。
- Transcript 与 Composer 共享左右 datum。
- 不使用整张大卡片和阴影。
- Grid 只能出现在宽屏外围 gutter。
- 代码、数学、表格和 Composer 后方禁止出现 grid。

Witness rail：

- 当前 session：左侧。
- 当前 file：左侧。
- 当前 context tab：底部。
- Activity 类型：左侧。
- Notice severity：左侧。
- Focused Composer：固定一侧。

## 动效

```yaml
micro: 90ms ease-out
standard: 150ms ease-out
panel: 180ms ease-out
spinner: 900ms linear loop
```

允许：

- hover/focus 色彩过渡。
- opacity + 4px translate overlay。
- opacity + height 的活动折叠。
- 线性 spinner。

禁止：

- breathing opacity。
- expanding halo。
- card scale-in。
- bounce/spring。
- 完成庆祝动画。
- 逐 token 飞入。
- 完成状态持续运动。

## Transcript 合同

### 用户消息

- 与 reading datum 对齐。
- 中性 inset surface。
- 3px radius。
- 2px accent witness。
- 不再右侧漂浮。
- 不新增当前不存在的用户角色或 token 信息。

### Assistant 正文

- 不包入大卡片。
- 正文 15.5px / 1.7。
- H1/H2/H3 为 26/21/17px。
- 阅读宽度 72–82ch。
- Link 使用 accent-deep。
- Streaming 不逐 token 做动画。

### Activity Stack

每行固定结构：

```text
type witness | tool glyph | operation / summary | runtime status | disclosure
```

- Row 最小 32–36px。
- 整个 stack 最多一个外框。
- Expanded body 紧邻对应 row。
- Type 与 runtime 使用不同位置。
- Expanded、Collapsed、Compact、Dynamic 只改变密度，不改变生命周期和业务分组。
- Terminal state 静止。

### Code

- 4px radius。
- 1px line。
- 无阴影。
- Mono 12.5–13px / 1.6。
- 横向滚动只发生在 code block 内。

### Table

- 行分隔为主。
- 默认不使用 zebra。
- 数字采用 tabular nums。
- 宽表格只在自身容器滚动。

### Math

- 不修改 KaTeX 字形。
- Display formula 保持 12–16px 垂直间距。
- 超宽公式自身滚动。
- 公式背景保持纯净。

## Composer 合同

Composer 是一个完整 surface：

```text
attachments / references
input
instrument footer
```

- 与 reading column 同宽。
- 4px radius。
- 一个外框。
- 无漂浮渐变。
- 无 glass blur。
- 无 focus halo。
- Input 最大高度 40dvh。
- 中文 IME 期间 Enter 不发送。

Instrument footer：

```text
model / thinking / entries | status / gauge | send / stop / resume
```

- 高度 32–36px。
- 与输入区之间使用 1px datum。
- 精确值使用 mono。
- Send 为 32–34px 方形 accent-fill 按钮。
- Queue 进入固定 status lane。
- 禁止堆叠 breathing chips。

## Navigation 合同

- Expanded header 使用 mark + `InsΠRe`。
- Collapsed rail 只使用 mark。
- Active session 使用 2px left witness + neutral fill。
- 状态使用固定 trailing glyph。
- Running 使用 spinner，completed 使用 check，failed 使用 error glyph。
- Search 使用矩形 field。
- Workspace explorer 保留真实可用空间。
- Tree indentation、git state 和 disclosure 使用固定列。

## Context pane 合同

- Header 与 topbar 同高。
- Files、Changes、History 使用 rectangular tabs。
- 当前 tab 使用 2px bottom witness。
- List active row 使用 left witness。
- Preview 使用 surface 与 inset 材料差，不堆叠 card。
- 现有 PDF、HTML、图片和文件安全合同不改变。

## Overlay 合同

适用于 Command Palette、Settings、Dialog 和 picker：

- 6px 最大半径。
- 1px line。
- Overlay shadow。
- 默认无 backdrop blur，最多 2px。
- 打开关闭使用 opacity + 4px translate。
- 当前结果行使用 witness + neutral fill。
- Dialog 结构固定为标题、说明、内容、操作区。

## 响应式

```text
>1280px      完整三域，reading 820px
1101–1280px  reading 760px
901–1100px   reading 700px
<=900px      nav/context 互斥 drawer
<=600px      search toolbar 全宽
<=420px      Composer footer 可两行
```

移动端要求：

- 触控目标至少 40px。
- Nav 与 context 不同时打开。
- 发送、停止、关闭 drawer 和恢复动作不可隐藏。
- 代码、表格和公式仅自身横向滚动。
- Composer 适配 safe area 和移动键盘。

## 无障碍

- 普通文字至少 4.5:1。
- Focus、witness 和 UI 图形至少 3:1。
- `InsΠRe` 的 accessible name 是 `Inspire`。
- 状态至少提供 glyph、固定位置、文字或 accessible label 中的两个非颜色通道。
- 所有 overlay 关闭后恢复触发器焦点。
- Escape 只关闭最上层 overlay。
- `prefers-reduced-motion` 下取消非必要 transform。
- 保持现有 heading、table、form、combobox 和 dialog semantics。

## 样式与测试合同

`src/styles.css` 继续是迁移期间的实现源。

测试必须覆盖：

```text
tests/web/styles-contract.test.ts
tests/web/app.test.tsx
tests/browser/workbench.spec.ts
tests/browser/visual.spec.ts
```

Styles contract 必须检查：

- 无未声明 CSS variable。
- 无 breathing keyframe。
- `999px` radius 仅出现在 allowlist。
- semantic 状态不被 accent 替代。
- reduced-motion override 存在。
- Light/dark 必要 token 完整。

Browser visual matrix：

```text
1600×1000 light
1600×1000 dark
390×844 light
390×844 dark
```

场景：

- Welcome
- Settled conversation
- Running activity
- Files pane
- Settings
- Command Palette
- Mobile nav drawer
- Mobile Composer

[打开完整的 1510 行 Trace 2 设计规范](sandbox:/mnt/data/design-system-trace2.md)