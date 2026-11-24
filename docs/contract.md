# 侧边自由对话 — P1 契约

P1 目标：**能聊**。空白上下文、零本地工具、流式回显、一键清空。
本文是宿主半部与客户端半部的共同契约；实现可以变，方法名与数据形状不要变。

## 1. 线程（thread）语义

- 一个**主会话**对应**一个**自由对话线程（单线程）。
- 线程首次打开时创建：新的子会话，`origin: 'subagent'`，`parentSession` = 主会话，
  **空白上下文**（不 seed 父历史、不继承事件数），`cwd` 锁主会话 `header.cwd`。
- 线程有自己的消息列表；主会话看不到它，除非 P2 的显式读取闸门授权。
- 关闭 tab 不销毁线程；主会话归档 → 线程随归档删除（P3）。
- 清空 = 销毁旧子会话 + 建一个新的空线程（P1 先按此实现，历史不保留）。

## 2. 桥接 API（客户端 → 宿主）

客户端只依赖这 5 个方法，传输层（typert / HTTP）由宿主半部决定，客户端不感知。

```ts
ensure({ parentSessionId }): { threadId, snapshot }

// 轮询用：version 不变时宿主只回 { version, status }，不带 messages。
snapshot({ threadId, version }): {
  version: number,
  status: 'idle' | 'running' | 'error',
  error?: string,
  model?: { provider: string, id: string, label?: string },
  messages?: Message[]           // 仅当 version 变化时返回，最多最近 200 条
}

send({ threadId, parts: Part[] }): { version }
cancel({ threadId }): { version }
clear({ threadId }): { threadId, snapshot }
```

- `Part = { type: 'text', text: string } | { type: 'image', mediaType, name, data }`
  （image 的 `data` 是 base64，不含 data URL 前缀；宿主负责入附件库）
- `Message = { id, role: 'user' | 'assistant', status: 'streaming' | 'done' | 'error',
   parts: Part[], at: number }`，assistant 的 image 部分以
  `{ type: 'image', attachmentId, mediaType, name }` 回传，由客户端换成可显示 URL。
- 同一 `threadId` 的写操作串行；`send` 在 `status === 'running'` 时返回错误码 `BUSY`。

## 3. 客户端行为

- tab body 挂载时 `ensure({ parentSessionId: props.sessionId })`；
- 挂载期间轮询 `snapshot`：`running` 时 300–400ms，空闲时 1200–1500ms，tab 卸载即停；
- 发送：本地先乐观插入一条 user 消息，再调 `send`；失败则回滚并提示；
- 停止：`status === 'running'` 时发送按钮换成停止按钮，调 `cancel`；
- 清空：二次确认（面板内确认条，不用原生弹窗）→ `clear` → 拿到新 `threadId` 继续轮询；
- 附件：最多 8 张，png/jpeg/webp/gif；超过 8MB 拒绝并提示；文本粘贴走 text part；
- 渲染：assistant 的 text part 用 primitives 的 Markdown 组件，user 的 text 用等宽纯文本；
- 错误：`status === 'error'` 时在消息流尾部显示一条错误条 + 重试按钮（重发上一条 user 消息）；
- 面板整体包一层错误边界，组件崩溃时只坏面板，不坏整个会话界面。

## 4. 硬约束

- 客户端半部是**单文件**零构建浏览器模块：`window.__ModuleLoader__.load({...})`，
  不用 `import`/`export`，依赖只走 `require('react')` 等裸模块名。
- 不新增 npm 依赖；样式用 `--dsw-alias-*` CSS 变量，跟随主题。
- 宿主半部是标准 Cordis 插件（ESM），可用 node 内置模块。
- 侧边会话**不得**拿到任何本地执行工具（P1 全禁；白名单在 P2 按开关放开）。
## 5. P2 增补：双向读取与网页开关

### 5.1 面板设置（宿主侧持久在 thread 上）

| 字段 | 取值 | 默认 | 作用 |
| --- | --- | --- | --- |
| `open` | boolean | `false` | 面板是否在屏。客户端挂载时置 true，卸载时置 false；宿主另外要求「最近 60s 内收到过轮询」，否则视为已关闭（`OPEN_STALE_MS`）。 |
| `mainRead` | boolean | `false` | 主对话是否**可以**读取这条从属对话。 |
| `sideRead` | `allow` / `ask` / `deny` | `deny` | 从属对话是否可以读取主对话；`ask` 时每次读取都要面板点允许。 |
| `web` | boolean | `false` | 是否给从属对话开放 `web_search` / `web_fetch` / `research`。 |

### 5.2 工具挂载（随设置动态增删）

- `read_freedom_chat`：挂在**主对话 agent** 上，仅当 `panelOpen && mainRead`；面板关闭立即 `dispose`。
- `read_main_conversation`：挂在**从属 agent** 上，仅当 `panelOpen && sideRead !== 'deny'`。
- 网页三件套：通过 `tools.restrict({ allow: [...] })` 在从属 agent 上放开，`web=false` 时回到「全部遮蔽」。
- 兜底：`tools/pre-execute` 是按 agent 的白名单 —— 从属线程只放行 `allowedTools(thread)` 里的名字，其余一律 `{ kind: 'deny' }`。

### 5.3 读取语义

- 两个方向都只返回对方会话最近 20 条 **user / assistant 正文**，工具调用与结果一律剔除。
- 主对话读从属：`execute` 内二次校验「本轮用户消息里是否明确要求读取侧边对话」，没有就拒绝并提示先问用户（fail-closed）。
- 从属读主对话：`sideRead === 'deny'` 直接拒绝；`'ask'` 时挂起等待面板确认（`snapshot.approval` → 客户端 `resolveApproval`），120 秒无响应按拒绝。

### 5.4 新增 API

- `setSettings({ threadId, patch })` → 完整 snapshot；`patch` 只接受上面四个字段。
- `resolveApproval({ threadId, approvalId, allow })` → `{ version }`。
- `snapshot` 的返回体固定带 `settings`，有挂起确认时带 `approval: { id, at }`。

### 5.5 「用户明确要求」怎么判定

宿主会话里 `user/message` 事件不止用户本人打的字：`time-context` / `runtime-context` /
`dsh-ops:step-tail` / `skill-catalog` / `subagent-settled` / `user-approval` 也都以
`user/message` 落库，而且时间戳更晚。因此：

- 只认 `data.source.kind === 'user'`（缺省 source 视为真人输入，兼容旧数据）；
- 意图门禁与双向转录都按这条过滤，注入行既不会冒充"用户要求"，也不会混进转录。

## 6. 模型与推理强度（P1b）

| 方法 | 载荷 | 返回 |
| --- | --- | --- |
| `catalog` | `{}` | `{available, groups:[{id,name,models:[{id,name,reasoning?}]}], default?, failures?}` |
| `setModel` | `{threadId, provider, model, reasoningEffort?}` | snapshot（含 `model`） |

- 目录来自宿主 `sessionController.modelCatalog()`；服务缺失时 `available:false`，面板只显示当前模型名、不开菜单。
- `setModel` 走 `agent.model.select(...)`，只写本线程的 `model/selection`，**不碰** profile 默认模型；`llm.resolveCallConfig` 存在时先规范化一次，非法路由回 400。
- `snapshot.model` 形如 `{provider, id, reasoningEffort?, label}`，面板标题右侧显示该 label。
- 换模型后下一轮生效；已在生成中的这一轮不会重跑。

## 7. 面板关闭的语义（已定）

- 面板关闭（tab 关掉 → 客户端组件 unmount → `setSettings({open:false})`）时，`read_freedom_chat` **从主对话上卸载**，能力彻底消失。
- 因此主对话若在面板关闭后才尝试读取，宿主会回 `unknown tool "read_freedom_chat"`。这是预期行为，不做常驻兜底：**面板不在＝对主对话零影响**。
- 心跳：面板开着时每次 `snapshot` 轮询都会刷新 `openPingAt`；超过 `OPEN_STALE_MS`（60s）没心跳，宿主自行把 `open` 置 false 并卸载工具（兜底异常关闭）。

## 8. 持久化与冷恢复（P3）

- 映射文件：`C:/Users/MIS/.dsh/freedomchat/threads.json`（`FREEDOMCHAT_STATE_DIR` 可覆盖），形如
  `{version:1, threads:{ "<parentSessionId>": {threadId, state:'live'|'archived', cwd, settings, updatedAt} }}`；
  原子写（`tmp` → rename），进程内串行。
- `ensure` 的顺序：内存里的活线程 → 注册表里的 `live` 条目（`agents.resume` 冷恢复）→ 新建。
  `state:'archived'` 直接回 `{threadId:null, state:'archived'}`，不新建。
- 重启后：线程 id 与开关都还在，历史消息由宿主从会话日志恢复；`open` 一律重置为 `false`（面板得重新打开）。
- 冷恢复也跑 `setup`，所以零工具与人格段照旧生效；**不会**继承主对话历史（子会话本来就是空白 seed）。
- 会话产物路径：`<DSH_HOME>/sessions/<projectSegment>/<threadId>/session.v4.jsonl.zstd`，
  `projectSegment` 由 cwd 编码（`D:\DSH\work` → `--D-DSH-work--`）。
- 归档/删除的探测每 `FREEDOMCHAT_SWEEP_MS`（默认 1000ms，测试置 0）一次，靠
  `workspaceRegistry.requireState().archivedSessionIds` 与 `sessionPersistence.stat(parent)`；
  两个服务都拿不到时不猜、不动数据。
- 这个探测由**宿主自带的定时器**跑（`setInterval`，随插件 effect 释放），不依赖客户端轮询：
  面板关掉、tab 隐藏、甚至从没打开过，只要主对话归档，一个节拍内就会清掉侧边线程。
- 已经退役的线程 id 留在一个进程内 `retired` 表里：面板若正好在那一拍上轮询，
  拿到的是 `{state:'archived'}` 而不是裸 404（客户端据此重新 `ensure`，不再显示「同步失败」）。

## 9. 归档即删与墓碑（P3）

- 主对话**归档**：`ensure`/`snapshot`/启动时扫到它在 `archivedSessionIds` 里 → 销毁线程 + 删除子会话产物 →
  注册表写墓碑 `{threadId:null, state:'archived'}`。
- 主对话**被删除**：`stat(parent)` 明确说没有（ENOENT / "no such session"）→ 同样按墓碑处理；
  其它错误一律视为"未知"，保留数据。
- 墓碑状态下客户端显示「主对话已归档，这个侧边对话已随之删除。」+「新建对话」按钮，
  隐藏输入框与提示；点「新建对话」调 `revive`，清墓碑并开一条全新线程。
- **取消归档**：墓碑只在主对话仍处于归档态时成立。用户取消归档后再打开面板，
  `ensure` 会发现主对话不在 `archivedSessionIds` 里，自动清墓碑并开一条**全新的空线程**——
  不会把已删的聊天还回来，也不会一直卡在「已归档」提示上。
- 判定粒度是扫描周期（约 1 秒）：归档后又在 1 秒内取消归档的极端操作可能抓不到；
  正常「归档 → 停一下 → 取消归档」一定会清空。
- 清空（`clear`）不算墓碑：销毁 + 立即新建一条空线程，映射指向新线程。

## 10. 会话产物的生命周期（不再累积）

- **创建**：注册表同时记下 `history`（该主对话创建过的所有线程 id，最多 50 条）。
- **清空**：销毁线程后**立即删除**旧线程的会话产物，不留档；新线程入库。
- **归档 / 主对话被删**：`retireThread` 删除 `threadId` 与 `history` 里的**全部**产物，
  然后写墓碑并清空 `history`。
- 早期版本只记一条映射、`clear` 也不删文件，所以重启与清空会各留一份孤儿——
  这些在 DSH 的「删除会话」确认框里会显示成额外的子智能体会话。
- 清理历史遗留：`node scripts/cleanup-orphans.mjs`（先 dry-run，加 `--delete` 才真删）。
  判定依据只认**本插件自己的系统提示词**（`与主对话隔离的独立线程`），
  并且必须 `origin:'subagent'` 且有 `parentSession`：
  主对话或别的插件的子会话即使提到"侧边自由对话"也不会被误删。

## 11. 空面板、清空与模型继承

- `peek({parentSessionId})`：**只解析、不创建**。返回 `state:'live' | 'empty' | 'archived'`。
  面板挂载走 `peek`，所以打开面板不会凭空多出一个空会话——这是之前"删主对话时冒出一串子会话"的又一个来源。
- `ensure` 只在**用户真的发消息**时调用：`state:'empty'` 下提交先 `ensure` 再 `send`。
- `clear` 的语义是**删除这个侧边对话**：销毁线程 + 删除会话产物 + 移除映射，返回
  `{state:'empty', threadId:null, cleared:true}`。不预先建替代线程，下一条消息才创建。
- 新线程的模型默认取**主对话当前模型**：`model.current()` → 主会话最后一条 `model/selection` 事件 →
  宿主目录的 `default`，三级回退；选中后立刻在子会话上 `model.select(...)` 绑定，并把
  `{provider, model, reasoningEffort}` 记进注册表，重启冷恢复时重新绑定。
- `setModel` 同时更新内存里的 modelHint 与注册表，保证快照永远有模型可显示（不再出现「模型未知」）。

## 12. 模型的补齐（resume / peek / ensure）

`modelHint` 只在创建时写一次不够：老线程（本补丁之前建的）注册表里没有模型，冷恢复后
`agent.model.current()` 也可能返回空。所以 `resumeThread`、`peek`、`ensure` 在返回快照前都会跑
`bindModelHint`：线程既没有上报模型、也没有记忆值时，重新按「主对话当前 → 最后一条
`model/selection` → 目录默认」解析一次，绑到子会话上并写回注册表。面板在拿到模型前显示「选择模型」，
不再显示「模型未知」。

## 13. 面板外形（对齐「侧边对话(beta)」）

- 宿主 tab 记录**没有 icon 字段**（`dsh-better-sidebar` 的 `NativeTabTitle` 注释原话："The host's tab definition has no icon field"），所以只给 tab 描述符加 `icon` 不会显示。真正的画法是占住 tab 标题槽：`ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: <tabId> })` 渲染「字形 + 标题」，与 beta 同一枚 comment-discussion 字形（颜色 `--dsw-alias-state-business-primary` → brand → label）。
- 两个开关（读从对话 / 联网）各带一枚指示灯：关＝空心细圈，开＝实心亮色点 + 2px 光晕；三态胶囊（读主对话）也用灯表态：允许＝绿、询问＝琥珀、不允许＝空心。
- 输入区结构（自上而下）：
  1. `textarea`（无边框，最大 132px 自动增高，Enter 发送 / Shift+Enter 换行）；
  2. 控件行：回形针（添加图片，也可直接粘贴）→ `读从对话` 开关 → `联网` 开关 → `读主对话 · 允许/询问/不允许`（点开三选一菜单）→ 弹性留白 → 模型胶囊（`▾` 打开模型/推理强度）→ 圆形发送键（运行中变停止键）；
  3. 附件行：图片缩略图 + 文件名 + 移除按钮。
- 容器：`border-radius:16`、1px 边框、`--dsw-specific-input-major` 底、`--dsw-shadow-lv2`，左右 8px 外边距。
- 模型选择不再放在标题栏；标题栏只留标题与清空按钮（开发期的版本角标已移除）。

## 14. Tab 字形与空面板下的开关（外观修正）

- **字形来自标题文本**：宿主的 tab 记录没有 icon 字段，strip 只画 `title` 文本（better-sidebar 的 `NativeTabTitle` 注释原文：`The host's tab definition has no icon field — a chip is drawn from the title text alone`）。扩展 tab 注册 `sidebar.right.pane.tab.title` 在本宿主上不生效，因此 `title()` 直接返回形如 `💬 侧边自由对话` 的标签；`icon()` 仍保留，供将来支持图标字段的宿主使用。
- **空面板下的开关**：面板处于 `empty` / `starting`（还没有 threadId）时，`updateSettings()` 先把改动缓存到 `pendingSettingsRef` 并乐观更新本地 `settings`，等 `announceOpen()`（首条消息建会话后，或 peek 命中已有线程后）把缓存与 `{ open: true }` 合并下发。此前这类点击会被 `if (!threadId) return` 静默吞掉，表现为「灯有、点了不亮」。
- **三个开关胶囊的样式**：无边框（`1px solid transparent`），只有悬停时整个圆角矩形浮起阴影并加深底色（`.fc-pill:hover`，用 `--dsw-shadow-lv2`）；开关状态只由左侧 6px 圆点表示，外框与文字不随状态变色。字形同样出现在侧边栏的引导卡片标题上（`guide[0].title` 用 `TAB_LABEL`）。
- **引导卡片的图标**：`guide[0].icon(props)` 返回 `tabIcon(props.size ?? 16)`，宿主把它画在标题左侧（与 beta 的卡片同构）；`guide[0].title` 保持纯文字，避免字形重复。
- **回形针按钮同款悬停**：图片按钮复用 `fc-pill` 类与 8px 圆角，悬停时与其他三个胶囊一样浮起阴影。
- **第三个胶囊也有灯**：「读主对话」按 allow/ask/deny 显示亮/琥珀/空心，和另外两个一致；此前误把 `'warn'` 当子节点，会在按钮上多渲染一个单词。
- **空状态两行必须竖排**：`styles.empty` 是 flex 容器，默认 `flexDirection: row` 会把「还没有侧边对话。」和说明并排成一行；已显式设为 `column`，并在 `render-smoke` 里加了断言（找到含该文案且 `flexDirection==='column'` 的容器）。
