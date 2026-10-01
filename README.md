# 拾链接 · 三平台下载器

Tauri 2 + Vue 3 + Vite Windows 便携客户端。粘贴抖音、小红书或 B站分享链接，将视频或图文下载到自己指定的目录；保留 Node.js 终端入口。

- 自定义保存位置并记住设置，串行下载、进度、失败重试、断点续传及同名避让。
- 在工具专用 Edge 窗口登录自己的账号；会话只保存在本机，不上传 GitHub。
- “程序更新”从本仓库 GitHub Releases 检查新版，按 SHA-256 校验，只替换程序文件，保留账号、配置及下载文件。
- 便携发布为直接可运行的文件夹，不生成压缩包。公开 Release 使用独立文件与清单发布；首次安装下载并运行 `download-portable.ps1`，按清单组装完整目录。

## 使用与开发

Windows 需 Edge 与 WebView2 Runtime。便携目录包含 Node.js 和 FFmpeg，启动固定名称 `三平台下载器.exe`，整个文件夹一起保留。

开发需要 Node.js、Rust 与 Windows C++ 构建工具，以及 FFmpeg（默认 `D:\Software\ffmpeg\bin\ffmpeg.exe`，可用 `MEDIA_FFMPEG` 指定）。

```powershell
npm ci
npm test
npm run desktop
npm start
npm run portable
```

发布前提交并推送源码，再执行 `npm run release -- --folder=交付\实际便携目录`。发布脚本使用环境变量 `GH_TOKEN` / `GITHUB_TOKEN` 或 Git Credential Manager 的已有登录；不保存或输出凭据。先上传到草稿，全部附件上传后才公开；不覆盖已有发布版本。

## 验证与边界

当前 0.3.0 RC。B站登录后 1080P 合并、小红书图文样例已实测；抖音、小红书视频及三平台登录全过程仍待完整验收。平台权限、安全验证、失效链接和网络限制会影响下载，不保证所有链接可用。只下载自己有权保存的内容。

更新方案参考用户的游戏存档管理器：等待程序退出再替换，失败回滚。本程序额外更新后端代码及运行时；SHA-256 防止损坏，但不是独立数字签名。更新包来自本仓库维护者，RC 版本也在检查范围内。

`数据`、`.runtime`、用户下载、交付产物、参考插件原始包均不进入源码仓库。第三方插件只用于本机分析，不随本项目再发布。包内附 Node.js 和 FFmpeg 的许可证；对应上游为 [Node.js](https://github.com/nodejs/node) 与 [FFmpeg](https://ffmpeg.org/)。项目说明与当前验收记录见 [项目资料](项目资料/开发记录.md)。
