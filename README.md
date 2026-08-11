# Stealth Tabs · 隐私标签页助手

> Private browsing assistant for sensitive tabs.
> Instantly mute, hide and manage private browser tabs with keyboard shortcuts.

一个 Chrome (MV3) 浏览器扩展,帮你持续静音、隐藏和管理那些"不想被人瞥见"的标签页。

## 功能

- **自定义关键词列表** — 添加域名或任意词(如 `bank.com`、`工资单`)。只要标签页的网址或标题中包含任一关键词即视为匹配(不区分大小写)。
- **静音模式(开/关)** — 开启后,所有匹配的标签页被静音,**之后新打开或导航到匹配网址的标签页也会自动静音**;关闭时恢复。
- **隐藏模式(开/关)** — 开启后,所有匹配的标签页被移入一个最小化的"暂存窗口"并静音,**之后新打开或导航到匹配网址的标签页也会自动隐藏**;关闭时全部还原到原位置。
- **键盘快捷键** — 两个模式各一个快捷键,按下即切换开/关。

| 操作 | 默认快捷键 | 命令 |
|---|---|---|
| 切换静音模式 | `Alt+Shift+M` | `toggle-mute` |
| 切换隐藏模式 | `Alt+Shift+H` | `toggle-hide` |

快捷键可在 `chrome://extensions/shortcuts` 中自定义。

## 安装(开发模式)

1. 打开 `chrome://extensions`
2. 右上角开启"开发者模式"
3. 点击"加载已解压的扩展程序",选择本目录
4. 扩展程序图标出现后,点击图标即可使用弹窗;右键图标 → "选项"可管理关键词并查看快捷键。

## 关于"隐藏标签页"

Chrome 没有公开的"原地隐藏标签页" API(`chrome.tabs.hide` 仅对企业策略扩展开放)。本扩展的"隐藏"实现方式是:把匹配的标签页移动到一个最小化的独立窗口里,并记录其原始窗口与位置,恢复时原样还原。隐藏的同时会一并静音,避免标签页继续播放音频。

## 目录结构

```
manifest.json          MV3 清单
background.js          Service worker:命令处理 + 暂存窗口管理
shared.js              共享:存储键 / 关键词匹配 / 国际化
popup.html / popup.js  工具栏弹窗
options.html / options.js  选项页(关键词管理 · 快捷键说明)
styles.css             共享样式(含深色模式)
_locales/en/messages.json
_locales/zh_CN/messages.json
```

## 本地化

界面根据浏览器语言自动在英文与简体中文之间切换。新增语言:在 `_locales/<lang>/messages.json` 复制一份并翻译即可。

## License

MIT