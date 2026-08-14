# SBA — Last Matching Tab Auto Cleanup 技术方案

## 1. 功能目标

实现一个自动清理功能：

> 当用户关闭最后一个匹配敏感规则的 Tab 后，等待用户配置的 X 分钟，如果期间没有重新出现匹配 Tab，则自动清理指定的敏感浏览数据。

示例：

```text
用户配置：
Cleanup delay = 30 minutes

10:00  最后一个匹配 Tab 被关闭
10:00  开始倒计时
10:20  用户没有重新打开匹配 Tab
10:30  自动清理敏感数据
```

如果倒计时期间重新出现匹配 Tab：

```text
10:00  最后一个匹配 Tab 关闭
10:20  用户重新打开匹配 Tab
       ↓
       取消当前 cleanup timer
```

之后再次关闭最后一个匹配 Tab：

```text
10:25  最后一个匹配 Tab 关闭
       ↓
       重新开始 30 分钟倒计时
10:55  自动清理
```

---

# 2. 核心设计原则

### 2.1 不使用 `setTimeout` / `setInterval`

Manifest V3 Extension 的 background service worker 不是永久运行的。

禁止依赖：

```js
setTimeout(...)
setInterval(...)
```

用于跨时间段的自动清理任务。

必须使用：

```js
chrome.alarms;
```

---

### 2.2 不依赖内存状态

以下状态不能只存在于 Service Worker 内存：

```js
let cleanupAt;
let sessionActive;
let timer;
```

因为 Service Worker 随时可能被 Chrome 回收。

持久状态必须使用：

```js
chrome.storage.local;
```

---

### 2.3 Alarm 不是唯一可靠机制

必须同时保存：

```text
cleanupAt
```

Alarm 只是：

> Chrome 运行期间负责在指定时间唤醒 Extension。

真正的清理时间由：

```text
cleanupAt = absolute timestamp
```

决定。

如果 Chrome 在倒计时期间关闭：

```text
Alarm 无法运行
```

但是：

```text
cleanupAt
```

仍然保存在 `chrome.storage.local`。

下次 Chrome 启动时重新判断是否应该清理。

---

# 3. Sensitive Session 概念

不要把这个功能简单实现成：

> “某个 Tab 被关闭 → 启动 timer”。

应该引入：

## Sensitive Session

定义：

> 当前浏览器中存在至少一个匹配 SBA 敏感规则的 Tab 时，Sensitive Session 为 active。

例如：

```text
Tab A → 匹配
Tab B → 不匹配

Sensitive Session = active
```

如果：

```text
Tab A → 关闭
```

且没有其他匹配 Tab：

```text
Sensitive Session = ended
```

此时开始 cleanup countdown。

---

# 4. Tab 匹配规则

必须复用 SBA 已有的统一匹配逻辑。

不要为自动清理重新实现一套关键词匹配。

建议统一使用：

```ts
isSensitiveMatch(tab);
```

该函数负责判断 Tab 是否匹配用户配置的规则。

匹配依据根据 SBA 当前产品设计决定，例如：

```text
URL
Title
```

不要在 Auto Cleanup 模块内部直接解析关键词。

---

# 5. 需要监听的 Chrome Events

必须监听：

```js
chrome.tabs.onCreated;
chrome.tabs.onUpdated;
chrome.tabs.onRemoved;
```

### `onCreated`

用于检测新创建的 Tab。

例如：

```text
Google
   ↓
新建 Tab
   ↓
进入敏感网站
```

最终由 `onUpdated` 检测。

---

### `onUpdated`

非常重要。

必须处理：

```text
Tab URL 变化
Tab title 变化
```

因为一个已有 Tab 可以：

```text
普通网站
   ↓
敏感网站
```

也可以：

```text
敏感网站
   ↓
普通网站
```

因此不能只监听 Tab 创建/关闭。

---

### `onRemoved`

当 Tab 被关闭时重新计算当前是否还有匹配 Tab。

---

# 6. 核心状态

在：

```text
chrome.storage.local
```

中保存 Auto Cleanup 状态。

建议：

```ts
interface AutoCleanupState {
  enabled: boolean;

  delayMinutes: number;

  cleanupAt: number | null;

  sessionActive: boolean;

  cleanupPending: boolean;
}
```

说明：

### `enabled`

是否启用此功能。

---

### `delayMinutes`

用户设置的等待时间。

例如：

```text
5
15
30
60
```

---

### `cleanupAt`

计划执行清理的绝对时间戳。

例如：

```text
Date.now() + delayMinutes * 60 * 1000
```

如果当前没有 pending cleanup：

```text
null
```

---

### `sessionActive`

当前是否存在 Sensitive Session。

注意：

这个值可以作为持久状态，但**不要完全相信它**。

需要时必须通过：

```js
chrome.tabs.query({});
```

重新计算真实状态。

---

### `cleanupPending`

是否存在一个等待执行的 cleanup。

---

# 7. 核心函数

建议实现以下模块/函数。

---

## `hasMatchingTabs()`

```ts
async function hasMatchingTabs(): Promise<boolean>;
```

实现：

```text
chrome.tabs.query({})
        ↓
遍历 Tabs
        ↓
isSensitiveMatch(tab)
        ↓
只要一个匹配 → true
```

不要维护一个长期存在的：

```js
Set<tabId>
```

作为唯一数据源。

因为 Tab 可能：

- 关闭
- 导航
- Chrome 重启
- Extension 重启
- Service Worker 重启

需要判断时直接重新查询当前 Tabs。

---

# 8. `reevaluateSensitiveSession()`

这是核心函数。

伪代码：

```ts
async function reevaluateSensitiveSession() {
  const hasMatching = await hasMatchingTabs();
  const state = await getAutoCleanupState();

  if (hasMatching) {
    // Sensitive Session active

    if (state.cleanupPending) {
      await cancelCleanup();
    }

    await updateState({
      sessionActive: true,
      cleanupPending: false,
      cleanupAt: null,
    });

    return;
  }

  // No matching tabs

  if (!state.sessionActive) {
    // 用户从未进入过 Sensitive Session
    return;
  }

  if (!state.cleanupPending) {
    await scheduleCleanup();
  }
}
```

---

# 9. 第一个匹配 Tab 出现

例如：

```text
当前：

没有匹配 Tab
```

用户打开：

```text
example.com
```

并且匹配关键词。

流程：

```text
onUpdated
    ↓
reevaluateSensitiveSession()
    ↓
hasMatchingTabs() = true
    ↓
sessionActive = true
    ↓
cancel any pending cleanup
```

此时不要启动 Cleanup。

---

# 10. 最后一个匹配 Tab 消失

例如：

```text
Tab A = 匹配
Tab B = 普通
```

用户关闭 Tab A：

```text
onRemoved
    ↓
reevaluateSensitiveSession()
    ↓
hasMatchingTabs() = false
    ↓
之前 sessionActive = true
    ↓
开始 cleanup countdown
```

计算：

```ts
cleanupAt = Date.now() + delayMinutes * 60 * 1000;
```

保存：

```text
cleanupPending = true
cleanupAt = timestamp
sessionActive = true
```

然后创建 Alarm。

---

# 11. 创建 Alarm

使用：

```js
chrome.alarms.create("sba-auto-cleanup", {
  when: cleanupAt,
});
```

推荐使用：

```text
when
```

而不是只使用：

```text
periodInMinutes
```

因为这个功能是一次性的 delayed action，不是周期任务。

---

# 12. Alarm 到期后不能直接清理

这是非常重要的安全规则。

Alarm：

```text
sba-auto-cleanup
```

触发后：

**禁止直接调用 cleanup。**

必须重新检查：

```text
当前是否存在匹配 Tab？
```

流程：

```text
Alarm fired
    ↓
hasMatchingTabs()
    ↓
     ┌──────────────┐
     │              │
    YES            NO
     │              │
     ↓              ↓
取消 cleanup       检查 cleanupAt
                    ↓
                当前时间 >= cleanupAt？
                    │
              ┌─────┴─────┐
             YES          NO
              │            │
              ↓            ↓
           cleanup      recreate Alarm
```

这样可以防止：

> Alarm 到期时，用户其实已经重新打开敏感 Tab。

---

# 13. 重新出现匹配 Tab

这是最重要的取消逻辑。

例如：

```text
10:00
最后一个匹配 Tab 关闭

cleanupAt = 10:30
```

10:20：

```text
用户打开匹配 Tab
```

`onCreated` / `onUpdated`：

```text
reevaluateSensitiveSession()
    ↓
hasMatchingTabs() = true
    ↓
chrome.alarms.clear("sba-auto-cleanup")
    ↓
cleanupPending = false
cleanupAt = null
sessionActive = true
```

**不能继续使用原来的 10:30 cleanup。**

---

# 14. 再次关闭最后一个匹配 Tab

例如：

```text
10:25
最后一个匹配 Tab 再次关闭
```

必须重新计算：

```text
cleanupAt = 10:55
```

而不是继续使用：

```text
10:30
```

因此：

```text
last matching tab closed
        ↓
NEW cleanupAt
        ↓
NEW Alarm
```

---

# 15. 浏览器关闭场景

浏览器关闭后：

> Extension 无法继续执行后台清理。

因此不能依赖 Chrome 在后台继续运行。

假设：

```text
10:00
最后一个匹配 Tab 关闭

cleanupAt = 10:30
```

10:05：

```text
用户关闭 Chrome
```

此时：

```text
cleanupAt
```

仍然存在于：

```text
chrome.storage.local
```

但是：

```text
Alarm
```

不能保证在 Chrome 完全关闭期间执行。

---

# 16. Chrome 启动时恢复

必须监听：

```js
chrome.runtime.onStartup;
```

启动后：

```text
onStartup
    ↓
hasMatchingTabs()
    ↓
检查 cleanup state
```

---

## 情况 A：启动后存在匹配 Tab

例如 Chrome 恢复了之前的 Tab：

```text
Chrome startup
    ↓
发现匹配 Tab
```

必须：

```text
cancel pending cleanup
sessionActive = true
cleanupPending = false
cleanupAt = null
```

**不能因为 cleanupAt 已经过期就直接清理。**

---

## 情况 B：没有匹配 Tab + cleanupAt 已过期

例如：

```text
cleanupAt = 10:30

Chrome 10:05 关闭
Chrome 第二天 09:00 启动
```

启动时：

```text
hasMatchingTabs() = false

Date.now() >= cleanupAt
```

执行：

```text
cleanupSensitiveData()
```

然后：

```text
cleanupPending = false
cleanupAt = null
sessionActive = false
```

---

## 情况 C：没有匹配 Tab + cleanupAt 尚未到期

例如：

```text
cleanupAt = 10:30

Chrome 10:05 关闭
Chrome 10:15 启动
```

此时：

```text
hasMatchingTabs() = false
Date.now() < cleanupAt
```

重新创建：

```text
sba-auto-cleanup
```

直到 10:30。

---

# 17. 浏览器重启后的完整逻辑

```text
Chrome startup
      ↓
load state
      ↓
query all tabs
      ↓
hasMatchingTabs?
      │
 ┌────┴────┐
YES       NO
 │          │
 ↓          ↓
cancel     cleanupPending?
cleanup       │
 │        ┌───┴───┐
 ↓       NO      YES
session    │       │
active     ↓       ↓
        nothing   check cleanupAt
                    │
             ┌──────┴──────┐
           expired       future
              │             │
              ↓             ↓
           cleanup      recreate Alarm
```

---

# 18. Service Worker 被回收

Service Worker 被 Chrome 回收是正常行为。

重新唤醒后：

**不要依赖内存变量恢复状态。**

所有必要状态来自：

```text
chrome.storage.local
```

当前 Tab 状态来自：

```text
chrome.tabs.query({})
```

定时任务来自：

```text
chrome.alarms
```

---

# 19. Cleanup Engine 与 Session Manager 分离

不要让 Session Manager 直接实现具体的数据删除逻辑。

建议：

```text
session-manager
    ↓
决定什么时候需要 cleanup

cleanup-manager
    ↓
决定具体删除什么
```

例如：

```ts
await cleanupSensitiveData();
```

内部再根据用户设置：

```text
Browsing History
Downloads History
Cookies & Site Data
Cache
```

决定调用哪些 Chrome API。

这样未来可以修改清理项目，而不需要修改 Session 逻辑。

---

# 20. `cleanupSensitiveData()` 的原则

Auto Cleanup 必须调用已有的统一 Cleanup Engine。

不要再写一套独立的清理代码。

例如：

```ts
cleanupSensitiveData({
  reason: "auto-session-timeout",
});
```

Cleanup Engine 根据当前设置执行：

```text
History cleanup
Downloads History cleanup
Cookies cleanup
...
```

---

# 21. 防止重复执行

Cleanup 必须具有幂等性。

例如：

```text
Alarm fired
Service Worker 重复唤醒
```

不能导致：

```text
cleanup × 2
```

执行前检查：

```text
cleanupPending === true
```

以及：

```text
当前没有匹配 Tab
```

清理完成后立即：

```text
cleanupPending = false
cleanupAt = null
sessionActive = false
```

---

# 22. Storage 数据建议

建议最终结构：

```ts
interface AutoCleanupState {
  enabled: boolean;

  delayMinutes: number;

  sessionActive: boolean;

  cleanupPending: boolean;

  cleanupAt: number | null;
}
```

例如：

```json
{
  "enabled": true,
  "delayMinutes": 30,
  "sessionActive": true,
  "cleanupPending": true,
  "cleanupAt": 1786693800000
}
```

注意：

`cleanupAt` 必须是**绝对时间戳**，不能只保存：

```text
remainingMinutes = 30
```

---

# 23. Settings 修改时必须重新评估

监听：

```js
chrome.storage.onChanged;
```

如果用户修改：

```text
Auto Cleanup enabled
Delay
Keywords
Cleanup data types
```

必须调用：

```text
reevaluateSensitiveSession()
```

特别是修改关键词后：

```text
原来：

example.com = sensitive

用户删除 example.com

当前 Tab 不再匹配
```

此时应该视为：

```text
Sensitive Session ended
```

并开始倒计时。

反过来：

```text
原来不匹配
用户新增关键词
当前 Tab 变成匹配
```

应该：

```text
cancel pending cleanup
```

---

# 24. 浏览器事件与状态变化总结

| 事件                  | 操作                   |
| --------------------- | ---------------------- |
| 新建 Tab              | 重新检查               |
| Tab URL 改变          | 重新检查               |
| Tab title 改变        | 重新检查               |
| Tab 关闭              | 重新检查               |
| Keywords 修改         | 重新检查               |
| Auto Cleanup 设置修改 | 重新检查               |
| Chrome 启动           | 恢复状态并重新检查     |
| Alarm 触发            | 重新检查后决定是否清理 |

---

# 25. 不允许的实现方式

Agent 实现时禁止：

### ❌ 使用 setTimeout

```js
setTimeout(cleanup, delay);
```

### ❌ 使用 setInterval

```js
setInterval(check, 60000);
```

### ❌ 只保存 Tab ID

```js
const sensitiveTabs = new Set();
```

不能把它作为唯一状态来源。

### ❌ Alarm 到期直接清理

必须重新检查当前 Tab。

### ❌ 只监听 onRemoved

因为 Tab 可以通过导航从敏感变成普通，或者普通变成敏感。

### ❌ 只依赖内存状态

Service Worker 可以随时被回收。

---

# 26. 推荐模块结构

如果项目目前已经有 background/service worker，按照现有项目结构适配，不要强制重构。

如果需要新建模块，可以参考：

```text
src/
  background/
    auto-cleanup/
      session-manager.ts
      cleanup-scheduler.ts
      state.ts

    cleanup/
      cleanup-manager.ts

    matching/
      tab-matcher.ts
```

职责：

```text
tab-matcher.ts
    ↓
判断 Tab 是否匹配

session-manager.ts
    ↓
管理 Sensitive Session 生命周期

cleanup-scheduler.ts
    ↓
管理 chrome.alarms

state.ts
    ↓
管理 chrome.storage.local

cleanup-manager.ts
    ↓
真正执行数据清理
```

---

# 27. 推荐核心流程

最终实现应符合下面这个状态机：

```text
                    ┌──────────────────────┐
                    │                      │
                    │   NO ACTIVE SESSION  │
                    │                      │
                    └──────────┬───────────┘
                               │
                         matching tab
                            appears
                               │
                               ↓
                    ┌──────────────────────┐
                    │                      │
                    │   SESSION ACTIVE     │
                    │                      │
                    └──────────┬───────────┘
                               │
                     last matching tab
                           disappears
                               │
                               ↓
                    ┌──────────────────────┐
                    │                      │
                    │  CLEANUP PENDING     │
                    │                      │
                    │  cleanupAt = T       │
                    │  Alarm = T           │
                    │                      │
                    └──────┬───────────────┘
                           │
              ┌────────────┴────────────┐
              │                         │
       matching tab appears        Alarm fires
              │                         │
              ↓                         ↓
       CANCEL CLEANUP             re-check tabs
              │                         │
              │                   ┌─────┴─────┐
              │                  YES          NO
              │                   │            │
              │                   ↓            ↓
              │                CANCEL       cleanupAt
              │                             expired?
              │                                │
              │                           ┌────┴────┐
              │                          NO         YES
              │                           │           │
              │                           ↓           ↓
              │                     recreate      CLEANUP
              │                       Alarm           │
              │                                       ↓
              └───────────────────────────────  SESSION END
```

---

# 28. 验收标准

实现完成后必须测试以下场景：

### Test 1 — 正常流程

```text
匹配 Tab
→ 关闭
→ 等待 X 分钟
→ 自动清理
```

---

### Test 2 — 倒计时中重新打开匹配 Tab

```text
匹配 Tab
→ 关闭
→ 开始倒计时
→ 重新打开匹配 Tab
→ Cleanup 必须取消
```

---

### Test 3 — 重新关闭

```text
重新打开匹配 Tab
→ 再次关闭
→ 必须重新开始完整 X 分钟倒计时
```

---

### Test 4 — Tab 导航

```text
普通 Tab
→ 导航到匹配网站
→ Session 必须启动
```

---

### Test 5 — 反向导航

```text
匹配 Tab
→ 导航到普通网站
→ 如果这是最后一个匹配 Tab
→ 开始倒计时
```

---

### Test 6 — 多个匹配 Tab

```text
Tab A = matching
Tab B = matching

关闭 A
→ 不启动 cleanup

关闭 B
→ 启动 cleanup
```

---

### Test 7 — Chrome 关闭

```text
最后一个匹配 Tab 关闭
→ cleanupAt 保存

关闭 Chrome
→ 不要求后台执行

重新打开 Chrome
→ 根据 cleanupAt 判断
```

---

### Test 8 — Chrome 重启后仍有匹配 Tab

```text
匹配 Tab
→ 关闭 Chrome
→ Chrome 恢复 Tab
→ 启动 Extension

必须：
取消 cleanup
保持 Session Active
```

---

### Test 9 — Chrome 重启后已经超过 cleanupAt

```text
cleanupAt = 10:30

Chrome 10:00 关闭
Chrome 12:00 启动

没有匹配 Tab
→ 立即 cleanup
```

---

### Test 10 — Service Worker 被回收

在 cleanup 倒计时期间让 Service Worker 被 Chrome 回收。

重新唤醒后：

```text
状态不能丢失
cleanupAt 不能丢失
```

---

# 29. 最终实现原则

整个功能可以浓缩成：

```text
Chrome Tabs
    ↓
实时判断是否存在 matching tabs
    ↓
存在
    → Session Active
    → Cancel Cleanup

不存在
    ↓
之前是否有 Active Session？
    ↓
YES
    → 保存 cleanupAt
    → 创建 chrome.alarm

Alarm 到期
    ↓
重新检查 matching tabs
    ↓
没有 matching tabs
    ↓
cleanupAt 已到
    ↓
执行统一 Cleanup Engine
```

**最重要的三个技术点：**

1. **`chrome.tabs` 判断当前是否存在匹配 Tab**
2. **`chrome.alarms` 实现延迟唤醒**
3. **`chrome.storage.local` 持久化 `cleanupAt`，保证 Chrome 重启后可以恢复**

不要依赖 Service Worker 常驻，也不要依赖 JS Timer。
