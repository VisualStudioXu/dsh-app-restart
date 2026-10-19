# dsh-app-restart

给 DeepSeek Harness 桌面端加一个**能真正重启整个应用**的按钮，落在界面最底部单独一行。

## 为什么需要它

渲染层到 Electron 主进程**没有任何重启 IPC**。换句话说，官方没有提供让插件触发重启的通道：

- `lib/preload-app.cjs` 的 `DESKTOP_IPC`（26 个）与 `PLATFORM_IPC`（5 个）里没有重启；
- host 侧 `process.send` 只被 `isDesktopHostEvent`（`main.js:3664`）接受 6 种消息，其余一律走
  `this.fail(...)` 再 `child.kill("SIGTERM")` —— 那是崩溃路径，不是重启；
- 主进程里仅有的两处 `app.relaunch()` 分别挂在崩溃恢复框（`main.js:11845`）和打包版不存在的
  开发菜单（`main.js:12768`）上，插件都够不到。

所以本插件自己动手：先停主进程让宿主优雅退出，再自动拉起整个应用。

## 装上之后得到什么

界面底部（`shell.bottom` 槽，全宽横条）多出一条「⟳ 重启 DeepSeek Harness」，点击后：

1. 弹二次确认（防误触）；
2. 确认后 helper 进程先停 Electron 主进程 —— 主进程一死，与 host 的 IPC 断开，
   host 的 `process.once('disconnect')`（`dsh-desktop-host/lib/index.js:325`）触发
   `shutdown.shutdown(0)`，优雅退出；
3. 孤儿的 renderer / gpu 进程按 `ParentProcessId` 递归补收；
4. 拉起新的应用实例。

实测一轮约 5.4 秒，全程无残留进程。

## 关键实现细节（都是踩出来的）

### `taskkill /T` 会把 helper 自己杀掉

第一版用 `taskkill /PID <main> /T /F` 一次收掉整棵树。结果 **helper 自己也死了**。
Windows 的 `taskkill /T` 递归整条父子链，`detached: true` **挡不住它** —— 连「helper 的孙进程」
都会被一起杀掉。于是 helper 刚打印 `killing main process tree` 就消失，永远走不到 relaunch。

现在去掉 `/T`，改为：先停 main，让 host 靠 disconnect 自行退出，再用 `wmic` 按
`ParentProcessId` 递归补收孤儿进程。

### `spawn` 失败是异步事件，`try/catch` 抓不到

目标可执行文件不存在时，`spawn` 抛的是**异步 `error` 事件**，不是同步异常。
不挂 `child.on('error', ...)` 就会变成 `Unhandled 'error' event` 直接把 helper 崩掉。
现在挂了监听并保留 `cmd /c start` 兜底。

### 改代码后必须重启宿主才能验证

`client.js` 由浏览器每次从 `/plugins/` 拉取，改完刷新即生效；但 `index.js` 由 **host 进程启动时
require**，不重启 host 不换代码。第一次修完仍然失败，就是因为「界面变了」被误判成「代码已生效」，
而 host 跑的还是旧代码。

## 安装

走官方插件市场的「添加插件」：

```
https://github.com/VisualStudioXu/dsh-app-restart
```

或在 profile 的 `package.json` 里加：

```bash
cd ~/.dsh/profiles/desktop
pnpm add github:VisualStudioXu/dsh-app-restart
```

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半：拉起 helper、停主进程、重新启动 |
| `client.js` | Client 半：`shell.bottom` 横条 UI 与二次确认 |
| `cordis.patch.yml` | bundle 补丁，声明插件挂载点 |
| `locale/{zh,en}.json` | 卡片标题与描述（顶层 `meta` 包裹） |
| `icon.svg` | 原创图标 |

## License

MIT
