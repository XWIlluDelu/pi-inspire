# insπre 前端设计评审报告

**日期**:2026-08-08 · **评审人**:设计总监 · **对象**:前端设计组

## 范围与方法

- 基于当前源码(`a0b977b`)全新构建,以 mock 实例在真实浏览器(Chromium)中走查:欢迎页、对话页、设置、命令面板、模型选择器、斜杠补全、资源面板(Files / Changes / History)、删除确认框、配对页;亮色与暗色双主题;1600×1000、1280×720、420×900 三种视口。
- 同步走查 `src/styles.css`(5337 行)与关键组件源码,对照 `docdoki/specs/design-system.md` 契约逐条核对。
- 证据截图见 `docs/screenshots/review/`,正文按序号引用。

## 总体判断

这套设计系统的底子是好的:token 纪律严格(组件层几乎无硬编码色值/字号)、双主题共享一套组件架构、注释调色板(violet/blue)语义清晰、动效克制且有 reduced-motion 兜底。**本次意见宁缺毋滥:2 处值得重做/优化,7 处细节修葺。** 多数问题不在"不好看",而在"同一语法在各处实现不一致"——这正是统一化阶段最该收掉的口子。

---

## 一、值得重新设计 / 优化的地方

### R1. 命令面板的分组语法与全局不一致,应统一为"单次组头"

**现象**:命令面板每一行都在左侧重复渲染组标签——连续 5 行 "ACTIONS"、连续 N 行 "PREFERENCES"(92px 固定列,`palette__group`)。而产品内另外两个同类浮层——模型选择器("ANTHROPIC"/"KIMI-CODING")和斜杠补全("INSPIRE"/"SKILL")——都是**每组只出现一次**的组头。三种浮层列表,两套分组语法。

**证据**:截图 05(命令面板)对比 08(模型选择器)、09(斜杠补全);`src/components/CommandPalette.tsx` 逐行渲染 `item.group`。

**为什么值得重做而非修补**:
- 逐行重复的组标签是纯粹的视觉噪音,92px 的 gutter 还挤压了标题与快捷键 hint 的可用宽度;
- 分组标签扫读一次即可建立心智,重复出现反而打断纵向扫描;
- 这是"统一化"的正面案例:模型选择器的组头语法(单次、uppercase、tracked、faint)已经是正确答案,命令面板应向它对齐,而不是并存。

**方向**:组头每组渲染一次(滚动时可考虑 sticky),行内只保留标题 + 右侧 hint;同时把组头 tracking 并入全局 0.04em 规格(见 D7)。

### R2. 顶栏缺少响应式降级策略,中段宽度下信息塌缩成无意义碎片

**现象**:资源面板打开(或窗口收窄)时,顶栏的身份簇按比例压缩:会话名 "Review extension eve…"、项目名塌缩成 **"p…"**、git 分支 "mock/analys…"。三段文字同时被截断,每段都失去信息价值——"p…" 尤其刺眼,一个字母加省略号不如不显示。

**证据**:截图 06、07(打开 Changes 面板后的顶栏);`.topbar__project` 仅设 `max-width: 360px` + flex 收缩,无任何下限保护。

**方向**:为顶栏身份簇定义明确的**丢弃优先级**而不是等比截断,例如:宽度不足时先隐藏项目名(它已在导航与工作区浏览器中可见)→ 再把 git 分支收缩为图标 + 变更数 → 最后才截断会话标题。规范里已有手机端降级("branch text yields to the session title"),缺的是 900–1400px 这个中间档。这是信息架构层面的设计决策,建议出一版降级表再动手。

---

## 二、前端细节不到位的地方

### D1. 对话搜索胶囊遮挡正文,且无任何遮挡补偿【优先级最高】

**现象**:对话内搜索胶囊 `position:absolute` 浮在 transcript 视口右上(94% 半透明 surface + 8px 背景模糊)。右对齐的用户气泡滚动到顶部时会**直接钻到胶囊下面**,文字被切掉半个词("Shr…");1280px 常用宽度下,行间公式同样被胶囊切开;移动端胶囊变为通栏,遮挡更明显。顶栏有渐变遮罩让内容"溶解"其下,这个胶囊区域却什么都没有。

**证据**:截图 02(被切的气泡)、03(将胶囊透明化后验证气泡确实在其正下方)、12(1280px 下公式被切)、11(移动端)。`styles.css:1684-1702`。

**建议**:三选一——(a) 胶囊改为不透明 surface(最省事,模糊层对文字的遮瑕本就有限);(b) 胶囊所在泳道复用顶栏的顶部渐变遮罩;(c) 给 transcript 加 `scroll-padding-top`,让内容永远不会停留在胶囊下方。推荐 (a)+(c) 组合。

### D2. Markdown 任务列表使用浏览器原生 checkbox

**现象**:GFM 任务列表的复选框是未主题化的原生控件:灰色、尺寸与 15px 阅读正文的基线对不齐,在亮色主题下尤其突兀。全站没有任何 `input[type="checkbox"]` 或 `accent-color` 规则——这是唯一一处"裸奔"的系统控件。

**证据**:截图 02 中 "Load the signal / Compute the spectrum" 列表;`grep accent-color src/styles.css` 为空。

**建议**:最小修复是一行 `accent-color: var(--accent-fill)` 加尺寸/对齐微调;若要做彻底,自定义勾选样式(1.5px 边框 + accent 填充勾)与整体控件语言更配。

### D3. 消息级操作图标(copy / fork)常驻 0.75 透明度

**现象**:每条用户消息右下角的 copy、fork 图标在静止态即以 `opacity: 0.75` 常驻,hover 才到 1。结果是整屏对话始终挂着一排幽灵图标——与系统自己的"chrome may not compete with content"原则相悖。

**证据**:截图 04、12(鼠标不在气泡上,图标仍可见);`styles.css:1842-1857`(`.turn__actions`)。

**建议**:静止态 `opacity: 0`,`.turn:hover` / `.turn:focus-within` 时显现(键盘可达性靠 focus-within 保留),与主流对话产品一致。

### D4. Changes 列表的状态胶囊截断固定词汇

**现象**:文件行的来源胶囊显示 "unstaged mod…"——"unstaged modified" 是受控词汇表里的固定文案,实际宽度 115px 被 105px 的 cap 切掉。胶囊内的固定文案不应该出现省略号;另外该 muted 胶囊缺少规范要求的 hairline 描边。

**证据**:截图 07;`.res__row-source`(`styles.css:3755`)实测 `scrollWidth 115 > width 105`。

**建议**:取消该胶囊的 max-width 或改为按内容收缩;若空间确实紧张,缩短文案("modified"),而不是截断它。

### D5. 资源面板空预览态没有走全局 empty-state 语法

**现象**:Files 面板未选文件时,预览区只有一行孤文本 "Select a file above to preview it here."。规范定义的空态语法是"26px 1.5-stroke faint 图标 + sm/500 标题 + xs 提示"三段式(命令面板空态就是这么做的),这里降级成了单行说明,且这是主面板级空态,不属于规范豁免的"密集树内联注释"。

**证据**:截图 06;对比命令面板空态实现(`CommandPalette.tsx` 的 `empty-state`)。

**建议**:补上图标与标题层级,或明确把该表面划入豁免清单并写进规范。

### D6. 移动端欢迎页 composer 的第二行没有右对齐 send

**现象**:420px 视口下,欢迎页 composer 折行后第二行为 "medium ⌄ + 两个图标 + send",send 停在行中间;而会话内 composer 同断点下 context/send 独占尾部行且右对齐。同一折行规则,两种落位。

**证据**:截图 10(欢迎页)对比 11(会话内)。

**建议**:统一为规范写法——context/send 独占尾部行右对齐;欢迎页无 gauge 时 send 单独右对齐即可。

### D7. 令牌/文档层面的三处小漂移【一行修复级】

- `font-weight: 550`(`.session-delete__session`,styles.css:4638)——权重词表只有 400/500/600,且自托管字体只装了这三档,550 实际不可渲染,只是碰巧落到近似档;
- 大写组标签的 tracking 分裂为 0.04em(导航组头、工作区树)与 0.05em(命令面板组标签、欢迎页 RECENT SESSIONS)两种,同一视觉角色应合一(借 R1 一并收掉);
- `styles.css` 文件头注释仍写 "industrial chartreuse in dark"——暗色 accent 早已改为 luminous teal,注释残留的是旧品牌身份,维护者容易被误导。

---

## 附:证据截图

| 序号 | 文件 | 内容 |
|---|---|---|
| 01 | `docs/screenshots/review/01-welcome-light.png` | 欢迎页·亮色 |
| 02 | `…/02-conversation-light.png` | 对话页·亮色(D1/D2 证据) |
| 03 | `…/03-search-pill-reveal-light.png` | 胶囊透明化实验(D1 证据) |
| 04 | `…/04-conversation-dark.png` | 对话页·暗色 |
| 05 | `…/05-command-palette-dark.png` | 命令面板(R1 证据) |
| 06 | `…/06-context-files-dark.png` | 资源面板 Files(R2/D5 证据) |
| 07 | `…/07-context-changes-dark.png` | 资源面板 Changes(D4 证据) |
| 08 | `…/08-model-selector-dark.png` | 模型选择器(R1 对照) |
| 09 | `…/09-slash-completion-dark.png` | 斜杠补全(R1 对照) |
| 10 | `…/10-welcome-mobile-dark.png` | 欢迎页·移动端(D6 证据) |
| 11 | `…/11-conversation-mobile-dark.png` | 对话页·移动端(D1/D6 对照) |
| 12 | `…/12-search-pill-overlap-1280-dark.png` | 1280px 胶囊遮挡公式(D1 证据) |
| 13 | `…/13-pairing-light.png` | 配对页·亮色 |
| 14 | `…/14-delete-dialog-dark.png` | 删除确认框·暗色 |

## 明确不列入意见的项(已核对,符合预期)

- 双主题 token、注释调色板语义、字重 ≤600、聚焦环语法、reduced-motion 兜底、删除确认的破坏性操作设计、空态图标语法在命令面板的落地、自定义滚动轨道的呈现——均符合设计契约,不动。
- 欢迎页 π 水印的克制(4%/5%)是规范内的刻意选择,不建议加深。
