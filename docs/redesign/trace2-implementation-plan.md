---
status: proposed-for-implementation
title: Trace 2 UI/UX 升级实施方案
target-repository: XWIlluDelu/pi-inspire
suggested-path: docs/redesign/trace2-implementation-plan.md
design-authority: docdoki/specs/design-system-trace2.md
baseline-date: 2026-08-17
---

# Trace 2 UI/UX 升级实施方案

## 1. 文档目的

本文件把 `docs/redesign/trace.md` 的方向性原则，转换为一份可以拆分 PR、分配任务、编写测试和验收截图的实施计划。

它解决三个问题：

1. 明确哪些现有产品结构必须保留，避免为了“更像 Trace”而破坏真实功能。
2. 把视觉品牌升级拆成低风险、可回滚的工程阶段。
3. 为每一阶段定义文件范围、交付物、验收条件和自动化测试。

本计划不是产品功能路线图。它只改变同一套产品事实的呈现方式，不新增模型能力、运行状态、设置项、快捷键或上下文数据。

---

## 2. 已锁定的设计决策

以下决策视为本轮升级的前提，不再在各组件中重复讨论。

### 2.1 产品结构

- 保留现有三域工作台：
  - 左侧：会话导航与 workspace explorer。
  - 中央：Transcript 与 Composer。
  - 右侧：按需打开的 Files / Changes / History 上下文面板。
- 保留当前信息架构、状态语义、键盘流程、虚拟列表、资源预览和 Pi Runtime 权威边界。
- 不重写 store、controller、RPC 或 session projection，只调整 DOM 包装与视觉表达。
- Composer 继续是一个完整输入区域；模型、thinking、附件、引用、队列状态和发送控件仍属于同一组件。

### 2.2 视觉方向

- 新方向名称：**Trace 2 / Instrument Editorial**。
- 基底：石墨色与瓷白色中性材质。
- 青绿色：继续作为品牌与交互强调色，但不得继续充当大面积纸张染色、面板底色或装饰性渐变。
- 主要几何：直角与 2–4px 小半径。
- 主要结构语言：
  - 1px datum line：区域、工具栏、表头和可比较内容的基准线。
  - 2px witness rail：当前项、焦点、运行状态和语义类型的稳定标记。
- 去除持续呼吸、扩散 halo、卡片 scale-in 和不必要的漂浮渐变。
- 高级感来自尺度、对齐、材质和层级，不来自增加装饰。

### 2.3 品牌与命名

- 页面可见品牌名、欢迎页 wordmark 与浏览器选项卡使用 **`InsΠRe`**。
- 品牌发音与无障碍名称仍为 **Inspire**。
- CLI、包名、仓库名、URL、可执行文件及技术标识继续使用现有 `inspire` / `inspire-pi-gui`，避免兼容性破坏。
- Logo 使用纯几何开放式方形符号；符号内部不得出现 `pi`、`PI`、`π` 或 `Π`。
- 本计划默认以 **Open Reticle** 为主标方向，因为它最接近现有圆形标识的连续性，并且小尺寸识别最稳定。若最终选择 Open Witness 或 Open Scan Field，只替换品牌资产，不改变 UI token 或组件结构。
- 开放角规则：主符号的左上与右下外框缺失；其余结构必须保持视觉重心平衡。

---

## 3. 成功标准

### 3.1 视觉成功

典型 1600×1000 会话界面必须满足：

- 第一眼能识别出稳定的三域工作台，而不是“宽页面中漂浮的一篇文章和一个输入框”。
- 中央 reading stage、Transcript 内容与 Composer 共享明确的左右 datum。
- 青绿色仅出现在品牌、链接、焦点、选择、活动 witness 与少量主操作中。
- 普通界面不出现大面积青绿色 tint、背景渐变、玻璃模糊或持续呼吸动画。
- 覆盖 Logo 后，仍可通过开放方形几何、witness rail、面板切割和字体声部识别产品语言。
- Light 与 dark 使用同一层级逻辑，不是两套独立设计。

### 3.2 可用性成功

- 长篇中文、英文、代码、数学、表格和附件均保持可读。
- 390×844 下发送消息、读取运行状态、打开导航与上下文面板的流程不退化。
- 键盘操作、焦点顺序、Escape 语义、拖放、粘贴与虚拟滚动不退化。
- 任何状态均不得只靠颜色表达。
- `prefers-reduced-motion` 下没有位移、旋转以外的非必要动画；完成态完全静止。
- 无新增外部网络请求、字体依赖或运行时品牌资源请求。

### 3.3 工程成功

每个阶段必须通过：

```bash
npm run format:check
npm run lint
npm run typecheck
npm run build:web
npm test
npm run test:browser
```

最终合并前额外通过：

```bash
npm run check
npm run ci
npm run release:verify
```

---

## 4. 实施策略

### 4.1 不做“大爆炸式重写”

本轮升级采用“保留语义、逐层替换视觉语法”的方式：

1. 先建立 token、品牌资产和 shell。
2. 再改 Transcript 的视觉语法。
3. 再改 Composer 与系统表面。
4. 最后统一响应式、无障碍和截图基线。

禁止在同一 PR 中同时修改：

- store / controller 语义；
- 大规模 JSX 重构；
- 全量 CSS 拆文件；
- 视觉 token；
- 交互逻辑。

当前 `src/styles.css` 是既有 design contract 的实现点，并且测试直接读取该文件。本轮视觉迁移期间继续保持单文件，按现有章节组织；视觉稳定后再单独评估 CSS 模块化，避免把结构重构噪音混入设计评审。

### 4.2 内部对照开关

实施分支临时使用：

```html
<html data-visual="trace2">
```

新 token 与高风险布局规则可以先写为：

```css
:root[data-visual="trace2"] { ... }
```

要求：

- 不把它做成用户可见设置。
- 不写入 preferences。
- 不影响生产数据。
- 视觉方向批准后，将 Trace 2 设为默认并删除旧规则与临时 selector。
- 旧设计只用于对照和回滚，不长期双轨维护。

### 4.3 每个 PR 的截图门槛

每个视觉 PR 至少附带：

- 1600×1000 light。
- 1600×1000 dark。
- 390×844 light。
- 与该 PR 相关的资源面板、设置或 command palette 状态。
- 同一 mock 数据、同一滚动位置和同一窗口尺寸。

---

## 5. 阶段总览

| 阶段 | 目标 | 预计工期* | 主要风险 |
|---|---|---:|---|
| 0 | 基线、对照开关、截图测试 | 1–2 天 | 测试不稳定 |
| 1 | 品牌资产与设计 token | 2–4 天 | 色彩对比、命名遗漏 |
| 2 | 三域 shell 与 reading stage | 3–5 天 | 布局回归、可调整宽度 |
| 3 | Transcript 与 activity stack | 5–8 天 | 虚拟列表测量、动态模式 |
| 4 | Composer 与活动栏 | 3–5 天 | 输入法、附件、菜单锚点 |
| 5 | 导航、上下文与系统表面 | 5–8 天 | 组件覆盖不完整 |
| 6 | 响应式、A11y、截图与清理 | 3–5 天 | 窄屏与 dark 回归 |

\* 估算按一名熟悉 React/CSS 的工程师全职执行；它不是发布日期承诺。

---

# 6. Phase 0 — 基线与验证基础

## 6.1 目标

在改变视觉前，固定可重复的场景、截图尺寸和交互基线。后续任何“更成熟”的判断都必须能在真实内容和真实状态中比较。

## 6.2 文件范围

- `index.html`
- `playwright.config.ts`
- `tests/browser/workbench.spec.ts`
- 新增 `tests/browser/visual.spec.ts`
- 新增 `tests/browser/fixtures/visual-scenarios.ts`
- `docs/screenshots/**`
- `docs/redesign/trace2-implementation-plan.md`

## 6.3 任务

- [ ] 在实现分支为 `<html>` 添加临时 `data-visual="trace2"`。
- [ ] 固定以下视觉场景：
  - welcome。
  - settled conversation：标题、列表、表格、数学、代码。
  - running conversation：thinking + 多工具活动。
  - context Files 打开。
  - context Changes 打开。
  - context History 打开。
  - Settings。
  - Command Palette。
  - 390px 导航 drawer。
  - 390px Composer 多行输入。
- [ ] 新增 Playwright `toHaveScreenshot` 基线；测试中关闭 caret 闪烁与非必要动画。
- [ ] 保留现有 axe 检查，并扩展到 nav、transcript、context pane、settings。
- [ ] 记录当前布局的关键 computed values：
  - nav width。
  - context width。
  - topbar height。
  - transcript content width。
  - composer width。
- [ ] 记录现有 `npm run ci` 结果，确保后续问题不是基线已有失败。

## 6.4 验收

- 同一机器连续运行两次视觉测试无像素抖动。
- 截图不依赖远程资源、时间或随机内容。
- 390×844 axe 结果为零 violation。
- 未改变产品视觉和交互。

---

# 7. Phase 1 — 品牌资产与 Token

## 7.1 目标

先建立新的材质、品牌命名和几何资产，再让组件引用这些角色。不得先在组件里硬编码“看起来像 Trace”的颜色。

## 7.2 文件范围

- `public/favicon.svg`
- `public/app-icon.svg`
- `public/app-icon-maskable.svg`
- `public/app-icon-192.png`
- `public/app-icon-512.png`
- `public/app-icon-maskable-512.png`
- `public/apple-touch-icon.png`
- `index.html`
- `src/components/Wordmark.tsx`
- `src/App.tsx`
- `src/styles.css`
- `scripts/verify-release-package.mjs`
- `tests/web/app.test.tsx`
- `tests/web/styles-contract.test.ts`

## 7.3 品牌任务

- [ ] 绘制 Open Reticle master SVG：
  - 24×24 viewBox。
  - 纯几何。
  - 左上与右下外框开放。
  - 不包含字母或希腊字母。
  - 1.5px 或视觉等效线宽。
  - 中心 aperture 不小于 3×3 视觉单位。
- [ ] 单独绘制 16px favicon optical size，不机械缩放 master。
- [ ] 为 light、dark、maskable 和 Apple icon 输出对应资产。
- [ ] `Wordmark.tsx` 改为 `InsΠRe`：
  - 可见字形使用自定义 SVG wordmark，或以 `aria-hidden` 的文本构造作为过渡。
  - 外层 `aria-label="Inspire"`。
  - 不再使用 italic serif 与 `<em>π</em>`。
- [ ] `composeDocumentTitle()` 改为：
  - 无会话：`InsΠRe`
  - 有会话：`${sessionName} · InsΠRe`
  - attention 标记继续保留。
- [ ] 更新 `index.html` 的 `<title>`、PWA 名称和图标链接。
- [ ] 不修改 CLI、package name、bin name 与 release 命令。

## 7.4 Token 任务

- [ ] 将中性底材从 cool-green paper 调整为 graphite + porcelain。
- [ ] 增加：
  - `--bg-rail`
  - `--bg-stage`
  - `--line`
  - `--line-strong`
  - `--witness`
  - `--radius-control`
  - `--radius-surface`
  - `--radius-overlay`
- [ ] 保留旧变量名作为短期 alias，避免一次性改动 5000 行 CSS。
- [ ] 将青绿色语义限定为：
  - focus。
  - active selection。
  - link。
  - primary action。
  - live/current witness。
  - wordmark 的 `Π`。
- [ ] 删除或禁用：
  - `chip-breathe`
  - `dot-breathe`
  - 大面积 accent background。
  - 普通 surface 的渐变。
- [ ] 更新 `styles-contract.test.ts`：
  - 继续检查未声明变量。
  - 断言不存在 `@keyframes chip-breathe` 与 `@keyframes dot-breathe`。
  - 断言状态仍分别使用 success/warning/error。
  - 断言 accent 不被用于 error/success 的替代。

## 7.5 验收

- Light 与 dark 的文字对比符合 WCAG AA。
- 16px favicon 在浅色与深色浏览器 tab 中可辨识。
- `InsΠRe` 在 nav、welcome、token gate 与浏览器标题中一致。
- 典型会话截图中青绿色不成为大面积底色。
- release verifier 能找到全部图标资产。

---

# 8. Phase 2 — Shell 与 Reading Stage

## 8.1 目标

把“漂浮文章 + 漂浮输入框”变成稳定的工作台构图，同时保留现有可调整导航与上下文宽度。

## 8.2 文件范围

- `src/App.tsx`
- `src/components/AppTopbar.tsx`
- `src/components/Nav.tsx`
- `src/components/ResourcesPane.tsx`
- `src/components/PaneResizeHandle.tsx`
- `src/styles.css`
- `tests/web/pane-resize.test.tsx`
- `tests/browser/visual.spec.ts`

## 8.3 DOM 调整

在 session 页面中引入一个共享容器：

```tsx
<main className="center">
  <AppTopbar />
  <section className="reading-stage">
    <Transcript />
    <div className="composer-dock">
      <ActivityBar />
      <Composer />
    </div>
  </section>
</main>
```

要求：

- `reading-stage` 只承担视觉与布局，不拥有业务状态。
- Transcript 仍是唯一滚动日志。
- Composer 仍固定在中央区域底部。
- virtualizer 的 scroll element 不改变。
- Welcome 使用平行的 `start-stage`，不强行复用 Transcript DOM。

## 8.4 Shell 任务

- [ ] `.app` 保留 flex 三域结构。
- [ ] nav 与 context 使用 `--bg-rail` / `--bg-surface` 的材料差，而不是阴影。
- [ ] nav 右边与 context 左边各使用一条 1px `--line`；resize handle 继续跨边界。
- [ ] topbar 使用 52px 高度和 1px 底线；不使用浮动阴影。
- [ ] `reading-stage`：
  - 占满 center 可用空间。
  - 使用 `--bg-stage`。
  - Transcript 与 Composer 共享 `--content-max`。
  - stage 左右边界只在足够宽的桌面出现；窄屏取消装饰性边界。
- [ ] 移除 `.composer-dock` 向上的 canvas gradient。
- [ ] transcript search 从 pill 改为矩形 reserved toolbar：
  - 桌面位于 stage 顶部 40px 工具行。
  - 空闲时仍可发现。
  - 不覆盖滚动内容。
  - 窄屏可折叠为搜索图标，展开后占满工具行。
- [ ] 保留 nav/context 拖拽宽度的 storage key 与 min/max。
- [ ] 网格若使用，仅允许出现在 stage 外侧 gutter；不得出现在正文、代码、表格、数学或 Composer 背后。
- [ ] pane resize 的可点击宽度至少 8px；视觉线保持 1–2px。

## 8.5 Topbar 任务

- [ ] Session title 15–16px/600，成为第一视觉层。
- [ ] project 与 git metadata 继续使用 mono 11.5–12px。
- [ ] status capsule 改为 2–3px 半径的 `status-reading`：
  - glyph + label。
  - 中性 surface。
  - 语义 witness edge。
  - 无 breathing。
- [ ] 右侧三个固定 icon button 保持位置和快捷键。
- [ ] 不新增模型、token、耗时等数据。
- [ ] 继续使用现有 container-query 降级顺序。

## 8.6 验收

- nav 220–460px 和 context 320–920px 的既有 resize 行为保持。
- context 打开后 reading stage 缩放，不出现横向页面滚动。
- Transcript 搜索不会遮挡第一条内容。
- 1600、1280、1100、900 宽度均无重叠。
- 390px 时 topbar 操作、drawer 与 Composer 可点击。

---

# 9. Phase 3 — Transcript 与 Activity Stack

## 9.1 目标

保留富文本能力与工具生命周期，重做视觉语法，使人类正文、用户输入和机器活动形成明确声部。

## 9.2 文件范围

- `src/components/Transcript.tsx`
- `src/components/transcript-activity.ts`
- `src/components/RichText.tsx`
- `src/styles.css`
- `tests/web/transcript-inspection.test.tsx`
- `tests/web/transcript-paging.test.tsx`
- `tests/web/transcript-virtual-search.test.tsx`
- `tests/web/rich-text.test.tsx`

## 9.3 用户消息

- [ ] `.turn--user` 不再右侧漂浮成聊天气泡。
- [ ] 改为 reading datum 上的 `prompt-block`：
  - 最大宽度 100%。
  - 内容宽度自适应，长文本不超过 reading column。
  - 中性 inset 背景。
  - 2px accent witness rail。
  - 2–4px 半径。
  - 不新增 `YOU`、时间或其他目前未显示的元数据。
- [ ] 附件缩略图继续复用现有 viewer 与安全策略。
- [ ] 连续用户消息与后续 assistant round 的垂直分组更加明确。

## 9.4 Assistant 正文

- [ ] 继续开放式排版，不包入大卡片。
- [ ] 保留现有 attribution line 的角色、模型与时间；不得重复模型信息。
- [ ] 正文使用 15.5px，行高 1.7，推荐 72–82ch。
- [ ] H1/H2/H3 提升到 26/21/17px，靠字号与间距建立层级，不使用大色块。
- [ ] 段落、列表、引用、表格、代码和数学遵循同一左 datum。
- [ ] Streaming 不做逐 token 动画，仅保留静态/低干扰 caret。

## 9.5 Activity Stack

保留 Expanded / Collapsed / Compact / Dynamic / Hidden 等现有可见性语义，只改变视觉结构。

- [ ] 相邻 thinking/tool activity 形成一个 `.activity-stack`。
- [ ] stack 外框最多一条中性边界，不为每个条目重复完整卡片。
- [ ] 每条活动行：
  - 32–36px 最小高度。
  - 左侧 2px 类型 witness rail。
  - tool glyph。
  - 单行摘要。
  - 右侧状态 glyph 与可选计数。
- [ ] 语义：
  - thinking：violet witness + brain/diamond glyph。
  - tool：info witness + tool-specific glyph。
  - failed：error witness + X/error glyph。
  - unknown：neutral witness + wrench glyph。
- [ ] 展开 body 紧邻该行，使用 inset surface 和顶部 1px line。
- [ ] Dynamic mode：
  - 完成行从 expanded 过渡到 compact 时只用 opacity/height。
  - 不 scale。
  - 不飞行动画。
  - reduced-motion 直接切换。
- [ ] terminal state 静止。
- [ ] running 只允许 spinner 或三帧离散进度，不使用扩散 halo。

## 9.6 内容组件

### Code

- [ ] 4px 半径、1px line、无阴影。
- [ ] header 30–32px；语言在左，复制在右。
- [ ] mono 12.5–13px，行高 1.6。
- [ ] 语法颜色不超过五个角色。
- [ ] diff 使用背景 tint，但必须同时有 `+`/`-` 和行号/语义。

### Table

- [ ] 仅使用行分隔与必要列分隔。
- [ ] 表头 600、mono 数字使用 tabular nums。
- [ ] 不默认 zebra；大表格可 sticky header。
- [ ] 横向滚动只发生在表格容器内。

### Math

- [ ] 不改变 KaTeX 字形。
- [ ] display math 左右可滚动。
- [ ] 与正文保持 12–16px 垂直间距。
- [ ] 不在公式背后显示网格。

### Quote / callout

- [ ] 使用 2px neutral/semantic rail，不使用圆角彩色卡片。
- [ ] 警告或错误 callout 才使用对应语义色。

## 9.7 验收

- 虚拟列表滚动位置与 prepend history 行为保持。
- 搜索定位、jump-to-latest、earlier branch banner 正常。
- Dynamic 与 Compact 模式不改变工具批次分组。
- 长代码、宽表格、长公式无页面级横向滚动。
- CJK、Latin 与 mono 字体无明显 baseline 断层。

---

# 10. Phase 4 — Composer 与 Activity Bar

## 10.1 目标

把 Composer 做成固定在 reading stage 上的完整工作台控制台，而不是漂浮聊天输入卡。

## 10.2 文件范围

- `src/components/Composer.tsx`
- `src/components/ComposerInput.tsx`
- `src/components/ActivityBar.tsx`
- `src/components/AttachmentList.tsx`
- `src/components/ModelSelector.tsx`
- `src/components/Dropdown.tsx`
- `src/styles.css`
- `tests/web/composer.test.tsx`
- `tests/web/composer-sessions.test.tsx`
- `tests/web/model-selector.test.tsx`

## 10.3 任务

- [ ] Composer 与 reading column 完全同宽。
- [ ] 外层只有一个边界和一个 4px surface radius。
- [ ] 删除 focus halo；focus-within 改为：
  - 1px accent border。
  - 左侧或顶部 2px focus witness。
- [ ] 输入区：
  - 15px。
  - 自动增长。
  - 最大 40dvh。
  - 无内部卡片背景。
- [ ] attachment/reference 行与输入区属于同一 surface，不再形成多层嵌套卡片。
- [ ] meta row 改为 `instrument-footer`：
  - 32–36px 高。
  - 与输入区之间有 1px line。
  - 左侧：model、thinking、附件/引用入口。
  - 中部：有限状态与 context gauge。
  - 右侧：发送/停止/恢复主动作。
- [ ] `ActivityBar` 不再以漂浮 chips 堆叠在 Composer 上方：
  - 临时状态进入 footer 的 status lane。
  - 队列摘要若需独立显示，使用一条紧贴 Composer 的 28–32px ledger row。
- [ ] send button：
  - 32–34px 方形。
  - 3px 半径。
  - filled accent。
  - abort/recovery 保持相同几何，切换语义色。
- [ ] dropdown / completion：
  - 4–6px overlay radius。
  - 无 scale pop。
  - 从锚点方向 4px fade/translate。
  - 保持 select-only combobox 键盘模式。
- [ ] drop target 使用虚线边界 + witness，不用整块青绿色 tint。
- [ ] 发送快捷键、粘贴、拖放、文件限制与 steering/follow-up 行为不改变。

## 10.4 验收

- 中文输入法组合输入不被 Enter 误发送。
- 多行输入与 420px 以下控件换行正常。
- model picker、thinking picker、completion 均不被 viewport 截断。
- 运行中 follow-up / steering 行为与队列状态不退化。
- 390px axe 检查包含 `.composer` 且无 violation。

---

# 11. Phase 5 — 导航、上下文与系统表面

## 11.1 Navigation

文件：

- `src/components/Nav.tsx`
- `src/components/ProjectFiles.tsx`
- `src/components/ScrollRail.tsx`
- `src/styles.css`

任务：

- [ ] nav header 使用新 mark + `InsΠRe`，与 Search 左 datum 对齐。
- [ ] active session 使用 2px left witness + neutral selected surface；取消向右渐变。
- [ ] row 半径 2–3px，不使用 pill。
- [ ] running/completed/failed/attention 从呼吸圆点改为固定 slot 的 glyph：
  - running：spinner/ring。
  - completed：check。
  - failed：x。
  - attention：warning triangle。
- [ ] 状态保留 accessible label，不靠颜色。
- [ ] workspace explorer 至少保留当前最大半栏空间和 lazy tree 行为。
- [ ] collapsed rail 保留 48px，不添加 wordmark。
- [ ] Search 输入改为 3px 半径矩形。

验收：

- 既有 curation、hidden、pagination、workspace explorer 测试通过。
- 行 hover/focus 不引起文字位移。
- session age/count 列仍对齐。

## 11.2 Context pane

文件：

- `src/components/ResourcesPane.tsx`
- `src/components/BranchTree.tsx`
- `src/styles.css`

任务：

- [ ] Files / Changes / History 从胶囊 segmented 改为 rectangular tabs：
  - 当前项底部 2px accent witness。
  - 非当前项无 tint。
- [ ] pane header 与 topbar 同高。
- [ ] list rows 使用 2–3px 半径和 2px active rail。
- [ ] 预览区使用 surface 与 inset 的材料层级，不加多余卡片。
- [ ] PDF、HTML、图片、文本和 diff 的安全边界不改变。
- [ ] History active ancestry 与 effective leaf 的语义不改变。

## 11.3 Settings / dialogs / command palette

文件：

- `src/components/Settings.tsx`
- `src/components/CommandPalette.tsx`
- `src/components/*Dialog.tsx`
- `src/styles.css`

任务：

- [ ] overlay scrim 采用中性透明层；移除或降到最多 2px backdrop blur。
- [ ] dialog / palette 使用 4–6px 半径。
- [ ] 仅 overlay 保留显著 shadow。
- [ ] 标题、说明、操作区形成明确三段。
- [ ] destructive action 不靠红色文字 alone，保留 icon/label。
- [ ] segmented controls 改为 rectangular tab 或 bordered switch。
- [ ] palette row 的 active 状态使用 left witness + neutral fill。
- [ ] empty state 使用几何 mark 或 Lucide icon；不使用插画式大图。

## 11.4 Welcome / token gate / error boundary

文件：

- `src/components/Welcome.tsx`
- `src/components/Wordmark.tsx`
- `src/App.tsx`
- `src/components/AppErrorBoundary.tsx`
- `src/styles.css`

任务：

- [ ] 移除巨型 `π` 水印。
- [ ] mark + wordmark 放大并与 welcome Composer 左边缘对齐。
- [ ] welcome 不新增模板卡或营销模块。
- [ ] token gate 与 error surface 使用同一品牌与 dialog grammar。
- [ ] recent sessions 继续只在 nav 不可见时显示，避免重复导航。

---

# 12. Phase 6 — 响应式、A11y、截图与清理

## 12.1 响应式合同

保留现有主断点，调整内容值：

- `> 1280px`：完整三域，content max 820px。
- `1101–1280px`：content max 760px；隐藏低优先级 mock marker。
- `901–1100px`：content max 700px；project/git 按现有顺序降级。
- `<= 900px`：nav 与 context 互斥 drawer。
- `<= 600px`：topbar metadata 进一步收缩，search toolbar 全宽。
- `<= 420px`：Composer footer 分两行；model picker 可占整行。

任务：

- [ ] 触控目标最小 40×40px；桌面紧凑目标可 28–32px，但必须有可达 focus。
- [ ] drawer 从 topbar 下方开始，toggle 始终可点击。
- [ ] 右侧 pane 在手机上不与 nav 同时显示。
- [ ] 代码、表格与公式只在自身容器滚动。
- [ ] 视觉 witness 不因窄屏消失到只剩颜色。

## 12.2 无障碍

- [ ] 文字对比：普通文本 ≥4.5:1。
- [ ] UI 图形、focus、witness rail ≥3:1。
- [ ] 所有状态：glyph + label/accessible name + 固定位置。
- [ ] `InsΠRe` visual wordmark 的 accessible name 为 `Inspire`。
- [ ] `prefers-reduced-motion`：
  - 禁止 scale。
  - panel 可直接出现或只 opacity。
  - spinner 可保留。
- [ ] 高对比模式下 border 与 focus 不消失。
- [ ] 无 hover-only 信息；tooltip 不是唯一语义载体。
- [ ] 保留 live region 的克制范围，避免 streaming 内容反复播报。

## 12.3 视觉测试矩阵

必须保存下列基线：

| 场景 | 1600×1000 light | 1600×1000 dark | 390×844 light | 390×844 dark |
|---|---:|---:|---:|---:|
| Welcome | ✓ | ✓ | ✓ | ✓ |
| Conversation settled | ✓ | ✓ | ✓ | ✓ |
| Running activity | ✓ | ✓ | ✓ | ✓ |
| Files pane | ✓ | ✓ | — | ✓ |
| Settings | ✓ | ✓ | — | ✓ |
| Command palette | ✓ | ✓ | — | ✓ |
| Nav drawer | — | — | ✓ | ✓ |

另外人工检查 1280×800 与 1100×800。

## 12.4 清理

- [ ] 删除旧 token alias。
- [ ] 删除旧 wordmark 与旧 favicon 资产。
- [ ] 删除 `data-visual` 临时开关。
- [ ] 删除 breathing keyframes 与对应测试。
- [ ] 更新 README 截图与品牌文本。
- [ ] 将 `docdoki/specs/design-system-trace2.md` 批准后替换为 `docdoki/specs/design-system.md`。
- [ ] 更新 `docs/redesign/README.md`，将 Trace 2 规范列为实施权威；原 `trace.md` 保留为方向历史。

---

# 13. 推荐 PR 拆分

## PR 0 — `test: add trace2 visual baselines`

只加入场景 fixture、截图测试、临时 design selector。无视觉改变。

## PR 1 — `brand: introduce InsΠRe open-reticle identity`

只改品牌名、Wordmark、favicon/app icon、document title 与品牌测试。

## PR 2 — `style: add trace2 material and geometry tokens`

只改 token、radii、motion 基础与 styles contract；组件外观允许暂时不完全统一。

## PR 3 — `ui: rebuild workbench shell and reading stage`

只改 App shell、topbar、pane boundaries、search toolbar 和 composer dock 背景。

## PR 4 — `ui: convert transcript to prompt and activity stack grammar`

只改 Transcript / RichText / activity 视觉结构及其测试。

## PR 5 — `ui: integrate composer instrument footer`

只改 Composer、ActivityBar、picker anchoring 与输入测试。

## PR 6 — `ui: align navigation context and overlays`

只改 Nav、ResourcesPane、Settings、Palette、Dialogs、Welcome。

## PR 7 — `qa: trace2 responsive accessibility and screenshot pass`

只做断点、A11y、视觉基线、README、design spec 和旧规则清理。

每个 PR 应控制在一个可理解的视觉问题内；若某 PR 同时修改业务状态机，应拆分。

---

# 14. 关键风险与应对

## 14.1 “方形”变成“生硬”

应对：

- 交互目标尺寸不缩小。
- 保留 2–4px 光学半径。
- 通过间距和字体建立舒适度，而不是用大圆角补救。
- 手机触控目标不受视觉紧凑尺寸限制。

## 14.2 分割线过多

应对：

- 每条线必须回答“它帮助定位、比较还是验证什么”。
- shell 只保留 topbar 底线、nav/context 边界和 reading datum。
- 同一组件内不同时使用 border、tint、shadow 和 rail 四种分隔。

## 14.3 青绿色仍然主导屏幕

应对：

- accent 只用于小面积 witnesses。
- selected row 使用中性 fill + 2px accent rail。
- 禁止 teal panel、teal banner 和 teal gradient。
- 截图评审时单独做“灰阶检查”：去色后层级仍必须成立。

## 14.4 Activity stack 破坏现有 Dynamic 逻辑

应对：

- 先保留现有数据分组与 visibility mode。
- 第一轮只改 class 与 wrapper，不改 batch 算法。
- 现有 transcript activity 测试全部保留。
- virtual row 的测量 key 与层级不变。

## 14.5 Wordmark 的 `Π` 影响无障碍与搜索

应对：

- visual wordmark 外层 `aria-label="Inspire"`。
- 技术标识与搜索关键词继续保留 `inspire`。
- README 首次出现写作 `InsΠRe (Inspire)`。
- 浏览器 title 使用 `InsΠRe`，CLI/包名不改。

## 14.6 视觉迁移与功能开发冲突

应对：

- 先合并 token 与 shell，组件 PR 尽量避免 store 文件。
- 对高频冲突文件 `Transcript.tsx`、`Composer.tsx` 使用短生命周期分支。
- 每个 PR 从最新 main rebase 后再截图。
- 不在视觉 PR 内顺手重命名业务 props 或抽象 controller。

---

# 15. Definition of Done

Trace 2 只有在以下条件全部成立时才能替换当前设计：

- [ ] `InsΠRe` 命名在页面、welcome、token gate、favicon 和 browser title 一致。
- [ ] Logo 是纯几何开放方形，左上与右下外框开放。
- [ ] Light/dark token 全部通过对比检查。
- [ ] 三域工作台边界清楚，reading stage 与 Composer 共用 datum。
- [ ] 用户消息不再是典型软圆聊天气泡。
- [ ] Activity 使用 stack/ledger 语法，终态静止。
- [ ] Composer 无浮动渐变，是单一完整 surface。
- [ ] nav、context、settings、palette、dialogs 使用同一几何体系。
- [ ] 390×844 关键流程和 axe 检查通过。
- [ ] 所有现有 unit/browser 测试通过。
- [ ] 视觉基线覆盖两主题与主要状态。
- [ ] README 与 design authority 已更新。
- [ ] 临时 `data-visual` 和旧样式已清理。
