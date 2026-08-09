# inspire 项目整体审查

> 审查基线：`029933c25b40`（2026-08-08，`feat(files): disclose complete reference history`）
>
> 审查性质：只读审查；除本文档外未修改实现、测试或项目配置。
>
> 修复状态（2026-08-08）：本文记录的 F1–F7 已在审查后的工作树中全部修复；最终门禁为 59 个测试文件、654 个测试通过，独占性能批次结论为 `no-performance-change`，并已生成验证过的 standalone npm tarball。本文保留基线判断与原始证据，完成记录见 `docdoki/stages/archive/challenge-project-hardening-2026-08-08.md`。

## 结论

这是一个**明显高于同体量平均水平**的本地 Web 应用。最难的部分——Pi 单写者所有权、RPC 结果不确定性、会话投影、分支导航、文件/Git 授权、浏览器安全边界——大多不是靠约定，而是靠显式状态、类型、上限、校验和测试来维持。代码中的多数“防御性复杂度”都有真实语义，不应为了少几行而删掉。

但当前版本还不能评价为“主要功能完全正确、性能风险已经被证伪”：

- 有一个会在普通使用中触发的会话历史连续性问题：加载过的旧消息会在叶节点正常前进时被当成换视图而丢弃；
- 打开、新建、fork 在已经提交选择或持久化副作用后仍执行可失败的快照读取，故障时会让服务端、浏览器和磁盘对“操作是否成功”得出不同答案；
- 附件、完整资源历史和 Git 轮询各有一个明确的放大路径；
- 当前性能评估器已经因新增 `/api/resources/list` 请求而失效，旧的 `no-performance-change` 结论不能覆盖本次 HEAD。

我的总体判断是：**架构方向正确，核心质量高，边界意识很强；问题主要不是“缺少抽象”，而是少数关键语义被两个权威分别解释。** 应优先统一“投影视图变化”“已提交操作的响应”“资源引用索引”和“端到端载荷预算”，而不是做泛化拆文件或工具函数去重。

## 审查与验证范围

纳入审查的实现面包括：会话目录与选择、新建/打开/删除/fork/分支导航、Pi RPC 与持久化对账、投影与历史分页、消息流与扩展 UI、composer/附件/项目文件、资源预览、Git 检查、Markdown/KaTeX、安全与认证、偏好设置、启动/关闭流程及性能评估器。

当前规模：

- 产品代码：`server/`、`src/`、`shared/` 共 73 个 TS/TSX/MJS 文件，约 21,884 行；
- 测试代码：61 个 TS/TSX/MJS 文件，约 18,613 行，其中 57 个测试文件；
- 最大的两个所有者是 `server/runtime.ts`（3,559 行）和 `src/store.ts`（2,905 行）。它们很大，但分别仍围绕运行时所有权和浏览器状态所有权组织；单纯按行数拆分不会自动提高质量。

执行证据：

- `NODE_ENV=test npm run check`：57 个测试文件、637 个测试全部通过；
- `npm run build`：通过；Vite 报告主 JS chunk 约 1.06 MB（gzip 321 KB），仅凭该警告不足以授权拆包优化；
- 真实安装的 Pi 集成测试：2 个文件、5 个测试全部通过；
- 隔离临时目录中的真实模型端到端探针：成功新建会话、发送 prompt、收到非空且符合见证词的 assistant 响应并确认 JSONL 已持久化，耗时约 5.6 秒；临时会话随后清理；
- `npm audit`：生产及开发依赖共 0 个已知漏洞；项目固定的 Pi `0.84.1` 与 npm 最新版本一致；
- 真实 Chromium 的冻结场景完成了会话/搜索、Files/Changes/History、Git diff 刷新、分支编辑、流式回复、工具状态和后台会话等功能断言，但在请求计数门禁处失败，详见 F7；
- 两个定向探针分别复现了 F1 的投影视图问题和 F6 的偏好数据覆盖问题。

## 发现清单

优先级含义：P1 = 应在继续扩展功能前修复；P2 = 应进入近期修复队列；未发现 P0 或可直接利用的高危安全问题。

### F1 · P1 · 正常叶节点前进会丢弃已加载的旧历史；直接移除该判断又会让 compaction 混入旧历史

**位置**

- `src/store.ts`：`applySnapshot()` 的 `viewChanged` / `historyCompatible`；
- `server/runtime.ts`：`snapshotSlot()`、`renewView()`、`handleProjectionUpdate()`；
- `server/session-projection.ts`：物理 `append | rewrite` 分类、`appendFromRevision` 和 cursor 校验；
- `tests/web/store.test.ts`：“retains loaded older pages across append-lineage resync”用例。

**事实**

服务端为普通追加保持同一个不透明 `viewId`，cursor 也允许旧叶节点是新叶节点祖先的严格追加；这是正确的分支视图语义。但浏览器同时把 `effectiveLeafId` 的任何变化判定为 `viewChanged`。正常 user/assistant/tool/compaction 条目追加都会改变 durable/effective leaf，因此用户已经向上加载的历史在下一次权威快照到来时会被最新页替换。

对应测试没有带入生产快照中的 `effectiveLeafId`，所以只验证了简化形状，未覆盖真实条件。

修复不能只是删掉 leaf 比较。定向探针从 120 条消息开始追加一个 compaction，结果是：

- revision `1 → 2`，文件变化被分类为 `append`；
- `viewId` 保持不变，`appendFromRevision` 仍为 `1`；
- 投影消息从最新 100 条变成 5 条；
- 旧 cursor 返回 “Transcript cursor is invalid”。

这证明“文件字节是前缀追加”不等于“浏览器消息视图是前缀追加”。

**影响**

用户读到旧页后继续对话，旧页、搜索结果和阅读锚点会在 settle/resync 时消失。若未来仅放宽前端 leaf 判断，`/compact` 又可能把 compaction 前的消息错误保留在新上下文里。

**建议**

由投影层唯一判定 `messageViewChange = none | append | replace`：比较投影后的消息身份/前缀，而不是复用物理文件 `append | rewrite`。只有语义追加保持 `viewId` 和 `appendFromRevision`；compaction、分支替换或其他非前缀变化必须更新 view generation。前端在存在现代 `viewId` 时只信该 generation 和 append lineage，不再把自然前进的 leaf 当成换视图；leaf 只用于服务端 lineage/cursor 校验及旧协议兼容。

验收测试必须使用完整生产形状，覆盖“加载旧页 → 普通追加仍保留”“加载旧页 → compaction 完整替换”“导航到祖先/兄弟分支替换”三条链。

### F2 · P1 · open/new/fork 在提交副作用后仍让可失败快照决定 HTTP 成败

**位置**

- `server/runtime.ts`：`openSession()`、`newSession()`、`forkSession()`、`snapshotSlot()`；
- `src/store.ts`：`openSession()`、`newSession()` 的成功后才 `applySnapshot()` 语义。

**事实**

`openSession()` 先更新 `selectedSessionId`，再返回 `snapshotSlot()`；`newSession()` 已把 slot 放入 map、选择新 id、发出 `runtime_ready` 后，执行 `return this.snapshotSlot(slot)`。后者没有 `await`，因此 `try/catch` 捕获不到 promise 后续拒绝。`forkSession()` 则在 Pi 已创建目标会话、进程已迁移且服务端已选择目标后 `await snapshotSlot()`；若最后一次 `get_state`/reconcile 失败，catch 会删除内存目标并停止 worker，但磁盘上的 fork 已经存在。

`snapshotSlot()` 不是无失败操作：至少权威 `get_state` 和 reconcile 仍可失败。浏览器只在 HTTP 成功后应用快照，因此边界故障可产生以下结果：

- 服务端已经选择新会话，浏览器仍显示旧会话并报告失败；
- 新会话实际已创建，用户却看到 “Failed to create session”；
- fork JSONL 已存在，运行时尝试回滚，稍后刷新目录才看到“失败”的 fork。

这与项目其他地方严格区分“是否已接受副作用”的设计不一致。

**建议**

把操作分成明确的 pre-commit 与 post-commit：要么在提交身份/选择/持久化副作用前完成所有会影响响应成败的读取；要么提交后只返回一个不会失败的、已验证身份加本地 preview 构造的结果，把 worker 元数据缺失表示成状态而不是 5xx。fork 一旦确认 Pi 的目标身份和文件，就不能再假装可回滚为“未发生”。

增加最后一跳故障注入：让 ready worker 的最终 `get_state` 失败，并同时断言 HTTP 结果、`activeSessionId`、浏览器选择、catalog 和磁盘文件对同一结果达成一致。

### F3 · P1 · 附件只有“单文件 × 个数”限制，没有端到端总字节预算

**位置**

- `shared/contracts.ts`：`MAX_ATTACHMENTS = 8`；
- `server/app.ts`：Multer `memoryStorage()`，每文件 16 MiB；
- `server/attachments.ts`：`resolveForPrompt()` 并行 `readFile()` 并转 base64；
- `server/pi-rpc.ts`：出站命令直接 `JSON.stringify()` 写 stdin。

**事实**

一次合法上传可包含 8 个接近 16 MiB 的文件，Multer 会在内存中持有最多约 128 MiB 原始内容，没有 aggregate byte limit。若都是图片，发送 prompt 时又并行读入并生成约 171 MiB base64；随后还要构造同量级 JSON 字符串、写入 stdin，并由 Pi 子进程再次接收和解析。`MAX_RPC_LINE_BYTES` 只限制子进程 stdout 入站行，不限制这条出站 prompt。

因此正常 UI 能构造出足以造成数百 MiB 瞬时分配、长时间 event-loop 停顿乃至 OOM 的合法输入。这不是微优化问题，而是缺少产品级载荷合同。

同一子系统还有次级生命周期问题：默认上传根目录带 PID/时间戳，只有当前进程的 `close()` 会删除；SIGKILL/崩溃会留下应用后续不会回收的旧目录，而 `application.close()` 若先在 `runtime.close()` 抛错，也不会继续清理 attachments。

**建议**

建立一份 shared 的端到端预算，分别约束 multipart 总原始字节、单条 prompt 的图片原始/编码后总字节以及文件个数；浏览器在 staging 前给出可理解的拒绝，服务端独立重验。普通文件应流式落入私有临时文件，而不是使用 `memoryStorage()` 聚合；图片在进入 `JSON.stringify()` 前必须通过总编码预算。启动时按安全的进程/年龄规则回收 stale upload roots，关闭流程用 `allSettled`/`finally` 保证附件清理不会被 runtime 失败跳过。

### F4 · P2 · “完整 Files 历史”缺少可复用索引，存在重复全量扫描和无界响应/DOM

**位置**

- `shared/resource-references.ts`：`collectSessionResourceReferences()`；
- `server/resources.ts`：`list()`、`probe()`、`referencedBySession()`；
- `src/resources.ts`：`resourceRows()` / `mergeResourceRows()`；
- `src/components/ResourcesPane.tsx`：完整 baseline 在截取前即被全部转换和合并。

**事实**

`list()` 对当前可见分支的全部投影消息做一次无上限抽取，并把所有唯一引用一次性返回。随后 `probe()` 最多并行检查 16 个引用；对每个不在 project index 中、需要 transcript citation 授权的引用，`referencedBySession()` 又重新执行一次完整 `collectSessionResourceReferences(messages)`。消息数组虽然共享，引用索引并未共享，故该路径是 `O(K × M)` 的重复解析/分配（`K ≤ 16`）。

浏览器收到完整数组后先对全部记录执行 `resourceRows()` 和 merge，最后才显示前 8 条；展开时也没有分页或虚拟化。长会话中若 agent 读取大量不同文件，服务端 CPU、响应体、浏览器内存和 DOM 数量均没有产品上限。

**建议**

为 `{sessionId, viewId, projectionRevision}` 建一个只含安全投影的 `ResourceCitationIndex`：一次抽取得到有序 rows、规范化 path Set 和 embedded 索引，供 list/probe/resolve 共用；它不是资源 handle，也不改变授权边界。完整披露用 cursor/page + total 实现，前 8 条和总数可立即返回，展开再按页取并虚拟化。对 view/revision 变化整体失效即可，不要添加第二个持久化资源目录。

### F5 · P2 · Git 自动刷新在慢仓库上会退化成无间歇子进程循环

**位置**

- `src/store.ts`：`setGitSurfaceVisible()`、`refreshGitStatus()`、`runGitStatusRefresh()`；
- `server/git-runner.ts`：`GIT_TIMEOUT_MS = 4_000`。

**事实**

可见 Git surface 每 4 秒触发一次刷新；topbar 在识别出 repository 后本身就会保持该 surface。若上一次刷新仍在执行，timer 把 `gitRefreshQueued` 设为 true；当前请求结束后 `do…while` 立即重跑。Git 超时也恰好是 4 秒。

所以当大仓库、网络文件系统或异常仓库使 `git status` 接近/达到 4 秒时，自动 timer 会保证每次结束/超时后立刻启动下一次，几乎没有空闲期。这里已确认的是调度行为；当前仓库的 Git 很快，实际影响取决于用户仓库。

**建议**

周期刷新应在上一次完成后再等待一个完整间隔，并对慢响应/超时/连续错误指数退避；自动 tick 遇到 in-flight 请求时直接丢弃，不应像用户显式刷新或工具完成提示那样排队。页面隐藏时暂停。保留显式 Refresh 的即时性，并用一个耗时 4 秒的 fake status 测试证明不会连续自旋。

### F6 · P2 · 单个损坏的偏好字段会静默回退，并在下一次无关修改时覆盖全部用户偏好

**位置**

- `server/preferences.ts`：`readDisk()` 与 `patch()`。

**事实**

`readDisk()` 对 JSON 解析、I/O 和 schema 错误统一 `catch`，全部返回 `defaultPreferences`。下一次 patch 会把这个默认对象与单字段修改合并并原子写回。定向探针写入“dark theme + pinned session + 一个非法 visibility”，读取结果已经变成 system/空 pin；随后只修改 `projectDisplay`，磁盘文件被完整重写为默认值，原 pin 和 theme 永久丢失。

**建议**

区分 `ENOENT`（首次安装，可使用默认值）与 malformed/I/O failure（保留原文件、返回显式可恢复错误、禁止 patch 覆盖）。若要做字段级迁移，必须有明确版本和可审计规则；不要把任意 schema 失败解释为“用户选择了默认值”。测试应验证损坏文件上的无关 patch 不会改动原字节。

### F7 · P2 · 当前性能门禁已经失效，旧的性能结论不适用于本次 HEAD

**位置**

- `tests/benchmarks/evidence-gated-maintenance.ts`：`EXPECTED_SCENARIO_REQUESTS`；
- `docdoki/notes/performance-evidence.md`：最近一次已接受基线。

**复现**

隔离运行当前冻结评估器时，真实 Chromium 完成了该 iteration 的功能等价断言，随后在精确请求计数处退出：

```text
expected: /api/branches/navigate 1, /api/branches/tree 2,
          /api/git/diff 2, /api/git/status 3, /api/prompt 1,
          /api/sessions 4, /api/snapshot 1
actual:   上述全部一致，另有 /api/resources/list 1
```

进程退出码为 1，没有任何 browser sample 被接受，也没有生成 `no-performance-change` 决策。新增的完整 Files 历史请求正是当前 HEAD 的功能，因此之前记录的性能结论不能替代本次验证。

**建议**

把该请求及其推导加入冻结 accounting，重新评审场景后再跑足接受样本；不能仅放宽比较或删除精确计数。资源 cardinality、慢 Git 和多图片总载荷属于不同风险，应增加各自的边界/压力见证，而不是让一个“小资源集合 + 快仓库”的场景代替全部性能结论。

## 做得好的部分

### 1. 核心所有权模型清楚且可信

Pi session id、JSONL 和 Pi worker 保持唯一权威；runtime 没有创建第二份会话存储。`mutateSlot`、startup attestation、projection reconcile、persistence expectations、navigation lease、fork reservation 和 outcome-unknown hard stop 共同覆盖了大量真实竞态。这里的复杂度大多有必要，尤其不应把“失败关闭”简化成自动重试或吞错。

### 2. 安全边界不是装饰

loopback-only、一次性 pairing/cookie、exact-origin WebSocket、Markdown 先 sanitize 后 KaTeX、CSP 禁止远程 transcript 图片、resource inode handle、Git 原始字节 opaque id、spawn 参数数组及隔离环境，形成了多层独立见证。本次未发现能通过浏览器内容直接越权读取任意文件、注入 shell 或让 transcript 主动发起远程请求的路径。

### 3. 复用总体上是语义复用，而不是形状复用

shared contracts、纯 `reduceEvent()`、assistant delta accumulator、resource reference extractor、Git runner、safe projection、每会话 composer partition 都放在合理的所有者下。代码没有为了“看起来 DRY”把不同生命周期强行合并。Pi 已提供的模型、命令 fuzzy matching、session context 等也普遍复用了官方 API。

### 4. 测试密度和注释质量很高

测试代码量接近产品代码，且大量测试针对竞态、故障、上限和身份，而不只是 happy path。关键注释通常解释“为什么必须这样”，不是重复代码。真实 Pi 兼容测试和本次真实模型探针都证明主链并非只在 mock 上成立。

### 5. 用户可见失败大多有明确状态

会话冲突、旧页加载失败、Git stale、resource ambiguity、extension dialog timeout、attachment upload failure、认证失效等都有对应状态或恢复入口。F6 和部分 metadata 空数组 fallback 是例外，不代表整体错误模型薄弱。

## 代码质量与抽象判断

### 不建议做的“简化”

- 不要为了缩短 `runtime.ts` 而把 mutation、event、projection、extension-response 四条 lane 混成通用队列；它们的持久化语义不同。
- 不要移除 startup/projection/fork 的校验、上限和 hard stop；已有历史和测试证明它们不是多余兜底。
- 不要因为 Vite chunk warning 就立即手写 manual chunks；本地应用的首屏收益尚未被当前有效基准证明。
- 不要引入第二个会话数据库、资源数据库或 Git path authority 来“方便缓存”。

### 值得提取的四个语义权威

1. **Projected view transition**：文件变化与消息视图变化分开分类，统一驱动 `viewId`、cursor 和前端 preserve/replace；
2. **Committed operation result**：open/new/fork 在同一处定义 commit point 和永不撒谎的响应；
3. **Resource citation index**：一次安全抽取服务 list/probe/resolve，避免重复全量扫描；
4. **Payload budget**：上传、暂存、base64、RPC 出站共用一份按编码后成本推导的预算。

这四项都由当前 bug 证明有多个消费者共享同一语义，因而是有价值的抽象；其他相似代码暂不值得泛化。

## 建议修复顺序

1. F1：先修投影视图连续性，并同时覆盖 compaction 的语义替换；
2. F2：统一 open/new/fork commit point，消除“实际成功但返回失败”；
3. F3：建立附件 aggregate budget，避免合法输入击穿进程；
4. F7：修复并重新冻结性能评估器；
5. F4、F5：分别用资源高 cardinality 和慢 Git 见证约束优化；
6. F6：让损坏偏好显式失败且绝不覆盖原文件；
7. 在附件改造中一并加入 stale cache 回收和关闭清理保证。

修复时不建议横向重构整仓库。每项都应以一个明确语义为宽度，补对应的失败/边界测试，然后重新执行真实 Pi 集成、完整 `npm run check`、production build 和修复后的冻结浏览器评估器。
