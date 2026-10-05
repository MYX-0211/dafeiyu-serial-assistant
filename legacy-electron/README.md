<div align="center">

<img src="build/icon-256.png" width="120" alt="大肥鱼串口助手">

# 大肥鱼串口助手

**串口 / TCP / UDP 调试工具 · 白色毛玻璃界面 · 中英双语**

[![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white)](#)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](#许可--license)
[![Author](https://img.shields.io/badge/Author-MYX-blue)](https://github.com/MYX-0211)

免安装单文件 exe，双击即用。

</div>

---

## 这是什么

一个用 Electron + [`serialport`](https://github.com/serialport/node-serialport) 写的串口调试工具。
布局与功能对照经典的 **SSCOM**，视觉换成了白色毛玻璃，并补齐了原工具没有的细节（自动刷新端口、GBK 解码、按键即发等）。

**没有前端框架、没有第三方 UI 库** —— 界面就是三个文件：`index.html` / `style.css` / `app.js`。

## 功能

**连接方式**

| 模式 | 参数 | 说明 |
| :--- | :--- | :--- |
| **串口** | 波特率 / 数据位 / 停止位 / 校验位 / 流控 / DTR / RTS | 端口自动枚举，**插拔设备自动刷新** |
| **TCP Client** | 远程 IP + 端口 | 连到远端服务器或透传模块 |
| **TCP Server** | 本地网卡 + 端口 | 本机监听，客户端接入 / 断开会在接收区提示 |
| **UDP** | 远程 IP/端口 + 本地网卡/端口 | 本地端口填 0 表示自动分配 |

> 「本地」是个下拉框，列出本机每张网卡的 IPv4。**默认「全部网卡」，不会因地址不存在而启动失败。**

**接收**

- HEX 显示 / 时间戳 / 显示发送 / 自动换行
- 分包显示 + 可调超时（默认 20 ms）
- **UTF-8 / GBK 编码切换** —— Keil 工程里的中文就选 GBK
- 暂停 / 清空 / 保存为 txt
- 智能跟随：滚动条在底部才自动滚，往上翻看历史不会被打断

**发送**

- HEX / ASCII 模式，HEX 支持空格、逗号、`0x` 前缀
- 发送新行（CRLF / LF / CR）
- 定时发送
- 追加校验：Modbus CRC16 / CRC16-CCITT / 累加和 ADD8 / 异或 XOR8
- **按键即发** —— 敲一个字符立刻发出，适合和设备做终端交互
- **回车发送** —— 输入框里按 Enter 直接发出整行
- 发送文件（256 字节分包），也支持拖文件到窗口

**多条字符串发送**

- 不限条数，每条独立切换 ASC / HEX
- 全部发送 / 按间隔循环发送
- 内容自动保存，下次打开还在

**工具**

- 校验计算器（CRC16 / CRC16-CCITT / ADD8 / XOR8）
- 中英文界面切换（默认中文）

## 快速开始

1. 从 [Releases](../../releases) 下载 `DaFeiYu-Serial-Assistant-1.0.0-portable.exe`
2. 双击运行 —— 免安装，不需要任何运行环境
3. 首次启动会解压到临时目录，**等 10–30 秒**，之后再开就是秒开
4. 顶部下拉框选模式，点「打开 / 连接 / 侦听」

窗口位置、大小、多条字符串、网络参数、语言选择都会记住。

## 快捷键

| 按键 | 作用 |
| :--- | :--- |
| `Ctrl + Enter` | 发送当前内容 |
| `Ctrl + K` | 清空接收区 |
| `Ctrl + Shift + L` | 清空发送框 |
| `Ctrl + 鼠标滚轮` | 调整接收区字号 |
| `Esc` | 关闭弹窗，停止定时 / 循环发送 |
| 拖文件到窗口 | 按 256 字节分包发送 |

## 界面

<div align="center">
<img src="screenshots/01-main.png" width="720" alt="主界面">
</div>

## 从源码构建

```bash
git clone https://github.com/MYX-0211/dafeiyu-serial-assistant.git
cd dafeiyu-serial-assistant
npm install          # 首次会下载 Electron 运行时（约 100 MB）
npm start            # 开发模式
npm run dist         # 打包成便携版 exe
```

**工程结构**

```
├─ build/                   应用图标（ico + png）
├─ src/
│  ├─ main.js               主进程：窗口 + 四种链路的驱动 + IPC
│  ├─ preload.js            contextBridge 安全桥
│  └─ renderer/
│     ├─ index.html         界面结构（文案带 data-i18n 标记）
│     ├─ style.css          样式
│     ├─ i18n.js            中英文字典 + 语言切换
│     ├─ app.js             收发 / 多条字符串 / 校验 / 交互
│     └─ assets/            背景图与应用图标
├─ test/shot.js             开发用截图与自检脚本（不参与打包）
└─ package.json             electron-builder 配置
```

**技术要点**

- 串口走 `serialport`（N-API 预编译，无需编译工具链），网络走 Node 内置 `net` / `dgram`
- 主进程把四种链路统一成 `open / close / write / onData` 四个动作，渲染层不关心底层是哪一种
- 界面文案用 `data-i18n` 标记 + `t('key')`，静态与动态文案都走同一套字典
- 异步操作一律用 `try / finally` 保证状态复位 —— 任何一个异常都不该把界面卡在「处理中」

## 关于体积

打包后约 **89 MB**。这是 Electron 的技术下限（Chromium 内核本身占绝大部分），不是打包配置问题。
业务代码只有约 200 KB。想更小只能换 Tauri（8–15 MB，需要 Rust）或系统 WebView2 方案。

## 许可 / License

MIT License · 作者 **MYX** · [github.com/MYX-0211](https://github.com/MYX-0211)

---

<div align="center">

### English

</div>

## What is this

A serial port debugging tool built with Electron + [`serialport`](https://github.com/serialport/node-serialport).
The layout mirrors the classic **SSCOM**, the look is a soft white-glass UI, plus a few things SSCOM lacks
(auto port refresh, GBK decoding, send-on-keypress).

**No frontend framework, no UI library** — the whole interface is three files:
`index.html` / `style.css` / `app.js`.

## Features

**Connection modes**

| Mode | Parameters | Notes |
| :--- | :--- | :--- |
| **Serial** | baud / data bits / stop bits / parity / flow control / DTR / RTS | Ports auto-enumerate and **refresh on plug/unplug** |
| **TCP Client** | remote IP + port | Connect out to a server or a transparent bridge |
| **TCP Server** | local NIC + port | Listen locally; client connect/disconnect is reported inline |
| **UDP** | remote IP/port + local NIC/port | Local port `0` means auto-assign |

> "Local" is a dropdown listing every IPv4 on this machine. It defaults to **All interfaces**, so it never
> fails with an unavailable-address error.

**Receive**

- HEX view / timestamp / echo sent data / auto wrap
- Packet splitting with adjustable gap timeout (20 ms default)
- **UTF-8 / GBK switch** — pick GBK for strings coming out of Keil projects
- Pause / clear / save as txt
- Smart follow: auto-scrolls only when you are already at the bottom

**Send**

- HEX / ASCII; hex accepts spaces, commas and `0x` prefixes
- Append newline (CRLF / LF / CR)
- Timed send
- Append checksum: Modbus CRC16 / CRC16-CCITT / ADD8 / XOR8
- **Send on keypress** — every character goes out immediately, great for terminal-style interaction
- **Send on Enter** — press Enter to send the whole line
- Send file in 256-byte chunks, or drop a file onto the window

**Quick send list**

- Unlimited entries, each toggles between ASC / HEX independently
- Send all, or loop on an interval
- Contents persist between sessions

**Tools**

- Checksum calculator (CRC16 / CRC16-CCITT / ADD8 / XOR8)
- Chinese / English UI switch (Chinese by default)

## Quick start

1. Download `DaFeiYu-Serial-Assistant-1.0.0-portable.exe` from [Releases](../../releases)
2. Double-click — portable, no runtime to install
3. First launch extracts to a temp folder and takes **10–30 s**; later launches are instant
4. Pick a mode from the dropdown, then hit **Open / Connect / Listen**

Window geometry, quick-send entries, network settings and language are all remembered.

## Shortcuts

| Key | Action |
| :--- | :--- |
| `Ctrl + Enter` | Send current content |
| `Ctrl + K` | Clear receive area |
| `Ctrl + Shift + L` | Clear send box |
| `Ctrl + wheel` | Adjust receive font size |
| `Esc` | Close dialogs, stop timed / loop sending |
| Drop a file on the window | Send it in 256-byte chunks |

## Build from source

```bash
git clone https://github.com/MYX-0211/dafeiyu-serial-assistant.git
cd dafeiyu-serial-assistant
npm install          # downloads the Electron runtime (~100 MB) on first run
npm start            # dev mode
npm run dist         # build the portable exe
```

## Size

About **89 MB** packaged. That is the floor for Electron (the Chromium runtime dominates it) — not a
packaging-configuration problem. The application code itself is roughly 200 KB. Going smaller means
switching to Tauri (8–15 MB, needs Rust) or a system WebView2 approach.

## License

MIT License · Author **MYX** · [github.com/MYX-0211](https://github.com/MYX-0211)
