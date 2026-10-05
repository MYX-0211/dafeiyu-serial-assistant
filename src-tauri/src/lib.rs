// ==========================================================================
//  大肥鱼串口助手 · Tauri 后端
//  --------------------------------------------------------------------------
//  用 Rust 实现四种链路（串口 / TCP Client / TCP Server / UDP），
//  统一成 open / close / write 三个动作 + 一个 link:data 事件上行。
//  前端只需要 invoke 命令、listen 事件，不关心底层是哪种链路。
// ==========================================================================

use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

// ==========================================================================
//  类型
// ==========================================================================

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub path: String,
    pub manufacturer: String,
    pub friendly_name: String,
    pub serial_number: String,
    pub vendor_id: String,
    pub product_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenConfig {
    pub mode: String,
    // 串口
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub baud_rate: Option<u32>,
    #[serde(default)]
    pub data_bits: Option<u8>,
    #[serde(default)]
    pub stop_bits: Option<String>,
    #[serde(default)]
    pub parity: Option<String>,
    #[serde(default)]
    pub rtscts: Option<bool>,
    #[serde(default)]
    pub dtr: Option<bool>,
    #[serde(default)]
    pub rts: Option<bool>,
    // 网络
    #[serde(default)]
    pub remote_host: Option<String>,
    #[serde(default)]
    pub remote_port: Option<u16>,
    #[serde(default)]
    pub local_addr: Option<String>,
    #[serde(default)]
    pub local_port: Option<u16>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl OpenResult {
    fn ok(label: String) -> Self {
        Self { ok: true, label: Some(label), error: None }
    }
    fn err(msg: impl Into<String>) -> Self {
        Self { ok: false, label: None, error: Some(msg.into()) }
    }
}

/// 一条已打开的链路
enum Link {
    Serial(Box<dyn serialport::SerialPort>),
    TcpClient(TcpStream),
    TcpServer { listener: TcpListener, client: Arc<Mutex<Option<TcpStream>>> },
    Udp { sock: UdpSocket, remote: SocketAddr },
}

struct Active {
    link: Link,
    /// 读线程靠它判断该不该退出
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
struct AppState {
    active: Mutex<Option<Active>>,
    /// 长时记录器（可选）：收到数据时直接落盘，不经过前端 DOM
    recorder: Arc<Mutex<Option<Recorder>>>,
}

impl AppState {
    fn take(&self) -> Option<Active> {
        self.active.lock().unwrap().take()
    }
}

// ==========================================================================
//  长时记录器
//  --------------------------------------------------------------------------
//  为什么放在 Rust 侧：串口助手原来跑久了会卡，是因为每条数据都要进 DOM。
//  长时记录模式下数据直接写文件（BufWriter 缓冲），前端只是旁路看一眼，
//  内存占用恒定，跑一整天也不涨。
// ==========================================================================

struct Recorder {
    file: BufWriter<File>,
    dir: PathBuf,
    base: String,
    max_bytes: u64,
    written: u64,
    index: u32,
    add_ts: bool,
    tz_offset_min: i64,
    /// 跨 chunk 的行缓冲：串口数据是按块来的，一行可能被拆成两块
    line_buf: Vec<u8>,
    started_at: SystemTime,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordStats {
    active: bool,
    dir: String,
    file_name: String,
    files: u32,
    bytes: u64,
    elapsed_secs: u64,
}

impl Recorder {
    fn open_new(dir: &Path, base: &str, index: u32) -> std::io::Result<(BufWriter<File>, String)> {
        let name = format!("{}_{:03}.txt", base, index);
        let path = dir.join(&name);
        let f = OpenOptions::new().create(true).write(true).truncate(true).open(&path)?;
        Ok((BufWriter::with_capacity(64 * 1024, f), name))
    }

    fn new(
        dir: PathBuf,
        base: String,
        max_bytes: u64,
        add_ts: bool,
        tz_offset_min: i64,
    ) -> std::io::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        let (file, _name) = Self::open_new(&dir, &base, 1)?;
        Ok(Self {
            file,
            dir,
            base,
            max_bytes: if max_bytes == 0 { 8 * 1024 * 1024 } else { max_bytes },
            written: 0,
            index: 1,
            add_ts,
            tz_offset_min,
            line_buf: Vec::new(),
            started_at: SystemTime::now(),
        })
    }

    fn current_name(&self) -> String {
        format!("{}_{:03}.txt", self.base, self.index)
    }

    /// 落盘一段原始字节；需要时间戳时按行切分，跨块的行会暂存到下次
    fn write(&mut self, data: &[u8]) -> std::io::Result<()> {
        if !self.add_ts {
            return self.raw_write(data);
        }
        self.line_buf.extend_from_slice(data);
        loop {
            let pos = match self.line_buf.iter().position(|&b| b == b'\n') {
                Some(p) => p,
                None => break,
            };
            let line: Vec<u8> = self.line_buf.drain(..=pos).collect();
            let ts = format!("[{}] ", local_time_str(self.tz_offset_min));
            self.raw_write(ts.as_bytes())?;
            self.raw_write(&line)?;
        }
        Ok(())
    }

    fn raw_write(&mut self, data: &[u8]) -> std::io::Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        // 写之前判断要不要切文件
        if self.written > 0 && self.written + data.len() as u64 > self.max_bytes {
            self.file.flush()?;
            self.index += 1;
            let (f, _) = Self::open_new(&self.dir, &self.base, self.index)?;
            self.file = f;
            self.written = 0;
        }
        self.file.write_all(data)?;
        self.written += data.len() as u64;
        Ok(())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if self.add_ts && !self.line_buf.is_empty() {
            // 收尾：最后没换行的那段也要落盘
            let rest = std::mem::take(&mut self.line_buf);
            if !rest.is_empty() {
                let ts = format!("[{}] ", local_time_str(self.tz_offset_min));
                self.raw_write(ts.as_bytes())?;
                self.raw_write(&rest)?;
            }
        }
        self.file.flush()
    }

    fn stats(&self) -> RecordStats {
        let elapsed = self
            .started_at
            .elapsed()
            .map(|d| d.as_secs())
            .unwrap_or(0);
        RecordStats {
            active: true,
            dir: self.dir.to_string_lossy().to_string(),
            file_name: self.current_name(),
            files: self.index,
            bytes: self.written,
            elapsed_secs: elapsed,
        }
    }
}

/// 把 Unix 秒转成「年月日 时分秒.毫秒」，不引第三方库
fn local_time_str(tz_offset_min: i64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let total_secs = now.as_secs() as i64 + tz_offset_min * 60;
    let ms = now.subsec_millis();
    let days = total_secs.div_euclid(86400);
    let sod = total_secs.rem_euclid(86400);
    let (h, mi, sec) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    let (y, mo, d) = civil_from_days(days);
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}", y, mo, d, h, mi, sec, ms)
}

/// Howard Hinnant 的 civil_from_days：把「1970-01-01 起的天数」转成年月日
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ==========================================================================
//  工具
// ==========================================================================

/// 把错误码转成人话（跟前端展示的提示语对齐）
fn humanize_io_err(code: &str, addr: &str, port: u16) -> String {
    match code {
        "EADDRINUSE" | "WSAEADDRINUSE" => format!("本地端口 {} 已被其它程序占用", port),
        "EACCES" | "WSAEACCES" => format!("端口 {} 需要管理员权限", port),
        "EADDRNOTAVAIL" | "WSAEADDRNOTAVAIL" => format!(
            "本地地址 {} 不属于本机可用网卡 —— 请把「本地」改成「全部网卡」，或选一个真正的本机 IP",
            addr
        ),
        "ECONNREFUSED" | "WSAECONNREFUSED" => {
            "连接被拒绝 —— 目标 IP / 端口没有在监听，或被防火墙拦了".into()
        }
        "ETIMEDOUT" | "WSAETIMEDOUT" => "连接超时 —— 检查 IP 是否可达、网线 / 网段是否通".into(),
        "EHOSTUNREACH" | "WSAEHOSTUNREACH" | "ENETUNREACH" | "WSAENETUNREACH" => {
            "目标网络不可达 —— 确认本机和目标在同一网段".into()
        }
        _ => String::new(),
    }
}

fn io_err_text(e: &std::io::Error, addr: &str, port: u16) -> String {
    let raw = e.to_string();
    // std 的 ErrorKind 覆盖不全，这里用错误码字符串兜一层
    let code = match e.raw_os_error() {
        Some(_) => extract_code(&e.to_string()),
        None => String::new(),
    };
    let hint = humanize_io_err(&code, addr, port);
    if hint.is_empty() { raw } else { hint }
}

/// 从 "address not available (os error 10049)" 这类文本里找出错误码
fn extract_code(text: &str) -> String {
    const CODES: &[&str] = &[
        "EADDRINUSE", "EADDRNOTAVAIL", "EACCES", "ECONNREFUSED", "ETIMEDOUT",
        "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "ECONNRESET", "EPIPE",
    ];
    for c in CODES {
        if text.contains(c) {
            return (*c).to_string();
        }
    }
    // Windows 的 os error 数字映射
    let map = [
        (10048u32, "EADDRINUSE"),
        (10049, "EADDRNOTAVAIL"),
        (10013, "EACCES"),
        (10061, "ECONNREFUSED"),
        (10060, "ETIMEDOUT"),
        (10065, "EHOSTUNREACH"),
        (10051, "ENETUNREACH"),
        (10054, "ECONNRESET"),
    ];
    for (n, c) in map {
        if text.contains(&format!("os error {}", n)) {
            return c.to_string();
        }
    }
    String::new()
}

// ==========================================================================
//  命令：枚举串口
// ==========================================================================

#[tauri::command]
fn list_ports() -> Vec<PortInfo> {
    let mut list: Vec<PortInfo> = serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| {
            let path = p.port_name;
            if path.is_empty() {
                return None;
            }
            let (manu, sn) = match &p.port_type {
                serialport::SerialPortType::UsbPort(info) => (
                    info.manufacturer.clone().unwrap_or_default(),
                    info.serial_number.clone().unwrap_or_default(),
                ),
                _ => (String::new(), String::new()),
            };
            Some(PortInfo {
                path,
                manufacturer: manu,
                friendly_name: String::new(),
                serial_number: sn,
                vendor_id: String::new(),
                product_id: String::new(),
            })
        })
        .collect();
    // 按 COM 号自然排序
    list.sort_by_key(|p| {
        p.path
            .chars()
            .filter(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse::<u32>()
            .unwrap_or(0)
    });
    list
}

// ==========================================================================
//  命令：本机 IPv4
// ==========================================================================

#[tauri::command]
fn local_ips() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(ip) = local_ip_address::local_ip() {
        out.push(ip.to_string());
    }
    // 再尽量补上其余网卡
    if let Ok(list) = local_ip_address::list_afinet_netifas() {
        for (_name, ip) in list {
            if let IpAddr::V4(v4) = ip {
                if !v4.is_loopback() {
                    let s = v4.to_string();
                    if !out.contains(&s) {
                        out.push(s);
                    }
                }
            }
        }
    }
    out
}

// ==========================================================================
//  命令：打开 / 关闭 / 写
// ==========================================================================

#[tauri::command]
fn open_link(app: AppHandle, state: State<'_, AppState>, cfg: OpenConfig) -> OpenResult {
    // 先关掉旧的
    do_close(&state);

    match cfg.mode.as_str() {
        "serial" => open_serial(app, state, cfg),
        "tcp-client" => open_tcp_client(app, state, cfg),
        "tcp-server" => open_tcp_server(app, state, cfg),
        "udp" => open_udp(app, state, cfg),
        other => OpenResult::err(format!("不支持的模式：{}", other)),
    }
}

fn open_serial(app: AppHandle, state: State<'_, AppState>, cfg: OpenConfig) -> OpenResult {
    let path = match cfg.path.as_deref() {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => return OpenResult::err("请选择一个串口设备"),
    };

    let parity = match cfg.parity.as_deref().unwrap_or("none") {
        "even" => serialport::Parity::Even,
        "odd" => serialport::Parity::Odd,
        _ => serialport::Parity::None,
    };
    let stop_bits = match cfg.stop_bits.as_deref().unwrap_or("1") {
        "2" => serialport::StopBits::Two,
        _ => serialport::StopBits::One,
    };
    let data_bits = match cfg.data_bits.unwrap_or(8) {
        5 => serialport::DataBits::Five,
        6 => serialport::DataBits::Six,
        7 => serialport::DataBits::Seven,
        _ => serialport::DataBits::Eight,
    };

    let builder = serialport::new(&path, cfg.baud_rate.unwrap_or(115200))
        .data_bits(data_bits)
        .stop_bits(stop_bits)
        .parity(parity)
        .flow_control(if cfg.rtscts.unwrap_or(false) {
            serialport::FlowControl::Hardware
        } else {
            serialport::FlowControl::None
        })
        .timeout(Duration::from_millis(50));

    let mut port = match builder.open() {
        Ok(p) => p,
        Err(e) => {
            let raw = e.to_string();
            let hint = if raw.contains("Access is denied") || raw.contains("拒绝访问") {
                "串口被占用或拒绝访问 —— 请先关闭 SSCOM / XCOM 等其它串口工具后再试"
            } else if raw.contains("系统找不到") || raw.contains("not found") {
                "找不到该串口，设备可能已被拔出"
            } else {
                &raw
            };
            return OpenResult::err(hint.to_string());
        }
    };

    // DTR / RTS 初值
    let _ = port.write_data_terminal_ready(cfg.dtr.unwrap_or(true));
    let _ = port.write_request_to_send(cfg.rts.unwrap_or(false));

    let mut reader = match port.try_clone() {
        Ok(r) => r,
        Err(e) => return OpenResult::err(e.to_string()),
    };

    let stop = Arc::new(AtomicBool::new(false));
    let rec = state.recorder.clone();
    spawn_reader(app, stop.clone(), rec, move |buf| {
        match reader.read(buf) {
            Ok(0) => Ok(0),
            Ok(n) => Ok(n),
            Err(ref e) if e.kind() == ErrorKind::TimedOut => Ok(0),
            Err(e) => Err(e),
        }
    });

    let label = path.clone();
    *state.active.lock().unwrap() = Some(Active { link: Link::Serial(port), stop });
    OpenResult::ok(label)
}

fn open_tcp_client(app: AppHandle, state: State<'_, AppState>, cfg: OpenConfig) -> OpenResult {
    let host = cfg.remote_host.clone().unwrap_or_default();
    if host.trim().is_empty() {
        return OpenResult::err("请填写远程 IP / 主机名");
    }
    let port = cfg.remote_port.unwrap_or(0);
    if port == 0 {
        return OpenResult::err("请填写有效的远程端口");
    }
    let addr = format!("{}:{}", host.trim(), port);

    // 带超时的连接
    let sock = match TcpStream::connect_timeout(
        &match addr.parse() {
            Ok(a) => a,
            Err(_) => match std::net::ToSocketAddrs::to_socket_addrs(&addr) {
                Ok(mut it) => match it.next() {
                    Some(a) => a,
                    None => return OpenResult::err("主机名解析失败 —— 检查 IP / 主机名"),
                },
                Err(_) => return OpenResult::err("主机名解析失败 —— 检查 IP / 主机名"),
            },
        },
        Duration::from_secs(8),
    ) {
        Ok(s) => s,
        Err(e) => return OpenResult::err(io_err_text(&e, "", port)),
    };

    let _ = sock.set_nodelay(true);

    let mut reader = match sock.try_clone() {
        Ok(r) => r,
        Err(e) => return OpenResult::err(e.to_string()),
    };

    let label = addr.clone();
    let app2 = app.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let rec = state.recorder.clone();
    spawn_reader(app.clone(), stop.clone(), rec, move |buf| reader.read(buf));

    // 连接断开时通知前端
    let stop2 = stop.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(300));
        if stop2.load(Ordering::Relaxed) {
            break;
        }
    });

    *state.active.lock().unwrap() = Some(Active { link: Link::TcpClient(sock), stop });
    let _ = app2.emit("link:ready", ());
    OpenResult::ok(label)
}

fn open_tcp_server(app: AppHandle, state: State<'_, AppState>, cfg: OpenConfig) -> OpenResult {
    let bind_addr = cfg
        .local_addr
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("0.0.0.0");
    let port = cfg.local_port.unwrap_or(0);
    if port == 0 {
        return OpenResult::err("请填写本地监听端口");
    }
    let addr_str = format!("{}:{}", bind_addr, port);

    let listener = match TcpListener::bind(&addr_str) {
        Ok(l) => l,
        Err(e) => return OpenResult::err(io_err_text(&e, bind_addr, port)),
    };

    let label = format!("监听 {}", addr_str);
    let stop = Arc::new(AtomicBool::new(false));
    let client: Arc<Mutex<Option<TcpStream>>> = Arc::new(Mutex::new(None));

    // 接受连接的线程
    let app2 = app.clone();
    let stop2 = stop.clone();
    let client2 = client.clone();
    let rec2 = state.recorder.clone();
    let listener2 = match listener.try_clone() {
        Ok(l) => l,
        Err(e) => return OpenResult::err(e.to_string()),
    };
    thread::spawn(move || {
        for stream in listener2.incoming() {
            if stop2.load(Ordering::Relaxed) {
                break;
            }
            match stream {
                Ok(s) => {
                    let _ = s.set_nodelay(true);
                    let peer = s
                        .peer_addr()
                        .map(|a| a.to_string())
                        .unwrap_or_else(|_| "unknown".into());
                    // 新客户端顶掉旧的
                    if let Some(old) = client2.lock().unwrap().take() {
                        let _ = old.shutdown(std::net::Shutdown::Both);
                    }
                    let mut rd = match s.try_clone() {
                        Ok(r) => r,
                        Err(_) => continue,
                    };
                    *client2.lock().unwrap() = Some(s);
                    let _ = app2.emit("link:peer", serde_json::json!({ "connected": true, "peer": peer }));
                    // 每个客户端一个读线程
                    let stop3 = stop2.clone();
                    let app3 = app2.clone();
                    let rec3 = rec2.clone();
                    thread::spawn(move || {
                        let mut buf = [0u8; 8192];
                        loop {
                            if stop3.load(Ordering::Relaxed) {
                                break;
                            }
                            match rd.read(&mut buf) {
                                Ok(0) => break,
                                Ok(n) => {
                                    if let Ok(mut g) = rec3.lock() {
                                        if let Some(r) = g.as_mut() {
                                            let _ = r.write(&buf[..n]);
                                        }
                                    }
                                    let _ = app3.emit("link:data", buf[..n].to_vec());
                                }
                                Err(ref e) if e.kind() == ErrorKind::TimedOut => continue,
                                Err(_) => break,
                            }
                        }
                        let _ = app3.emit("link:peer", serde_json::json!({ "connected": false }));
                    });
                }
                Err(_) => {
                    if stop2.load(Ordering::Relaxed) {
                        break;
                    }
                }
            }
        }
    });

    *state.active.lock().unwrap() = Some(Active { link: Link::TcpServer { listener, client }, stop });
    OpenResult::ok(label)
}

fn open_udp(app: AppHandle, state: State<'_, AppState>, cfg: OpenConfig) -> OpenResult {
    let host = cfg.remote_host.clone().unwrap_or_default();
    if host.trim().is_empty() {
        return OpenResult::err("请填写远程 IP / 主机名");
    }
    let rport = cfg.remote_port.unwrap_or(0);
    if rport == 0 {
        return OpenResult::err("请填写有效的远程端口");
    }
    let bind_addr = cfg
        .local_addr
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("0.0.0.0");
    let lport = cfg.local_port.unwrap_or(0);
    let bind_str = if bind_addr == "0.0.0.0" {
        format!("0.0.0.0:{}", lport)
    } else {
        format!("{}:{}", bind_addr, lport)
    };

    let sock = match UdpSocket::bind(&bind_str) {
        Ok(s) => s,
        Err(e) => return OpenResult::err(io_err_text(&e, bind_addr, lport)),
    };

    // 解析目标地址
    let remote: SocketAddr = match format!("{}:{}", host.trim(), rport).parse() {
        Ok(a) => a,
        Err(_) => match std::net::ToSocketAddrs::to_socket_addrs(&format!("{}:{}", host.trim(), rport)) {
            Ok(mut it) => match it.next() {
                Some(a) => a,
                None => return OpenResult::err("主机名解析失败 —— 检查 IP / 主机名"),
            },
            Err(_) => return OpenResult::err("主机名解析失败 —— 检查 IP / 主机名"),
        },
    };

    let reader = match sock.try_clone() {
        Ok(r) => r,
        Err(e) => return OpenResult::err(e.to_string()),
    };

    let local_shown = if lport == 0 { "自动".to_string() } else { lport.to_string() };
    let label = format!("本机 {} → {}", local_shown, remote);

    let stop = Arc::new(AtomicBool::new(false));
    let rec = state.recorder.clone();
    spawn_reader(app, stop.clone(), rec, move |buf| reader.recv(buf));

    *state.active.lock().unwrap() = Some(Active { link: Link::Udp { sock, remote }, stop });
    OpenResult::ok(label)
}

/// 起一个读线程，循环把数据 emit 给前端
fn spawn_reader<F>(
    app: AppHandle,
    stop: Arc<AtomicBool>,
    rec: Arc<Mutex<Option<Recorder>>>,
    mut read_fn: F,
) where
    F: FnMut(&mut [u8]) -> std::io::Result<usize> + Send + 'static,
{
    thread::spawn(move || {
        let mut buf = vec![0u8; 8192];
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            match read_fn(&mut buf) {
                Ok(0) => thread::sleep(Duration::from_millis(5)),
                Ok(n) => {
                    // 先落盘（长时记录模式下这是主通道），再推给前端旁路显示
                    if let Ok(mut g) = rec.lock() {
                        if let Some(r) = g.as_mut() {
                            let _ = r.write(&buf[..n]);
                        }
                    }
                    let _ = app.emit("link:data", buf[..n].to_vec());
                }
                Err(ref e) if e.kind() == ErrorKind::TimedOut || e.kind() == ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(e) => {
                    if !stop.load(Ordering::Relaxed) {
                        let _ = app.emit("link:error", e.to_string());
                        let _ = app.emit("link:closed", serde_json::json!({ "reason": "连接已断开" }));
                    }
                    break;
                }
            }
        }
    });
}

fn do_close(state: &State<'_, AppState>) {
    if let Some(active) = state.take() {
        active.stop.store(true, Ordering::Relaxed);
        match active.link {
            Link::Serial(p) => {
                let _ = p.clear(serialport::ClearBuffer::All);
            }
            Link::TcpClient(s) => {
                let _ = s.shutdown(std::net::Shutdown::Both);
            }
            Link::TcpServer { listener, client } => {
                drop(listener);
                if let Some(c) = client.lock().unwrap().take() {
                    let _ = c.shutdown(std::net::Shutdown::Both);
                }
            }
            Link::Udp { sock, .. } => {
                drop(sock);
            }
        }
    }
}

#[tauri::command]
fn close_link(state: State<'_, AppState>) -> bool {
    do_close(&state);
    true
}

#[tauri::command]
fn write_link(state: State<'_, AppState>, data: Vec<u8>) -> Result<usize, String> {
    if data.is_empty() {
        return Err("空数据".into());
    }
    let mut guard = state.active.lock().unwrap();
    let active = guard.as_mut().ok_or_else(|| "链路未打开".to_string())?;
    let n = data.len();
    let r = match &mut active.link {
        Link::Serial(p) => p.write_all(&data).map(|_| n),
        Link::TcpClient(s) => s.write_all(&data).map(|_| n),
        Link::TcpServer { client, .. } => {
            let mut g = client.lock().unwrap();
            match g.as_mut() {
                Some(c) => c.write_all(&data).map(|_| n),
                None => Err(std::io::Error::new(ErrorKind::NotConnected, "还没有客户端接入")),
            }
        }
        Link::Udp { sock, remote } => sock.send_to(&data, *remote).map(|_| n),
    };
    r.map_err(|e| e.to_string())
}

#[tauri::command]
fn set_signals(state: State<'_, AppState>, dtr: Option<bool>, rts: Option<bool>) -> bool {
    let mut guard = state.active.lock().unwrap();
    if let Some(active) = guard.as_mut() {
        if let Link::Serial(p) = &mut active.link {
            if let Some(v) = dtr {
                let _ = p.write_data_terminal_ready(v);
            }
            if let Some(v) = rts {
                let _ = p.write_request_to_send(v);
            }
            return true;
        }
    }
    false
}

// ==========================================================================
//  命令：保存文件 / 应用信息
// ==========================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePayload {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub default_name: Option<String>,
    pub content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub ok: bool,
    #[serde(default)]
    pub canceled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command]
async fn save_file(app: AppHandle, payload: SavePayload) -> SaveResult {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();
    let default_name = payload.default_name.clone().unwrap_or_else(|| "export.txt".into());
    app.dialog()
        .file()
        .set_title(payload.title.clone().unwrap_or_else(|| "保存文件".into()))
        .set_file_name(&default_name)
        .add_filter("文本文件", &["txt"])
        .save_file(move |path| {
            let _ = tx.send(path);
        });

    let picked = rx.recv().ok().flatten();
    match picked {
        None => SaveResult { ok: false, canceled: true, file_path: None, error: None },
        Some(p) => {
            let path = p.to_string();
            match std::fs::write(&path, payload.content.as_bytes()) {
                Ok(_) => SaveResult { ok: true, canceled: false, file_path: Some(path), error: None },
                Err(e) => SaveResult { ok: false, canceled: false, file_path: None, error: Some(e.to_string()) },
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordOptions {
    /// 存到哪个目录
    pub dir: String,
    /// 文件名前缀，最终是 {base}_001.txt
    pub base: String,
    /// 单个文件上限（字节），0 表示用默认 8 MB
    #[serde(default)]
    pub max_bytes: u64,
    /// 每行前面加本地时间戳
    #[serde(default)]
    pub add_ts: bool,
    /// 本地时区相对 UTC 的分钟偏移（前端传，避免引时区库）
    #[serde(default)]
    pub tz_offset_min: i64,
}

#[tauri::command]
fn record_start(state: State<'_, AppState>, opts: RecordOptions) -> Result<RecordStats, String> {
    let mut g = state.recorder.lock().unwrap();
    if let Some(mut old) = g.take() {
        let _ = old.flush();
    }
    let rec = Recorder::new(
        PathBuf::from(&opts.dir),
        if opts.base.trim().is_empty() { "serial".into() } else { opts.base.trim().to_string() },
        opts.max_bytes,
        opts.add_ts,
        opts.tz_offset_min,
    )
    .map_err(|e| format!("无法创建记录文件：{}", e))?;
    let stats = rec.stats();
    *g = Some(rec);
    Ok(stats)
}

#[tauri::command]
fn record_stop(state: State<'_, AppState>) -> Option<RecordStats> {
    let mut g = state.recorder.lock().unwrap();
    if let Some(mut r) = g.take() {
        let _ = r.flush();
        let mut st = r.stats();
        st.active = false;
        return Some(st);
    }
    None
}

#[tauri::command]
fn record_status(state: State<'_, AppState>) -> Option<RecordStats> {
    let g = state.recorder.lock().unwrap();
    g.as_ref().map(|r| r.stats())
}

/// 让用户挑一个保存目录
#[tauri::command]
async fn pick_folder(app: AppHandle, default_dir: Option<String>) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    let mut b = app.dialog().file().set_title("选择记录保存目录");
    if let Some(d) = default_dir {
        if !d.trim().is_empty() {
            b = b.set_directory(PathBuf::from(d));
        }
    }
    b.pick_folder(move |p| {
        let _ = tx.send(p);
    });
    rx.recv().ok().flatten().map(|p| p.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub arch: String,
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

// ==========================================================================
//  入口
// ==========================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            list_ports,
            local_ips,
            open_link,
            close_link,
            write_link,
            set_signals,
            save_file,
            app_info,
            record_start,
            record_stop,
            record_status,
            pick_folder,
        ])
        .setup(|app| {
            // 把窗口图标也设上（跟 exe 资源图标保持一致）
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_title("大肥鱼串口助手");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // 窗口关了就释放链路
                let state = window.state::<AppState>();
                do_close(&state);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 让未使用的 import 不报警（Ipv4Addr 在部分平台用不到）
#[allow(dead_code)]
fn _unused() -> Ipv4Addr {
    Ipv4Addr::UNSPECIFIED
}

// ==========================================================================
//  单元测试（内联：分离文件时对私有项的可见性传递有坑）
//  运行：cargo test
// ==========================================================================
#[cfg(test)]
mod tests {

    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    // ---------------- 错误码解析 ----------------

    /// 能识别文本里直接出现的错误码
    #[test]
    fn parse_error_code_from_text() {
        assert_eq!(extract_code("Address already in use (os error 10048)"), "EADDRINUSE");
        assert_eq!(extract_code("some EADDRNOTAVAIL happened"), "EADDRNOTAVAIL");
    }

    /// Windows 的 os error 数字要能映射成标准码（用户看到的往往只有数字）
    #[test]
    fn map_windows_os_error_numbers() {
        assert_eq!(extract_code("address not available (os error 10049)"), "EADDRNOTAVAIL");
        assert_eq!(extract_code("only one usage (os error 10048)"), "EADDRINUSE");
        assert_eq!(extract_code("access denied (os error 10013)"), "EACCES");
        assert_eq!(extract_code("conn refused (os error 10061)"), "ECONNREFUSED");
    }

    /// 错误码要能转成给用户看的人话
    #[test]
    fn humanize_known_errors() {
        // 这正是用户上次踩到的 EADDRNOTAVAIL，提示里必须指出「改成全部网卡」
        let msg = humanize_io_err("EADDRNOTAVAIL", "192.168.120.1", 8080);
        assert!(msg.contains("192.168.120.1"), "提示里应带上出问题的地址");
        assert!(msg.contains("全部网卡"), "提示里应告诉用户怎么改");

        let msg2 = humanize_io_err("EADDRINUSE", "", 8080);
        assert!(msg2.contains("8080"), "端口占用要带上端口号");

        // 没见过的错误码返回空，让调用方回退到原始信息
        assert_eq!(humanize_io_err("EWEIRD", "", 0), "");
    }

    // ---------------- 串口枚举 ----------------

    /// 枚举串口不能 panic（有没有设备都要安全返回）
    #[test]
    fn list_ports_never_panics() {
        let list = list_ports();
        for p in &list {
            assert!(!p.path.is_empty(), "串口 path 不应该为空");
        }
        println!(
            "本机检测到 {} 个串口: {:?}",
            list.len(),
            list.iter().map(|p| p.path.as_str()).collect::<Vec<_>>()
        );
    }

    // ---------------- 真实 socket 行为 ----------------

    /// 复现「点侦听 → 客户端连进来 → 双向收发」这条路径
    #[test]
    fn tcp_server_bind_and_exchange() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定随机端口应成功");
        let port = listener.local_addr().unwrap().port();
        assert!(port > 0, "系统应分配到一个有效端口");

        let mut cli = TcpStream::connect(("127.0.0.1", port)).expect("客户端应能连上");
        let (mut srv_side, peer) = listener.accept().expect("服务端应接受连接");
        assert_eq!(peer.ip().to_string(), "127.0.0.1");

        // 客户端 -> 服务端
        cli.write_all(b"FROM-CLIENT").unwrap();
        let mut buf = [0u8; 64];
        let n = srv_side.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"FROM-CLIENT");

        // 服务端 -> 客户端
        srv_side.write_all(b"FROM-SERVER").unwrap();
        let n2 = cli.read(&mut buf).unwrap();
        assert_eq!(&buf[..n2], b"FROM-SERVER");
    }

    /// 拿不属于本机的地址去 listen，应该是「报错」而不是崩溃
    #[test]
    fn bind_unavailable_addr_reports_error() {
        let bad = "192.0.2.123:18080"; // TEST-NET-2，保证不是本机地址
        let r = TcpListener::bind(bad);
        assert!(r.is_err(), "绑定不可用地址应当失败");
        let e = r.err().unwrap();
        let code = extract_code(&e.to_string());
        println!("绑定 {} 的报错: {} | 识别码 = {:?}", bad, e, code);
        assert!(!e.to_string().is_empty(), "错误信息不应为空");
    }

    /// UDP 双向收发
    #[test]
    fn udp_send_and_recv() {
        let s1 = UdpSocket::bind("127.0.0.1:0").unwrap();
        let s2 = UdpSocket::bind("127.0.0.1:0").unwrap();
        let a1 = s1.local_addr().unwrap();
        let a2 = s2.local_addr().unwrap();

        s1.send_to(b"PING", a2).unwrap();
        let mut buf = [0u8; 32];
        let (n, from) = s2.recv_from(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"PING");
        assert_eq!(from, a1);

        s2.send_to(b"PONG", from).unwrap();
        let n2 = s1.recv(&mut buf).unwrap();
        assert_eq!(&buf[..n2], b"PONG");
    }

    /// 「本地端口填 0 表示自动分配」这条要真的成立
    #[test]
    fn port_zero_gets_auto_assigned() {
        let s = UdpSocket::bind("0.0.0.0:0").unwrap();
        let p = s.local_addr().unwrap().port();
        assert!(p > 0, "填 0 应由系统分配到一个真实端口");
    }

    /// 本机 IP 列表不应包含回环地址，且不应 panic
    #[test]
    fn local_ips_excludes_loopback() {
        let ips = local_ips();
        for ip in &ips {
            assert!(!ip.starts_with("127."), "不应把回环地址列出来: {}", ip);
        }
        println!("本机 IPv4: {:?}", ips);
    }
    
    /// 记录器：写盘 + 超上限自动开新文件
    #[test]
    fn recorder_writes_and_rotates() {
        let dir = std::env::temp_dir().join("dfy_rec_test_a");
        let _ = std::fs::remove_dir_all(&dir);
        // 上限设小一点，方便触发翻页
        let mut r = Recorder::new(dir.clone(), "t".into(), 100, false, 0).expect("创建记录器");
        r.write(b"hello").unwrap();
        r.flush().unwrap();
        let f1 = dir.join("t_001.txt");
        assert!(f1.exists(), "第一个文件应该已创建");
        assert_eq!(std::fs::read_to_string(&f1).unwrap(), "hello");

        // 连续写入超过 100 字节，应自动开第二个文件
        for _ in 0..10 {
            r.write(&[b'x'; 20]).unwrap();
        }
        r.flush().unwrap();
        let f2 = dir.join("t_002.txt");
        assert!(f2.exists(), "超过上限应自动开新文件，实际目录: {:?}", std::fs::read_dir(&dir).map(|it| it.filter_map(|e| e.ok()).map(|e| e.file_name()).collect::<Vec<_>>()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 记录器：加时间戳时每行一个，且跨写入块的行要拼回来
    #[test]
    fn recorder_timestamps_per_line() {
        let dir = std::env::temp_dir().join("dfy_rec_test_b");
        let _ = std::fs::remove_dir_all(&dir);
        let mut r = Recorder::new(dir.clone(), "ts".into(), 0, true, 480).expect("创建记录器");
        // 故意把一行拆成两次写，模拟串口分包
        r.write(b"speed=198.").unwrap();
        r.write(b"3\r\nspeed=200.1\r\n").unwrap();
        r.flush().unwrap();
        let txt = std::fs::read_to_string(dir.join("ts_001.txt")).unwrap();
        println!("记录内容: {:?}", txt);
        assert_eq!(txt.matches("speed=").count(), 2, "两行都应在");
        assert_eq!(txt.matches('[').count(), 2, "每行应各有一个时间戳");
        assert!(txt.contains("speed=198.3"), "跨块被拆的行应能拼回完整");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 记录器：不换行的尾巴也要落盘
    #[test]
    fn recorder_flushes_tail_without_newline() {
        let dir = std::env::temp_dir().join("dfy_rec_test_c");
        let _ = std::fs::remove_dir_all(&dir);
        let mut r = Recorder::new(dir.clone(), "tail".into(), 0, true, 480).expect("创建记录器");
        r.write(b"no-newline-here").unwrap();
        r.flush().unwrap();
        let txt = std::fs::read_to_string(dir.join("tail_001.txt")).unwrap();
        assert!(txt.contains("no-newline-here"), "没有换行的尾段也不能丢");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
