# Stealth Browser Assistant · 隐私浏览助手

> Private browsing assistant for sensitive tabs.
> Instantly mute, hide and manage private browser tabs with keyboard shortcuts.

一个 Chrome (MV3) 浏览器扩展，帮你静音和隐藏那些"不想被人瞥见"的标签页。

## 功能

- **自定义关键词列表** — 添加域名或任意词（如 `bank.com`、`salary`）。标签页的网址或标题中包含任一关键词即视为匹配（不区分大小写）。
- **静音模式（开/关）** — 开启后，所有匹配的标签页内的 `<audio>` / `<video>` 元素被静音，**之后新开或导航到匹配网址的标签页也会自动静音**；关闭后注入解静音脚本。采用页面内脚本注入方式，不碰 Chrome 原生静音 API，用户仍可随时用右键 `Mute site` / `Unmute site` 操作单个标签页。
- **隐藏模式（开/关）** — 开启后，所有匹配的标签页被移入一个最小化的"暂存窗口"并静音，**之后新开或导航到匹配网址的标签页也会自动隐藏**；关闭时全部还原到原位置。

### 紧急模式

一键同时开启静音和隐藏，适用于"赶紧遮住"的突发场景：

| 操作         | 默认快捷键    | 命令             |
| ------------ | ------------- | ---------------- |
| 切换静音模式 | `Alt+Shift+M` | `toggle-mute`    |
| 切换隐藏模式 | `Alt+Shift+H` | `toggle-hide`    |
| 紧急动作     | `Alt+Shift+E` | `emergency-mode` |

快捷键可在 `chrome://extensions/shortcuts` 中自定义（扩展设置页也有直达链接）。

## 关于"隐藏标签页"

Chrome 没有公开的"原地隐藏标签页" API（`chrome.tabs.hide` 仅对企业策略扩展开放）。本扩展的"隐藏"实现方式是：把匹配的标签页移动到一个最小化的独立窗口里，并记录其原始窗口与位置，恢复时原样还原。隐藏的同时会一并静音，避免标签页继续播放音频。

## 关于"静音"

Chrome 扩展 API 中的 `chrome.tabs.update({ muted: true })` 会锁定标签页的静音状态，导致用户之后无法通过右键 `Mute site / Unmute site` 操作该标签页。本扩展的静音实现不碰 Chrome 原生静音 API，而是通过 `chrome.scripting.executeScript` 注入脚本到页面内，直接控制 `<audio>` 和 `<video>` 元素的 `muted` 属性。这样用户可以随时通过 Chrome 右键菜单自由控制每个标签页的静音状态。

## 安装（开发模式）

1. 打开 `chrome://extensions`
2. 右上角开启"开发者模式"
3. 点击"加载已解压的扩展程序"，选择本目录
4. 扩展程序图标出现后，点击图标即可使用弹窗；底部"设置"链接可管理关键词并查看快捷键。

## 目录结构

```
manifest.json                 MV3 清单
background.js                 Service worker：命令处理 + 暂存窗口管理 + 脚本注入
shared.js                     共享：存储键 / 关键词匹配 / 国际化
popup.html / popup.js         工具栏弹窗（静音 & 隐藏开关）
options.html / options.js     设置页（关键词管理、快捷说明、语言切换）
styles.css                    共享样式（含深色模式）
_locales/
  en/messages.json            英文文案（Chrome 原生 i18n）
  en/messages.js              英文文案（ES module 镜像，供 SW 导入使用）
  zh_CN/messages.json         中文文案（Chrome 原生 i18n）
  zh_CN/messages.js           中文文案（ES module 镜像，供 SW 导入使用）
icons/
  icon-{16,32,48,128,192}.png 默认图标
  mute-{16,32,48,128}.png     静音模式图标
  hide-{16,32,48,128}.png     隐藏模式图标
```

## 打包发布

`package.sh` 会读取 `manifest.json` 中的版本号并生成对应名称的 ZIP，但不会自动修改版本号。每次发布前需要先手动更新版本：

- Chrome / Edge：修改 `manifest.json` 中的 `version`
- Firefox：同步修改 `manifest.firefox.json` 中的 `version`

两份 manifest 的版本号应保持一致。例如发布 `1.0.1` 时，将两处都改为：

```json
"version": "1.0.1"
```

打包 Chrome / Edge（包括 CWS 上传包）：

```bash
./package.sh
```

产物为 `dist/sba-1.0.1.zip`。

同时打包 Chrome / Edge 和 Firefox：

```bash
./package.sh --all
```

产物为：

```text
dist/sba-1.0.1.zip
dist/sba-1.0.1-firefox.zip
```

其他可用命令：

```bash
./package.sh --firefox  # 仅打包 Firefox
./package.sh --list     # 查看将被打包的文件
./package.sh --check    # 检查已生成的 Chrome / Edge ZIP
```

## 本地化

界面根据浏览器语言自动在英文与简体中文之间切换，可在设置页手动选择。新增语言：在 `_locales/<lang>/` 目录下同时创建 `messages.json`（Chrome 原生 i18n）和 `messages.js`（ES module 镜像）即可。注意两个文件需保持同步。

## License

Copyright (c) 2026. All rights reserved.

本软件的源代码仅供版权所有者使用。未经版权所有者明确书面许可，任何人不得以任何形式复制、修改、分发、出售或基于本软件创作衍生作品。保留所有权利。
