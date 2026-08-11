# Plan: Auto Privacy Cleanup

> 状态：设计阶段。尚未实现，仅作为下一版本的候选功能。
> 关联需求：用户希望定时或实时地自动清理浏览器中的隐私痕迹。

## Context

当前 Stealth Browser Assistant 专注于"在敏感场景下隐藏 / 静音 / 关闭标签页"，但**不会清理这些操作留下的痕迹**——浏览器历史、Cookies、Cache、下载记录仍然记录着用户的访问。已有的静默操作只解决"看的人看不到"，并没有解决"事后被翻出来"的风险。

填充这个空白的下一个功能就是 **Auto Privacy Cleanup**：按照用户配置的策略（定时 / 触发式），自动调用 Chrome 的 `browsingData` 和 `downloads` API，擦除隐私痕迹。

## Goals

让用户能：

1. 自动按周期清理所选类型的数据（history / cookies / cache / downloads）。
2. 在紧急模式触发时同步清理（"panic flush"）。
3. 手动一键立即清理（不依赖定时器）。
4. 查看上次清理时间。

## Non-goals

- **不**实现选择性域名白名单（"只清理这些域之外的数据"）。这是后续 v2 的事，会显著拉高复杂度。
- **不**实现密码、form 表单、localStorage 的清理。范围限定为用户列出的 4 项。
- **不**实现"清理前提示"。自动清理是无声的；如果用户需要"确认对话框"模式，提供手动按钮即可。
- **不**清理扩展自身的数据（`chrome.storage.local`、cacheStorage、service worker 等等都不动）。

## API & 权限

### Permissions

需要新增以下 manifest permissions：

```json
"permissions": [
  "tabs", "storage", "scripting",
  "browsingData",   // 历史 / cookies / cache
  "downloads"       // 下载记录
]
```

不需要 `history` 和 `cookies` 单独声明——`browsingData` 权限已经覆盖了 history / cookies 的清理需求。

### API 用法

`chrome.browsingData.remove(originTypes, dataToRemove)` 是核心入口：

```js
await chrome.browsingData.remove(
  { unprotectedWeb: true },           // 不动扩展/受保护 Web
  {
    history: true,
    cookies: true,
    cache: true,
    // populated from user settings
  },
);
```

下载记录单独处理：

```js
// 仅清记录，文件留着
await chrome.downloads.erase({ state: 'complete' });
// 如要连文件一起删，需要先查 list 再 removeFile
```

按用户要求"Download 记录"（不是 Download 文件），所以只 erase 即可。

### chrome.alarms 限制

- `periodInMinutes` 最小为 **1 分钟**（生产环境）。
- 浏览器限制 alarm 频率以节能。1 分钟档在 Chrome idle 时可能被 throttled 到几十分钟——可以接受，因为清理频率不太可能低于 1 分钟。
- "On startup" 模式不需要 alarm，用 `chrome.runtime.onStartup` / `chrome.runtime.onInstalled` 监听器即可。

## Storage schema

新增到 `shared.js` 的 `STORAGE_KEYS`：

| Key | 类型 | 默认 | 含义 |
|---|---|---|---|
| `AUTO_CLEANUP_ENABLED` | bool | `false` | 总开关 |
| `AUTO_CLEANUP_INTERVAL_MIN` | number | `60` | 定时周期（分钟）；0 = 仅启动时 |
| `AUTO_CLEANUP_TYPES` | object | `{history:false, cookies:false, cache:false, downloads:false}` | 清理哪些 |
| `AUTO_CLEANUP_ON_EMERGENCY` | bool | `false` | 紧急模式时也触发 |
| `AUTO_CLEANUP_LAST_RUN` | number | `0` | 上次跑的 timestamp |

新增 getter：`getAutoCleanupConfig()` 返回整理后的对象，`setAutoCleanupConfig(partial)` 部分写入。避免每次去 storage 读 5 次。

## UI 设计

新增一个 `.card`，放在 emergency action / media pause 之后，shortcuts 之前。

```
┌─ Auto privacy cleanup ─────────────────────────────┐
│ Run automatic cleanup of browsing data to remove    │
│ traces of sensitive activity.                       │
│                                                     │
│ [ ] Enable auto cleanup                             │
│                                                     │
│ (when enabled ↓)                                    │
│                                                     │
│   Frequency: [Every 1 hour   ▼]                     │
│                                                     │
│   What to clean:                                    │
│   [ ] Browsing history                              │
│   [ ] Cookies                                       │
│   [ ] Cache                                         │
│   [ ] Download records                              │
│                                                     │
│   [ ] Also run on emergency mode                    │
│                                                     │
│   [ Run cleanup now ]    Last run: 2 min ago        │
└─────────────────────────────────────────────────────┘
```

可选选项：interval 改成 radio 而不是 select。select 在已有 locale 文件里有过 list 经验，照搬。

### 首次启用提示

总开关从 off → on 时，弹一个 native confirmation dialog（`chrome.notifications` 或者首次展开子选项的 inline 提示），内容是"清理不可撤销，已选 X / Y / Z"。最简单的实现：直接在 options.html 里加一个 inline hint（disabled 时显示："清理不可撤销，首次启用前请确认已选类型"），不引入 notification 权限。

## 实现步骤

### Phase 1 — 基础设施

1. `manifest.json`：加 `browsingData` + `downloads` 权限。
2. `shared.js`：加 5 个 storage key + 默认值 + `getAutoCleanupConfig` / `setAutoCleanupConfig`。
3. `background.js`：
   - 顶层 `runAutoCleanup()` 函数：根据当前 `AUTO_CLEANUP_TYPES` 调 `browsingData.remove` + `downloads.erase`。
   - `chrome.alarms.onAlarm` 监听器，到点了就调 `runAutoCleanup()`。
   - `chrome.runtime.onStartup` / `chrome.runtime.onInstalled` 监听器，启动时按 interval 注册 alarm。
   - `chrome.storage.onChanged` 监听器，settings 改了重新注册 alarm。

### Phase 2 — UI

4. `options.html`：新增 "Auto privacy cleanup" card，含 1 个 master toggle + 1 个 select + 4 个 type checkbox + 1 个 emergency checkbox + 1 个 run-now button + 1 个 last-run 文本。
5. `options.js`：master toggle 切换时显示 / 隐藏子选项；select / checkbox 变更时立即写 storage；run-now 按钮 sendMessage 到 background 触发清理；启动时读 last-run 转 "X min ago" 文本。
6. `styles.css`：复用 `.checkbox-option`。不需要新样式。

### Phase 3 — 触发整合

7. `chrome.commands.onCommand` 的 `emergency-mode` 命令处理中（[background.js:271-285](background.js)），在 muteHide 分支执行完 hide/setMute 后，如果 `AUTO_CLEANUP_ON_EMERGENCY` 为 true 且 `AUTO_CLEANUP_ENABLED` 为 true，调用 `runAutoCleanup()`。"close" 分支跳过——已经关标签了，痕迹可能更少，不需要补一刀。
8. `chrome.runtime.onMessage` 的 `status` 响应里加 `autoCleanup: { enabled, lastRun }` 字段，popup 可以展示但不强制。

### Phase 4 — 边界

9. Service worker 启动时如果没有 alarm 但 interval > 0，补一个。
10. 用户从 enabled 切到 disabled 时，`chrome.alarms.clear('auto-cleanup')` 删掉定时器。
11. Storage 写入失败时不抛错，记录 console warn。
12. `runAutoCleanup` 内部用 `Promise.allSettled` 跑每个清理，万一某个失败不阻塞其他。

## 边界与权衡

| 场景 | 决策 |
|---|---|
| Cache 清理很重 | 文档说明"勾选 cache 可能影响所有未保存的页面 state" |
| Cookie 清理会让所有网站登出 | 默认 off，勾选时 UI 显示 inline 警告 |
| 紧急模式触发清理 + 关闭标签 | "close" 路径不清理（关标签已经隐式减少了痕迹） |
| Service Worker idle 时 alarm 不准时 | 接受。`chrome.alarms` 文档明确说会有 throttling |
| 用户已经禁用了 Stealth Browser Assistant 某项 service | 仍然按 settings 跑清理（cleanup 是独立的，不依赖 mute/hide） |
| 紧急模式触发但 enabled=false | 不跑。两个开关是 AND 关系 |
| 手动"Run cleanup now" | 不需要 cooldown，但记 lastRun |
| 多个 checkbox 都没勾 | runAutoCleanup 跳过去，记一次空 run（lastRun 更新） |

## 验证 (Verification)

1. 启用 auto cleanup + 全部 4 项 + interval 1 分钟。
2. 打开几个网站，登入账号。
3. 等 1 分钟后 → 历史空、cookies 空、cache 空、下载记录空。
4. popup 打开 → 显示 "Last run: just now"。
5. 切一个网站 → 登出（cookies 没了），但 active tab 不受影响。
6. 关闭 cleanup → 闹钟消失，10 分钟后历史还在。
7. 打开一次紧急模式（按 `Alt+Shift+E`）→ 如果 emergency cleanup 开启且 cleanup enabled → 同样的清理。
8. 跨启动验证：重启浏览器 → onStartup 触发清理（如果 interval=0）。

## 未来扩展（不在本 PR）

- **域名白名单**："保留这些域的 history / cookies"。实现上 `browsingData.remove` 支持 `excludeOrigins` 数组。完整白名单 UI 需要两栏列表 + drag-reorder，工作量大。
- **关闭浏览器时清理**：`chrome.runtime.onSuspend` 不保证会跑（service worker 随时可能卸掉）。需要换 `chrome.runtime.onSuspendCanceled` 或者让 native messaging 触发，但都不够干净。倾向于"超过 N 分钟未活动时清理"代替。
- **主动通知用户**："已清理 247 个历史 / 1.2GB cache"。需要统计 API 返回（`browsingData.remove` 不返回数字）。可以分别调 `history.search()` / `storage.estimate()` 计算前后差。
- **可清理类型扩展**：passwords、formData、localStorage、indexedDB、serviceWorkers 等，browsingData 都支持；但需要 RBAC 提示用户。

## 风险

- **`browsingData` 是高危权限**。商店审核时 Chrome Web Store 会要求详细的隐私说明和正当理由。
- **MV3 service worker 随时可能被回收**。如果用户希望"每隔 30 分钟清理"，必须依赖 `chrome.alarms` 而不是 `setInterval`——后者在 SW 卸掉后会停。
- **测试难**。`browsingData.remove` 实际清理数据后无法 in-memory 验证。需要手动核验 DevTools → Application → Storage。
- **不清理扩展自己的 storage**。新人容易踩坑；需要在 `runAutoCleanup` 注释里写明为何 originTypes 只有 `unprotectedWeb: true`。
