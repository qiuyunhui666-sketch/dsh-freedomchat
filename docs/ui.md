# 客户端 UI（P1）
## 组件
`apply`（注册 tab + 右栏 pane 槽，返回 disposer）→ `Panel`（零 hooks，只把子树包进 `Boundary` 错误边界）→ `ChatPanel` 渲染 / `useFreedomChat` 管状态轮询动作。消息列表 `useMemo` 按数组标识缓存，打字不重排。
## 轮询
挂载调 `ensure` 拿首包 → 自调度 `snapshot(threadId, version)`：`running` 350ms，空闲 1300ms。`version` 不变时宿主只回 `{version, status}`，保留旧 messages。卸载用 effect 清理置 `stopped` + `alive`，杜绝已卸载 setState。
## 传输接缝（lib/client.js:45，`call` 在 46 行）
`call(method, payload) → Promise`，UI 只经 5 个薄封装；替换 `transport.call` 即可，UI 不用再改：
- `ensure` `{parentSessionId}` → `{threadId, snapshot}`
- `snapshot` `{threadId, version}` → `{version, status, messages?, model?, error?}`
- `send` `{threadId, parts}` → `{version}`
- `cancel` `{threadId}` → `{version}`
- `clear` `{threadId}` → `{threadId, snapshot}`
## 已知限制
- primitives 不可用时 assistant 正文降级为 pre-wrap 纯文本。
- assistant 图片 part 只回 `attachmentId`，无取图通道，显示「图片：名字」占位。
- 无虚拟列表（≤200 条直接 map）；不做消息编辑、多线程、模型选择。