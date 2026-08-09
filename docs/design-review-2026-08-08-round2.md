# insπre 前端设计评审报告 · 第二轮

**日期**:2026-08-08 · **评审人**:设计总监 · **对象**:前端设计组
**前置状态**:第一轮 R1/R2/D1–D7 已全部落地并经浏览器验收;本轮带新鲜视角重审,主题为"质感上限"与"文案信息密度"。

> **后续状态（2026-08-09）**：本文的 Noto Sans SC 描述保留的是评审时基线；产品后来按原始视觉意图迁回完整 IBM Plex 系谱，由 IBM Plex Sans SC 同族覆盖拉丁与中文。其余评审结论不受影响。

## 本轮方法论变化

除双主题、三视口的实机走查外,本轮增加了两项:
- **"AI 味"对照检查**:以社区共识的 AI 生成界面特征清单(蓝紫渐变、Inter/Roboto 默认字体、居中对称卡片堆、玻璃拟态、emoji 装饰、弹跳动画、模板化 hero)逐项比对。
- **全量文案审计**:提取组件中全部用户可见字符串,逐条判断"过度显示 / 缺少显示"。

## AI 味判定:零命中,且风险方向相反

本产品对 AI 味特征清单**零命中**:无渐变、无玻璃拟态卡片、无 emoji、无模板化布局、无弹跳动效;有自研 token 体系、独特的品牌符号(serif 斜体词标 + KaTeX π + 瞄准镜标)、自定义滚动轨道、KaTeX/语法高亮的内容渲染深度。AI 味的成因是"无约束生成退回训练集高频模式",而这个产品的每一步都有 spec 约束——这正是解药。

**需要警惕的是反方向**:终端工具式的"过度朴素"。成熟商业产品(Linear、Raycast、Things)与克制工具的区别不在颜色或装饰,而在**品牌时刻的完成度、图标系统的信息含量、数字排版、文案的措辞精度**。本轮意见全部集中在这四个杠杆上。

---

## 一、质感提升方向(值得做)

### E1. 欢迎页品牌合成:词标应升级为"标志 + 词标"组合【本轮最高价值】

**现状**:欢迎页是产品唯一的品牌表面,但只渲染 26px 文字词标 + 一行 tagline;而精心设计的瞄准镜标志(reticle)只出现在导航 22px 和 favicon 里——恰恰在品牌最有空间呼吸的地方缺席了。巨大的留白 + 裸文字词标,读作"未完成"而非"克制"。

**方向**:hero 改为合成 lockup——reticle 标志(28–32px)+ 词标横排或上下组合,tagline 与词标的间距收紧(现在词标基线到 tagline 的间距偏松);垂直位置保持在黄金分割上方。不新增任何装饰元素,只把已有的品牌资产放到它该在的位置。

**证据**:截图 04(欢迎页全景)、03(导航 header 中 reticle + 词标的现有组合,证明两资产同框是协调的)。

### E2. 工具图标系统:从单一扳手到按工具类型分形

**现状**:所有工具卡片和 compact 瓦片共用同一个 Wrench 图标(Transcript.tsx 三处硬编码)。Dynamic 模式稳定后,一批 5 个工具塌缩成 5 个**视觉完全相同**的"扳手+对勾"瓦片,只能靠 tooltip 区分 read / edit / bash。这既是"缺少显示"(信息架构层面),也是质感层面最显眼的一处"没做完"——成熟工作台(Spawn、CI 看板、终端复刻品)无一不在工具glyph 上做区分。

**方向**:建立工具图标映射——read→FileText、edit→FilePen、bash→SquareTerminal、search/grep→Search、write→FilePlus2、未知→Wrench 兜底。注释蓝(info hue)与状态色规则不变,只换 glyph。完整卡片的 header 同步受益(扫读时不必读文字)。这是全报告性价比最高的一项。

### E3. 数字排版:表格数字列补 tabular-nums

**现状**:`tabular-nums` 已用于导航年龄列和 context 仪表,但正文表格没有(实测 `font-variant-numeric: normal`)。"2,048 / 12.4 Hz"这类右对齐数字列在逐行对比时宽度跳动,是排版成熟度的经典分水岭。

**方向**:`.rich-text table { font-variant-numeric: tabular-nums }` 一行。Noto Sans SC 的表格数字不影响拉丁字形宽度以外的任何渲染,对纯文本单元格无副作用。

### E4. Composer 模型触发器回到规范的单行形态

**现状**:会话内 composer 的模型触发器是双行(模型名 500 + provider 等宽小字),把整条 meta 行从 30px 撑到 40px(实测);欢迎页空态 "Select model" 是单行 26px。同一个控件三种状态两种行高,且偏离 spec 自己的定义("a value plus 11px chevron that hugs its value")。双行里第二行的 provider 属于"过度显示"——它是消歧信息,不是常驻信息。

**方向**:触发器恢复单行(模型名 + chevron),provider 进 tooltip;选择器菜单内的 provider 分组头保持不变(消歧的正确位置)。meta 行行高随之全状态统一。

---

## 二、细节与文案

### D1. "Hydrating session…" 是工程词汇泄漏

导航分页控制在补载活跃会话时显示 "Hydrating session…",失败时 "Retry session hydration"。"hydration" 是实现术语(store 里的 `sessionListHydrating`),用户无法从字面知道它在干什么。建议:"Loading active sessions…" / "Retry loading active sessions"——与该控件既有文案族("Loading older sessions…")同构。同族还有 "Retry refreshing loaded sessions"("loaded" 同样是内部视角),可一并顺为 "Retry refreshing the list"。

### D2. Settings 安装条的引导文案可以更直接

"Your browser will offer installation from its menu once it considers the app engaged." —— "once it considers the app engaged" 把浏览器的启发式不确定性转嫁给了用户,读感含糊。建议改为描述动作而非揣测时机:"Your browser offers installation from its address bar or menu."(这是我上一轮自己写的文案,自我修订。)

### D3. 已核对无问题的文案(抽样结论)

全量字符串审计(~160 条)整体成熟:句子式大小写统一、tooltip 信息密度恰当("Steer the running task — Ctrl+Enter queues a follow-up" 是范本)、删除确认与配对门的文案精确。以下边界案例经判断**不改**:"This pathname is not valid UTF-8."(开发者工具的精确边界错误,正确)、"10%" context 仪表常驻(工作台仪器,不是噪音)、会话行只显标题+年龄(计数在 tooltip,是有意的渐进披露)。

---

## 三、本轮明确否决的方向(判断记录)

- **换字体**:否。Inter/Geist 只对拉丁有效,引入即破坏"拉丁/CJK 同族无缝"的既有约束;且 Inter 正是当前 AI 味清单里的高频默认项。Noto Sans SC 的拉丁字形干净,问题不在字体在用法。
- **标题负字距**:否。19–23px 拉丁标题加 -0.01em 是成熟惯例,但本产品的内容标题可以是中文,负字距对汉字是伤害;不为拉丁单列例外。
- **给 git 变更数/普通状态加色**:否(上轮已定论,此处记录为终审)。颜色只出现在需要行动的升级语义里。
- **任何形式的渐变、玻璃拟态、装饰性插图**:否,那是 AI 味清单本身。

## 附:证据截图

| 序号 | 文件 | 内容 |
|---|---|---|
| 01 | `docs/screenshots/review-round2/01-topbar-closeup.png` | 顶栏特写(R2 修复后,健康状态) |
| 02 | `…/02-composer-meta-closeup.png` | composer meta 行特写(E4 证据:双行触发器) |
| 03 | `…/03-nav-header-closeup.png` | 导航 header 特写(E1 证据:reticle+词标组合) |
| 04 | `…/04-welcome-light.png` | 欢迎页亮色全景(E1 证据:裸词标) |
