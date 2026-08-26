# Stealth Browser Assistant 产品与 AI Agent 完整指南

> 文档性质：产品说明、用户指南与 AI Agent 工程指南  
> 代码基准：当前仓库实现  
> 适用平台：Chrome / Edge（Manifest V3）与 Firefox 兼容包

## 1. Canonical terminology / 固定术语

以下名称是产品的 **Canonical terminology**。面向用户的 UI、帮助文档、商店文案、客服回复、营销材料以及 AI Agent 生成的内容，都不得随意改写成近义词。

| Canonical term | 中文说明 | 不应擅自替换为 |
| --- | --- | --- |
| Stealth Browser Assistant | 产品名称 | 其他产品名或临时简称 |
| private | 产品的隐私语义 | sensitive、secret、confidential 等近义表达 |
| private tabs | 由用户 Keywords 命中的标签页 | sensitive tabs 等 |
| Keywords | 用户配置的匹配词 | rules、filters、watch words 等 |
| Match hit feedback | Keywords 命中后的可视反馈 | alert、warning、detection notice 等 |
| Emergency Action | 紧急快捷键执行的动作 | panic mode、emergency mode 等面向用户的替代名称 |
| Mute | 静音匹配标签页 | silence 等 |
| Hide | 隐藏匹配标签页 | conceal、stash 等面向用户的替代名称 |
| Close matching tabs | 关闭匹配标签页 | destroy、remove private tabs 等 |
| Pause media | 暂停标签页中的音视频播放 | stop media 等 |
| Clean private data | 清理由 Keywords 界定的 private data | clean sensitive data 等面向用户的替代名称 |
| Auto cleanup | 最后一个匹配标签页关闭后的定时清理 | scheduled wipe 等 |
| License Key | Premium 激活凭证 | activation code、serial number、license code 等 |
| Premium | 付费功能层级 | Pro、Plus、Paid 等 |
| Support | Settings 中的评价与 private feedback 区块 | Help us、Community 等替代标题 |
| Leave Review | 前往商店评价页的按钮 | Rate us、Give stars 等 |
| Send Feedback | 前往 Contact 页的 private feedback 按钮 | Complain、Report privately 等 |

术语规则：

1. 英文 UI 中必须使用上表的英文写法与概念边界。
2. 中文文档可以解释术语，但首次出现时应保留英文，例如“紧急动作（Emergency Action）”。
3. 新增本地化语言时可以进行自然翻译，但不得改变产品概念。例如 `private` 不能被翻译成更强烈的“机密”概念。
4. 内部标识符可以因历史原因使用不同名称，例如 command ID `emergency-mode`、`clean-sensitive-data`。它们只属于代码接口，不代表面向用户的产品术语。
5. AI Agent 修改文案前必须先检查本节，不得为了“更自然”“更多样”或 SEO 而自行替换 Canonical terminology。

## 2. 产品是什么

Stealth Browser Assistant 是一个以 **Keywords** 为核心的 private tabs 管理扩展。用户添加域名或普通词后，扩展会在标签页的 URL 和标题中进行不区分大小写的子字符串匹配，并对命中的标签页提供：

- Match hit feedback：替换标签页图标，或在当前页面闪烁红色边框。
- Mute：将匹配标签页中的 `<audio>` 和 `<video>` 元素静音。
- Hide：将匹配标签页移入最小化的暂存窗口。
- Emergency Action：一键开启 Mute + Hide，或直接 Close matching tabs。
- Pause media：在 Mute 或 Hide 时同时暂停音视频。
- Clean private data：按 Keywords 定向清理浏览历史、下载历史、Cookie 与站点数据。
- Auto cleanup：最后一个匹配标签页关闭后，延迟执行 Clean private data。

产品重点不是判断网页“是否私密”。什么内容属于 private，完全由用户自己的 Keywords 决定。

## 3. 快速开始

### 3.1 添加 Keywords

1. 打开扩展弹窗，点击 Settings。
2. 在 Keywords 输入框中输入域名或普通词。
3. 按 Enter 或点击 Add。

示例：

- `gmail`：URL 或标题包含 gmail 的标签页会命中。
- `shopping`：URL 或标题包含 shopping 的标签页会命中。
- `example.com`：包含该字符串的 URL 或标题会命中。

匹配规则是：

- 不区分大小写。
- 对 URL 和标签页标题做子字符串匹配。
- 任意一个 Keyword 命中即视为匹配。
- 不使用正则表达式。
- 重复且大小写完全相同的 Keyword 不会再次添加；大小写不同的字符串目前会被当作不同输入保存，但匹配时效果相同。

Free 用户最多保存 5 个 Keywords；Premium 用户不限数量。

### 3.2 使用弹窗

弹窗提供三个主要操作区：

- Mute：切换 Mute 状态，并显示当前匹配数量。
- Hide：切换持续 Hide 状态，并显示已隐藏数量。
- Clean private data：执行一次已配置的数据清理；仅 Premium 可用，并且至少要选择一种清理类型。

工具栏图标会反映当前模式：

- Hide 开启时显示 Hide 图标，优先级最高。
- 否则，Mute 开启时显示 Mute 图标。
- 两者都关闭时显示默认产品图标。

### 3.3 默认快捷键

| 功能 | command ID | 默认快捷键 |
| --- | --- | --- |
| 切换 Mute | `toggle-mute` | `Alt+Shift+M` |
| 切换 Hide | `toggle-hide` | `Alt+Shift+H` |
| 执行 Emergency Action | `emergency-mode` | `Alt+Shift+E` |
| 执行 Clean private data | `clean-sensitive-data` | `Alt+Shift+C` |

macOS 的设置页会将 Chrome API 返回的 `Alt` 显示为 `Option`。用户可以在浏览器的扩展快捷键页面修改或清除快捷键。

## 4. Keywords 与匹配模型

核心匹配函数是 `tabMatchesKeywords(tab, keywords)`，定义在 `shared.js`。

等价逻辑：

```text
matched = any keyword is a substring of lower(tab.url) or lower(tab.title)
```

这会带来以下产品行为：

- `mail` 可能同时命中 `gmail.com` 和标题中带有 `Email` 的页面。
- 普通词适合 Match hit feedback、Mute、Hide 和历史/下载记录清理。
- Cookie 与站点数据清理只接受“域名型 Keyword”，例如 `example.com` 或 `localhost:3000`。
- 带路径、空格或仅为普通词的 Keyword 不能推导出安全的 origin，因此不会用于 Cookie 与站点数据清理。

Keywords 存储在 `chrome.storage.local`，不会上传到 License 服务。

## 5. Match hit feedback

Match hit feedback 有两个独立选项。

### 5.1 Replace tab icon

默认开启。扩展把命中页面的 favicon 替换成项目图标，以便用户快速识别 private tabs。

实现方式：

- 后台读取 `icons/icon-16.png` 并转换为 data URI。
- 向匹配页面注入脚本，修改或创建 `<link rel="icon">`。
- 暂存窗口中的已隐藏标签页不会执行该替换。
- 浏览器启动时会扫描当前匹配标签页并同步图标。

当前实现不会主动保存和恢复网站原 favicon。关闭该选项后，已替换的图标可能要等页面重新加载或网站重新设置 favicon 才恢复。

### 5.2 Red border flash

默认关闭。开启后：

- 用户切换到匹配标签页时，页面显示红色边框闪烁。
- 新打开且命中的活动标签页在首次加载时闪烁一次。
- 现有标签页内部的 URL、标题、前进和回退变化不会触发闪烁，避免同站浏览时反馈过于频繁。
- 单个标签页有 1.5 秒冷却时间，避免新建加载与 tab 激活事件在短时间内重复闪烁。
- 效果使用固定定位 overlay，不改变页面布局，也不接收鼠标事件。

受浏览器保护的页面无法注入脚本，因此可能没有 Match hit feedback。

## 6. Mute

Mute 主要使用页面脚本，而不是浏览器原生标签页 Mute API：

```js
document.querySelectorAll('audio, video').forEach((element) => {
  element.muted = true;
});
```

行为说明：

- 开启 Mute 时，对当前所有匹配标签页执行脚本级 Mute。
- Mute 开启期间，新建或导航后变为匹配的标签页也会自动应用 Mute。
- 关闭 Mute 时，对当前所有匹配标签页执行脚本级解除 Mute。
- 脚本只处理执行当时页面中已经存在的 `<audio>` / `<video>`；没有安装 MutationObserver 持续监听之后动态创建的媒体元素。
- 浏览器内部页、扩展商店页等禁止脚本注入的页面可能无法 Mute。

Hide 会额外使用浏览器原生的标签页 muted 状态，保证暂存窗口保持安静。这一点与独立的 Mute 实现不同。

## 7. Hide

Chrome 没有向普通扩展开放通用的原地隐藏标签页 API。本产品通过“最小化暂存窗口”实现 Hide：

1. 记录标签页 ID、原窗口 ID、原位置、URL、标题和隐藏时间。
2. 创建或复用一个最小化窗口。
3. 将匹配标签页移动到该窗口。
4. 使用浏览器原生 muted 状态将其静音。
5. 关闭 Hide 时，按记录把标签页移回原窗口和原位置。

持续行为：

- 开启 Hide 时，立即隐藏当前所有匹配标签页。
- Hide 保持开启时，新建或导航后命中的标签页会自动隐藏。
- 浏览器启动时，如果 Hide 仍为开启状态，会重新扫描并隐藏匹配标签页。

恢复与异常处理：

- 原窗口仍存在时，尽量恢复到原位置。
- 原窗口已不存在时，恢复到最近聚焦窗口。
- 恢复时会统一解除浏览器原生 muted 状态；当前记录没有保存标签页隐藏前是否原本已静音。
- 用户把标签页手动移出暂存窗口时，该标签页会从隐藏记录中移除并解除静音。
- 用户直接关闭暂存窗口时，其中的标签页会随窗口关闭，相关隐藏记录会被清除。

因此，Hide 是“移动并最小化”，不是加密、锁定、销毁或浏览器原生不可见状态。

## 8. Emergency Action

用户可以在 Settings 中选择 Emergency Action 的行为。

### 8.1 Mute and hide matching tabs

Free 和 Premium 都可用。触发时：

- 将全局 Mute 状态设为开启。
- 将持续 Hide 状态设为开启。
- 立即隐藏当前匹配标签页；之后新出现的匹配标签页也会继续 Hide。

popup 中的 Mute 和 Hide 都会显示 ON。用户将 Hide 切换为 OFF 时，暂存窗口中的标签页会恢复。

### 8.2 Close matching tabs

仅 Premium 可用。触发时直接关闭当前所有匹配标签页。

这是不可恢复的标签页关闭操作。扩展不会为这些标签页创建回收站或会话备份；能否通过浏览器的“重新打开关闭的标签页”恢复，取决于浏览器自身。

如果 Premium 状态失效但存储中仍残留该选项，后台会安全回退到 Mute and hide matching tabs；Settings 打开时也会把配置降级回默认选项。

## 9. Pause media

Pause media 仅 Premium 可用。开启后，在应用 Mute 或 Hide 时，扩展还会对当前正在播放的 `<audio>` / `<video>` 调用 `pause()`。

这是单向行为：

- Mute 关闭或标签页恢复后不会自动继续播放。
- 用户需要自行点击播放。
- 与 Mute 一样，受保护页面可能无法注入暂停脚本。

## 10. Clean private data

Clean private data 仅 Premium 可用，并且只处理与 Keywords 相关的数据。三种清理类型默认全部关闭，用户必须主动选择并授权。

### 10.1 Browsing history

- 遍历浏览历史。
- 当历史记录的 URL 或标题包含任意 Keyword 时删除该 URL 的历史记录。
- 清除历史可能减少地址栏建议，但书签或其他数据源仍可能继续产生建议。

### 10.2 Downloads history

- 遍历下载记录。
- 当下载 URL 包含任意 Keyword 时，从下载历史中擦除对应记录。
- 不删除磁盘上的实际文件。

### 10.3 Cookies & site data

- 仅使用能被安全识别为域名的 Keywords 构造 `http://` 和 `https://` origins。
- 定向移除 Cookie、Local Storage、IndexedDB、File Systems、Service Workers 和 WebSQL。
- 可能导致用户退出对应网站。
- 普通词 Keyword 不会用于此类清理。

### 10.4 不会清理的内容

- Cache：浏览器 API 无法按 origin 可靠过滤，因此产品不清理 Cache。
- 实际下载文件：只清理 Downloads history。
- 书签：不处理。
- 与 Keywords 无关的网站数据：不处理。

### 10.5 权限模型

`history`、`downloads` 和 `browsingData` 是 optional permissions，不在安装时强制请求。用户开启相应清理类型时，扩展才请求权限。

如果用户拒绝授权：

- Settings 会把对应选项恢复为关闭。
- 浏览器可能不再重复弹出授权请求。
- Chrome / Edge 用户需要从扩展管理页手动恢复权限。
- Firefox 不允许扩展直接打开 `about:addons`，因此 UI 会提示用户手动前往。

## 11. Auto cleanup

Auto cleanup 仅 Premium 可用，默认关闭，默认延迟为 5 分钟，可设置为 1–1440 分钟。

状态机如下：

1. 至少存在一个匹配标签页时，记为一次 active private session。
2. 最后一个匹配标签页关闭或不再匹配后，启动倒计时。
3. 倒计时期间如果再次出现匹配标签页，取消本次清理。
4. 到期时再次检查匹配标签页；确认没有匹配标签页后才执行 Clean private data。
5. 浏览器或 Service Worker 重启不会丢失绝对执行时间；如果重新启动时已经逾期，会重新检查并尽快执行。

启用 Auto cleanup 时会一次性请求所有三种清理权限，因为后台 alarm 没有用户手势，不能在真正清理时再弹出权限请求。

Auto cleanup 实际执行的类型仍以用户勾选的清理类型为准。如果没有选择类型、没有 Keywords、权限后来被撤销或 Premium 不再有效，本次清理不会成功执行。

## 12. Premium 与 License Key

### 12.1 Free 与 Premium 功能

| 功能 | Free | Premium |
| --- | --- | --- |
| Keywords | 最多 5 个 | 不限数量 |
| Replace tab icon | 支持 | 支持 |
| Red border flash | 支持 | 支持 |
| Mute | 支持 | 支持 |
| Hide | 支持 | 支持 |
| Emergency Action：Mute + Hide | 支持 | 支持 |
| Emergency Action：Close matching tabs | 不支持 | 支持 |
| Pause media | 不支持 | 支持 |
| Clean private data | 不支持 | 支持 |
| Auto cleanup | 不支持 | 支持 |

### 12.2 License Key 激活

License Key 格式为四组字符，例如：

```text
ABCD-2345-EFGH-6789
```

输入时会自动转为大写；如果清理后正好有 16 个字母或数字，会自动重新分组为 `4-4-4-4`。

激活流程：

1. 根据操作系统、CPU 架构、逻辑核心数、设备内存、屏幕尺寸和色深生成确定性的 SHA-256 设备 fingerprint。
2. 向 Licentra 的 `/api/license/activate` 发送 License Key、fingerprint 和设备标签。
3. 使用扩展内置的 ECDSA P-256 公钥验证服务端签名。
4. 只有 product、有效期和签名全部通过后，才把 License 状态写入本地存储。

### 12.3 Check-in 与离线宽限

- 每次 Service Worker 启动（包括扩展重新启用）都会先读取本地 License，并在需要时立即 check-in；并发的启动事件会复用同一个初始化任务。
- Settings 和 popup 会在渲染或降级 Premium 功能前等待后台完成该初始化，避免重新启用时短暂或持续误判为 Free。
- 后台每 12 小时建立一次 check-in alarm。
- 签名有效期剩余超过 12 小时时不会重复请求。
- 网络故障、服务器错误、限流或非 JSON 响应会进入离线宽限，而不会立即关闭 Premium。
- 每次失败最多把临时有效期延长 30 分钟。
- 离线宽限上限是最后一次成功验证后的 48 小时。
- 撤销、退款、License Key 不存在、订阅到期或设备被移除等明确拒绝不会获得离线宽限。
- 订阅本身的到期时间不能被离线宽限延长。

License 服务使用 `https://licentra.henri.ren`。Keywords、标签页列表和浏览历史不会发送到该服务。

## 13. 数据与隐私边界

### 13.1 本地保存的数据

扩展使用 `chrome.storage.local` 保存：

- Keywords。
- Mute 与 Hide 状态。
- 隐藏标签页恢复记录。
- 语言偏好。
- Emergency Action 选项。
- Pause media 与 Match hit feedback 选项。
- Clean private data 类型与 Auto cleanup 状态。
- 已验证的 License 状态。

### 13.2 网络通信

当前代码中明确的外部通信仅用于 License Key 激活和 check-in。页面脚本不会把 Keywords、private tabs 或清理内容上传到 License 服务。

扩展还通过浏览器的卸载回调注册了 `https://stealthba.henri.ren/goodbye`。用户卸载扩展后，浏览器会打开该 goodbye 页面；扩展本身不会在卸载后继续运行或向页面主动传递本地数据。

Settings 的 Send Feedback 会打开官网 Contact 页面。Leave Review 会识别当前浏览器并分别打开 Chrome Web Store、Microsoft Edge Add-ons 或 Firefox Add-ons 的对应评价页面。所有从 Settings 发出的官网、Contact 和商店链接都会附加 `utm_source=settings_page`；这些动作只打开新标签页，不会主动附加 Keywords、private tabs 或其他本地数据。

### 13.3 访问范围

为了在任意普通网页中执行 Mute、Pause media、Red border flash 和 Replace tab icon，manifest 声明了 `*://*/*` host permissions，并使用 `scripting` 权限注入代码。

该权限不代表所有页面都可操作。浏览器内部页、扩展页面、商店页以及其他受保护页面通常会拒绝脚本注入。

## 14. Settings 页面逐项说明

Settings 当前按以下结构组织：

1. Keywords：添加、查看、删除 Keywords，并显示 Free 上限或 Premium 无限数量。
2. Shortcuts：显示浏览器实际绑定的四个快捷键，并提供管理入口或 Firefox 手动路径提示。
3. Match hit feedback：配置 Replace tab icon 和 Red border flash。
4. Emergency Action：选择 Mute + Hide 或 Close matching tabs。
5. When mute or hide tabs：配置 Pause media。
6. Clean private data：选择 Browsing history、Downloads history、Cookies & site data。
7. Auto cleanup：开启自动清理并设置延迟。
8. Language：跟随浏览器或手动选择语言。
9. Support：通过紧凑的两行入口前往 Chrome Web Store 执行 Leave Review，或通过 Contact 页面执行 Send Feedback。
10. Premium：了解 Premium 或输入 License Key 激活。

当前支持语言：English、简体中文、Español、Deutsch、日本語、Français、Português (Brasil)、한국어。

## 15. 面向 AI Agent 的工程地图

### 15.1 文件职责

| 文件 | 职责 |
| --- | --- |
| `manifest.json` | Chrome / Edge Manifest V3、权限、入口、快捷键、版本号 |
| `manifest.firefox.json` | Firefox manifest 变体与 Gecko 配置 |
| `background.js` | Service Worker；匹配、Mute、Hide、反馈、Emergency Action、清理、alarm、消息桥、工具栏图标 |
| `shared.js` | storage schema、默认值、匹配函数、权限帮助、本地化、Premium 缓存与 Keywords 上限 |
| `config.js` | 官网 origin、Settings UTM、商店评价页以及 Premium、Contact、卸载页面等 URL 的唯一代码配置入口 |
| `license.js` | License Key 标准化、设备 fingerprint、Licentra 请求、签名验证、check-in 与离线宽限 |
| `popup.html` / `popup.js` | 弹窗结构、状态展示、Mute / Hide 切换、一次性 Clean private data |
| `options.html` / `options.js` | Settings、Keywords、快捷键、Premium gating、权限请求、License Key 激活 |
| `styles.css` | 弹窗与 Settings 样式、Premium 锁定状态、响应式布局 |
| `_locales/<locale>/messages.json` | manifest 原生 i18n 与 `__MSG_*__` 文案 |
| `_locales/<locale>/messages.js` | UI 与 Service Worker 可导入的本地化镜像 |
| `package.sh` | 白名单式生成 Chrome / Edge 和 Firefox 商店 ZIP |

### 15.2 核心状态

| storage key | 默认值 | 含义 |
| --- | --- | --- |
| `keywords` | `[]` | Keywords 列表 |
| `hiddenTabs` | `[]` | 暂存标签页恢复记录 |
| `scriptMute` | `false` | Mute 是否开启 |
| `hideMode` | `false` | 持续 Hide 是否开启 |
| `langPref` | `""` | 空值跟随浏览器，否则为 locale code |
| `emergencyAction` | `"muteHide"` | `muteHide` 或 `closeMatchTabs` |
| `pauseOnMuteHide` | `false` | 是否启用 Pause media |
| `redBorderFlash` | `false` | 是否启用红色边框反馈 |
| `tabIconOverride` | `true` | 是否启用 Replace tab icon |
| `cleanupTypes` | 全部 `false` | history / cookies / downloads |
| `autoCleanup` | 关闭、5 分钟 | Auto cleanup 状态机持久化数据 |
| `license` | `null` | 已验证 License 状态 |

`getState()` 会把默认值和已存储数据合并。新增 storage key 时必须同时更新 `STORAGE_KEYS` 与 `DEFAULTS`。

### 15.3 事件流

```text
tab created / updated
  → 获取 Keywords
  → URL/title 子字符串匹配
  → 根据状态应用 Mute、Hide、Replace tab icon
  → 活动标签页按需触发 Red border flash
  → 重新评估 Auto cleanup private session

tab removed
  → 清理 hiddenTabs 记录
  → 重新评估 Auto cleanup private session

popup
  → runtime message
  → background.js 修改状态或执行清理
  → popup 再读取 status

keyboard command
  → background.js 直接执行对应动作
```

### 15.4 Popup 与 Service Worker 消息协议

| message type | 输入 | 返回 |
| --- | --- | --- |
| `status` | 无 | `scriptMute`、`hideMode`、`matching`、`hidden` |
| `set-mute-mode` | `on: boolean` | `{ ok: true }` |
| `set-hide-mode` | `on: boolean` | `{ ok: true }` |
| `run-cleanup` | 无 | `{ ok: true }` 或 reason |
| `refresh-license-state` | 无 | 等待去重后的 License 初始化，返回当前 `premium` 状态 |

未知 message 返回 `{ ok: false, error: "unknown message" }`。

### 15.5 Premium gating 原则

Premium gating 必须同时存在于两个层面：

1. UI 层：禁用控件、显示锁定状态和 Premium 引导。
2. 执行层：后台再次调用 `isPremium()`，不能信任 UI 或 storage 中的旧配置。

新增 Premium 功能时不得只做 CSS 或 Settings 控件禁用。

### 15.6 本地化规则

每个 locale 必须同时维护：

```text
_locales/<locale>/messages.json
_locales/<locale>/messages.js
```

两份文件中的 message key 和内容必须一致。原因：

- `messages.json` 供 manifest 的 `__MSG_*__` 使用。
- `messages.js` 供 ES module 直接导入，支持 Settings 中即时切换语言。

新增 locale 时还要更新 `shared.js` 中的 imports、`MESSAGES`、`SUPPORTED_LOCALES`，以及 `options.html` 的语言选项。

所有翻译必须遵守第 1 节 Canonical terminology。不得为了语言多样性在同一语言中交替使用多个术语。

## 16. AI Agent 修改规则

AI Agent 在修改本项目时必须遵守以下约束：

1. 先以代码行为为事实来源，再更新文档和文案；不要只依据旧 README 或注释。
2. 不得改写 Canonical terminology，尤其是 `License Key`、`Emergency Action`、`private`、`Keywords`、`Match hit feedback`、`Clean private data`、`Auto cleanup`、`Premium`、`Support`、`Leave Review` 和 `Send Feedback`。
3. 修改本地化文案时同步更新 `.json` 与 `.js`。
4. 修改版本号时同步更新 `manifest.json` 与 `manifest.firefox.json`。
5. 新增运行时文件时同步加入 `package.sh` 的 `FILES` 白名单，否则发布 ZIP 不会包含该文件。
6. 新增清理类型时同步考虑 optional permission、Settings 用户手势授权、后台无用户手势限制、Premium gating 和定向清理范围。
7. 修改 Hide 时不得假设存在公开的 `chrome.tabs.hide`；当前设计依赖暂存窗口和恢复记录。
8. 修改 Mute 时区分脚本级媒体 muted 与 Hide 使用的浏览器原生标签页 muted。
9. Emergency Action 的 Mute + Hide 必须同时开启 `scriptMute` 和 `hideMode`，确保 popup 状态与实际隐藏状态一致，并允许用户通过关闭 Hide 恢复标签页。
10. 任何 destructive 行为都必须在 UI 和文档中明确，例如 Close matching tabs、Cookies & site data 清理。
11. 不得扩大网络数据范围；License 请求不应携带 Keywords、标签页或浏览历史。
12. 不得把 Free 限制只放在 Settings；执行逻辑需要防止旧状态或手动写入绕过 Premium gating。
13. 官网域名只能在 `config.js` 的 `WEBSITE_ORIGIN` 中维护；其他代码必须导入派生 URL，不得再次硬编码域名。修改域名或页面路径后还要同步更新本文档中的用户可见链接。

## 17. 发布与打包

`package.sh` 不会自动修改版本号。发布前必须手动同步：

```json
// manifest.json
"version": "x.y.z"

// manifest.firefox.json
"version": "x.y.z"
```

命令：

```bash
./package.sh             # Chrome / Edge
./package.sh --firefox   # Firefox
./package.sh --all       # 两种包
./package.sh --list      # 查看白名单
./package.sh --check     # 校验已有 Chrome / Edge ZIP
```

产物：

```text
dist/sba-<version>.zip
dist/sba-<version>-firefox.zip
```

脚本使用白名单打包，并检查 `manifest.json` 是否位于 ZIP 根目录、是否包含白名单路径以及是否混入 `__MACOSX`。

## 18. 当前实现的已知注意点

以下不是宣传语，而是维护和排查问题时必须知道的代码事实：

1. 当前 `manifest.json` 是 `1.0.1`，`manifest.firefox.json` 是 `1.0.0`，发布前需要同步。
2. `background.js` 顶部旧注释曾写“新匹配标签页不会自动 Mute”，但实际事件处理会执行 `enforceScriptMuteOnTab()`；应以实际代码为准。
3. Replace tab icon 没有保存原 favicon，也没有在关闭设置时主动恢复。
4. Hide 恢复时统一解除原生 muted，没有记录隐藏前的原始静音状态。
5. Mute 和 Pause media 只处理注入时已经存在的媒体元素。
6. 普通词 Keywords 无法用于 Cookies & site data 的 origin 定向清理。
7. Settings 启用 Auto cleanup 时会请求所有清理权限，而不只是当前已勾选的类型。

## 19. 建议的回归检查清单

### Keywords

- Free 第 5 个可添加，第 6 个被阻止。
- Premium 显示 `∞` 并允许继续添加。
- URL 和标题均可命中，匹配不区分大小写。
- 删除 Keyword 后 Auto cleanup 状态会重新评估。

### Match hit feedback

- 默认 Replace tab icon 开启。
- 新建、导航和浏览器启动后的匹配标签页都能替换图标。
- Red border flash 只在当前活动匹配标签页出现。
- 受保护页面失败时不影响 Service Worker。

### Mute / Hide / Emergency Action

- 当前匹配标签页立即处理。
- 模式开启后新出现的匹配标签页按预期处理。
- Hide 关闭后尽量恢复原窗口和位置。
- 手动移出或关闭暂存窗口后隐藏记录正确清理。
- Free 下 Close matching tabs 必须回退到 Mute + Hide。

### Clean private data / Auto cleanup

- 未授权时不执行并给出可理解提示。
- Downloads history 清理不删除实际文件。
- Cookies & site data 只处理域名型 Keywords。
- 倒计时期间重新出现匹配标签页会取消 Auto cleanup。
- 重启后逾期任务会重新检查再执行。

### License Key / Premium

- 无效格式不会发起激活请求。
- 服务端签名错误不会写入本地 License 状态。
- 明确撤销或退款会清除 License 状态。
- 网络错误进入离线宽限，超过 48 小时后锁定 Premium。
- Premium 失效后 Settings 和后台都能降级受限功能。

### 发布

- 两份 manifest 版本一致。
- 所有 locale 的 `.json` / `.js` 同步。
- `./package.sh --all` 成功。
- ZIP 根目录存在 `manifest.json`，且没有开发文件或 `.DS_Store`。

---

本文档描述的是当前代码的真实行为。若实现发生变化，提交代码时应同步更新本文档，并继续遵守 Canonical terminology。
