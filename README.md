<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="120" alt="大肥鱼串口助手">

# 大肥鱼串口助手

**串口 / TCP / UDP 调试工具 · Rust + Tauri · 白色毛玻璃界面 · 中英双语**

[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-1.99-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![Size](https://img.shields.io/badge/Size-3.9%20MB-brightgreen)](#体积与内存)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white)](#)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](#许可--license)
[![Author](https://img.shields.io/badge/Author-MYX-blue)](https://github.com/MYX-0211)

单文件 exe，**3.9 MB**，双击即用。

</div>

---

## 体积与内存

这个项目最初用 Electron 写，功能跑通后体积 89 MB、内存 344 MB。
后来用 **Rust + Tauri 重写了后端**（前端基本原样复用），结果：

| 指标 | Electron 版 | **Tauri 版** | 改善 |
| :--- | ---: | ---: | ---: |
| exe 体积 | 89.2 MB | **3.9 MB** | **↓ 23 倍** |
| 进程数 | 4 | **1** | — |
| 内存占用 | 344 MB | **35 MB** | **↓ 10 倍** |
| 冷启动 | ~2 s | **~0.4 s** | **↓ 5 倍** |

**为什么能小这么多**：Electron 把整个 Chromium 打进安装包；Tauri 直接调用**系统自带的 WebView2** 渲染界面，
exe 里只剩 Rust 编译出来的业务逻辑。同样的界面代码，一个 89 MB 一个 3.9 MB。

> 代价：Windows 10/11 需要 WebView2 运行时（Win11 和打过补丁的 Win10 都自带；
> 极老的系统需要单独装一次）。

## 功能

**连接方式**

| 模式 | 参数 | 说明 |
| :--- | :--- | :--- |
| **串口** | 波特率 / 数据位 / 停止位 / 校验位 / 流控 / DTR / RTS | 端口自动枚举，插拔设备自动刷新 |
| **TCP Client** | 远程 IP + 端口 | 连到远端服务器或透传模块 |
| **TCP Server** | 本地网卡 + 端口 | 本机监听，客户端接入 / 断开会在接收区提示 |
| **UDP** | 远程 IP/端口 + 本地网卡/端口 | 本地端口填 0 表示自动分配 |

> 「本地」是个下拉框，列出本机每张网卡的 IPv4。默认「全部网卡」，不会因地址不存在而启动失败。

**接收**：HEX / 时间戳 / 显示发送 / 自动换行 / 分包显示 + 超时 / **UTF-8·GBK 编码切换** / 暂停 / 清空 / 保存

**长时记录**（v2.1 新增）：数据在 Rust 侧**直接写盘、不经过界面** —— 跑一整天内存也不涨。
可设保存目录、文件名前缀、**分文件大小**（写满自动开下一个）、**每行前加本地时间戳**。
状态栏会实时显示当前文件名和已写字节。

**曲线**（v2.1 新增）：接收区可切「文本 / 曲线」视图，自动从每行提取  画曲线（最多 6 条）。
切到曲线视图时文本不再堆 DOM，两边不会同时吃内存。

**发送**：HEX·ASCII / 新行 CRLF·LF·CR / 定时发送 / 追加校验（CRC16·CCITT·ADD8·XOR8）/
**按键即发** / **回车发送** / 发送文件（256 字节分包）/ 拖文件到窗口

**多条字符串**：不限条数，每条独立 ASC·HEX，全部发送 / 循环发送，内容自动保存

**工具**：校验计算器；中英文一键切换（默认中文）

## 快速开始

1. 从 [Releases](../../releases) 下载 `DaFeiYu-Serial-Assistant-2.0.0-portable.exe`
2. 双击运行 —— **真的免安装**，不需要解压、不需要等
3. 顶部下拉框选模式，点「打开 / 连接 / 侦听」

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
<img src="screenshots/01-main.png" width="760" alt="主界面">
</div>

## 从源码构建

前置：**Rust 工具链**（`rustup`）、**MSVC 链接器**（VS Build Tools）、**WebView2 运行时**。

```bash
git clone https://github.com/MYX-0211/dafeiyu-serial-assistant.git
cd dafeiyu-serial-assistant/src-tauri

cargo test --release        # 跑单元测试（9 个）
cargo build --release       # 产物：target/release/dafeiyu-serial-assistant.exe
```

想要安装包（而不是绿色版）：

```bash
cargo install tauri-cli --locked
cargo tauri build           # 产出 NSIS 安装包
```

**工程结构**

```
├─ src/                        前端（与 Electron 版共用同一套界面代码）
│  ├─ index.html               界面结构（文案带 data-i18n 标记）
│  ├─ style.css                白色毛玻璃样式
│  ├─ i18n.js                  中英文字典 + 语言切换
│  ├─ app.js                   收发 / 多条字符串 / 校验 / 交互
│  ├─ tauri-bridge.js          ★ 桥接层：把 Tauri API 包装成统一的 window.native
│  └─ assets/                  背景图、应用图标
├─ src-tauri/                  Rust 后端
│  ├─ src/lib.rs               四种链路的实现 + IPC 命令 + 单元测试
│  ├─ src/main.rs              入口
│  ├─ Cargo.toml               依赖与体积优化（opt-level="s" + LTO + strip）
│  ├─ tauri.conf.json          窗口 / 打包 / 权限配置
│  └─ icons/                   多尺寸图标
└─ legacy-electron/            Electron 版归档（保留作对比，不再维护）
```

**技术要点**

- **链路抽象**：四种模式统一成 `open / close / write` 三个命令 + 一个 `link:data` 事件上行。
  前端完全不关心底层是串口还是 socket
- **桥接层设计**：`tauri-bridge.js` 把 `invoke` / `listen` 包装成和 Electron preload 一模一样的
  `window.native` 接口 —— 所以从 Electron 迁移过来时，**业务代码一行没改**
- **读线程模型**：每个链路起一个读线程，用 `Arc<AtomicBool>` 控制退出，
  数据通过 `app.emit("link:data", bytes)` 推给前端
- **错误码转人话**：Windows 的 socket 错误（`os error 10049` 之类）会映射成标准码再翻译成中文提示，
  比如 `EADDRNOTAVAIL` 会直接告诉用户「改成全部网卡」
- **异步状态复位**：前端所有 `await` 后跟状态复位的地方都放在 `finally` 里 ——
  任何一个异常都不该把界面卡在「处理中」

## 体积优化清单

Rust 侧（`Cargo.toml`）：

```toml
[profile.release]
opt-level = "s"      # 优先体积
lto = true           # 链接时优化
codegen-units = 1    # 更大的优化范围
panic = "abort"      # 去掉 unwind 表
strip = true         # 去掉符号
```

加上 `lib.rs` 里手动实现二进制解析、不用重型依赖，最终 3.9 MB。

## 许可 / License

MIT License · 作者 **MYX** · [github.com/MYX-0211](https://github.com/MYX-0211)

---

<div align="center">

### English

</div>

## Why Tauri

This started as an Electron app: 89 MB exe, 344 MB RAM. After rewriting the backend in
**Rust + Tauri** (the frontend carried over almost unchanged):

| | Electron | **Tauri** |
| :--- | ---: | ---: |
| exe size | 89.2 MB | **3.9 MB** |
| Processes | 4 | **1** |
| RAM | 344 MB | **35 MB** |

Electron ships an entire Chromium; Tauri uses the **system WebView2** for rendering, so the
binary only contains the Rust business logic.

> Trade-off: needs the WebView2 runtime, which ships with Windows 11 and patched Windows 10.

## Features

**Connection** — Serial (baud / data bits / stop bits / parity / flow control / DTR / RTS,
auto-enumerated ports with hot-plug refresh) · TCP Client · TCP Server (local NIC + port) · UDP.
The "Local" field is a dropdown of every IPv4 on the machine, defaulting to **All interfaces**.

**Receive** — HEX, timestamp, echo, auto-wrap, packet splitting with gap timeout,
**UTF-8 / GBK switch**, pause, clear, save.

**Long-run recording** (new in v2.1): data is written **straight to disk in the Rust backend**,
bypassing the UI — memory stays flat all day. Configurable folder, file prefix,
**split size** (a new file starts automatically when one fills up) and **per-line local timestamps**.

**Chart view** (new in v2.1): the receive pane toggles between **Text / Chart** and auto-plots
 pairs (up to 6 series). While in chart view the text stops accumulating DOM nodes,
so the two never fight over memory.

**Send** — HEX/ASCII, newline (CRLF/LF/CR), timed send, appended checksum
(CRC16 / CCITT / ADD8 / XOR8), **send on keypress**, **send on Enter**, file sending in
256-byte chunks, drop-a-file support.

**Quick send list** — unlimited entries, per-entry ASC/HEX, send-all and loop, persisted.

**Tools** — checksum calculator; one-click Chinese/English UI switch (Chinese by default).

## Quick start

1. Download `DaFeiYu-Serial-Assistant-2.0.0-portable.exe` from [Releases](../../releases)
2. Double-click — genuinely portable, no install, no extraction wait
3. Pick a mode, hit **Open / Connect / Listen**

## Build from source

Requires the **Rust toolchain**, an **MSVC linker**, and the **WebView2 runtime**.

```bash
git clone https://github.com/MYX-0211/dafeiyu-serial-assistant.git
cd dafeiyu-serial-assistant/src-tauri

cargo test --release        # 9 unit tests
cargo build --release       # output: target/release/dafeiyu-serial-assistant.exe
```

## License

MIT License · Author **MYX** · [github.com/MYX-0211](https://github.com/MYX-0211)
