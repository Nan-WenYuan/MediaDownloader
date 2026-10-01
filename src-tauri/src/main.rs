#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{io::{BufRead, BufReader, Write}, path::PathBuf, process::{Child, ChildStdin, Command, Stdio}, sync::{Arc, Mutex, mpsc}, time::Duration};
use serde_json::{Value, json};
use tauri::Manager;
#[cfg(windows)] use std::os::windows::process::CommandExt;

struct Worker { child: Child, stdin: ChildStdin, receiver: mpsc::Receiver<String> }
impl Worker {
    fn request(&mut self, command: &str, args: Value) -> Result<Value, String> {
        if self.child.try_wait().map_err(|e|e.to_string())?.is_some() { return Err("下载服务已退出，请重新启动客户端".into()); }
        writeln!(self.stdin, "{}", json!({"command":command,"args":args})).map_err(|e|e.to_string())?;
        self.stdin.flush().map_err(|e|e.to_string())?;
        let timeout = if command == "update_prepare" { 3600 } else if command == "update_check" { 240 } else { 35 };
        let line = self.receiver.recv_timeout(Duration::from_secs(timeout)).map_err(|_|"服务响应超时，请重新启动客户端".to_string())?;
        let response: Value = serde_json::from_str(&line).map_err(|e|e.to_string())?;
        if let Some(error) = response.get("error").and_then(Value::as_str) { return Err(error.into()); }
        Ok(response["result"].clone())
    }
}
type Service = Arc<Mutex<Worker>>;
fn app_root() -> Result<(PathBuf, bool), Box<dyn std::error::Error>> {
    let exe_dir = std::env::current_exe()?.parent().unwrap().to_path_buf();
    let portable = exe_dir.join("runtime/node.exe").is_file();
    let root = if portable { exe_dir } else { PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf() };
    Ok((root, portable))
}
fn start_worker() -> Result<Worker, Box<dyn std::error::Error>> {
    let (root, portable) = app_root()?;
    let node = if portable { root.join("runtime/node.exe") } else { PathBuf::from("node.exe") };
    let script = root.join(if portable {"backend/desktop-worker.mjs"} else {"src/desktop-worker.mjs"});
    let data_dir = root.join(if portable {"数据"} else {".runtime/desktop"});
    std::fs::create_dir_all(&data_dir)?;
    // 每个客户端使用自己的浏览器通信端口，与终端版本分离。
    let socket = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = socket.local_addr()?.port(); drop(socket);
    let mut command = Command::new(node);
    command.arg(script).current_dir(&root).env("MEDIA_APP_DIR", &root).env("MEDIA_DATA_DIR", &data_dir)
      .env("MEDIA_CDP_PORT", port.to_string()).env("MEDIA_VERSION", env!("CARGO_PKG_VERSION"))
      .env("MEDIA_FFMPEG", if portable {root.join("runtime/ffmpeg.exe")} else {PathBuf::from("D:/Software/ffmpeg/bin/ffmpeg.exe")})
      .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::from(std::fs::OpenOptions::new().create(true).append(true).open(data_dir.join("service.log"))?));
    #[cfg(windows)] command.creation_flags(0x08000000);
    let mut child = command.spawn()?;
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || { for line in BufReader::new(stdout).lines() { match line {Ok(line) => {if sender.send(line).is_err() {break;}}, Err(_) => break} } });
    Ok(Worker {child, stdin, receiver})
}
#[tauri::command]
async fn service(command: String, args: Value, state: tauri::State<'_, Service>) -> Result<Value, String> {
    if !["state","download","retry","login","account","set_output","open_folder","update_check","update_prepare"].contains(&command.as_str()) {return Err("未知操作".into());}
    let worker = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || worker.lock().map_err(|_|"下载服务锁错误".to_string())?.request(&command,args)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn choose_folder(current: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || rfd::FileDialog::new().set_title("选择下载保存目录").set_directory(current).pick_folder().map(|p|p.to_string_lossy().to_string())).await.map_err(|e|e.to_string())
}
fn main() {
    if std::env::args().any(|arg| arg == "--self-test") {
      match start_worker() {
        Ok(mut worker) => {
          let result = worker.request("state", json!({}));
          let _ = worker.request("shutdown", json!({})); let _ = worker.child.wait();
          match result {Ok(state) => println!("{}", json!({"ok":true,"version":state["version"],"output":state["output"]})),Err(error) => {eprintln!("{}",error);std::process::exit(1);}}
        }, Err(error) => {eprintln!("{}",error);std::process::exit(1);}
      }
      return;
    }
    let app = tauri::Builder::default()
      .plugin(tauri_plugin_single_instance::init(|app, _, _| { if let Some(window) = app.get_webview_window("main") { let _ = window.set_focus(); } }))
      .setup(|app| {
        app.manage(Arc::new(Mutex::new(start_worker()?)));
        let (root, portable) = app_root()?;
        let webview_data = root.join(if portable {"数据/webview"} else {".runtime/desktop/webview"});
        tauri::WebviewWindowBuilder::new(app,"main",tauri::WebviewUrl::App("index.html".into()))
          .title("三平台下载器").inner_size(1100.0,800.0).min_inner_size(850.0,660.0)
          .data_directory(webview_data).build()?;
        Ok(())
      })
      .invoke_handler(tauri::generate_handler![service, choose_folder, install_update])
      .build(tauri::generate_context!()).expect("桌面客户端启动失败");
    app.run(|app, event| { if let tauri::RunEvent::Exit = event {
      let worker = app.state::<Service>(); if let Ok(mut worker) = worker.lock() { let _ = worker.request("shutdown", json!({})); let _ = worker.child.kill(); };
    }});
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle, state: tauri::State<'_, Service>) -> Result<(), String> {
    let worker = state.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || worker.lock().map_err(|_|"服务锁错误".to_string())?.request("update_prepare",json!({}))).await.map_err(|e|e.to_string())??;
    let directory = PathBuf::from(result["directory"].as_str().ok_or("更新交接失败")?);
    let (root, portable) = app_root().map_err(|e|e.to_string())?;
    if !portable || directory.parent() != Some(root.join(".media-update").as_path()) { return Err("更新路径无效".into()); }
    let mut command = Command::new(directory.join("helper.exe"));
    command.arg(directory.join("helper.mjs")).arg("--apply-update").arg(std::process::id().to_string())
      .current_dir(&root).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)] command.creation_flags(0x08000000);
    command.spawn().map_err(|e|format!("更新助手未启动，程序未退出：{e}"))?;
    app.exit(0);
    Ok(())
}
