// Windows 发布版不要弹黑色控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dafeiyu_serial_assistant_lib::run()
}
