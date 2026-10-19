/**
 * dsh-app-restart — Host 半。
 *
 * 为什么需要它：渲染层到 Electron 主进程**没有任何重启 IPC**。
 * `lib/preload-app.cjs` 的 DESKTOP_IPC（26 个）与 PLATFORM_IPC（5 个）里没有重启；
 * host 侧 `process.send` 也只被 `isDesktopHostEvent`（main.js:3664）接受 6 种消息，
 * 其余一律走 `this.fail(...)` 再 `child.kill("SIGTERM")`——那是崩溃路径，不是重启。
 * 主进程里仅有的两处 `app.relaunch()` 分别挂在崩溃恢复框（main.js:11845）
 * 和打包版不存在的开发菜单（main.js:12768）上，插件都够不到。
 *
 * 因此本插件自己动手。已实测确认的进程事实：
 *   host 的父进程就是 Electron 主进程，即 `process.ppid`；
 *   两者是同一个可执行文件。
 *
 * ── 关键教训（第一版失败的原因，已实测复现）──────────────────
 * 第一版用 `taskkill /PID <main> /T /F` 一次收掉整棵树。结果：**helper 自己也被杀了**。
 * 实测证明（scripts/20261018-probe-tree-escape.mjs、-real-chain.mjs）：
 *   Windows 的 `taskkill /T` 递归整条父子链，**`detached: true` 挡不住它**——
 *   连「helper 的孙进程」都会被一起杀掉。
 * 于是 helper 刚打印 "killing main process tree" 就死了，永远走不到 relaunch
 * （现场日志 ~/.dsh/logs/app-restart.log 恰好断在这一行）。
 *
 * 修法：**不带 `/T`**。scripts/20261018-probe-no-tree-kill.mjs 实测：
 * 无 /T 分别杀 host 与 main 时，helper 两次都幸存。
 * 代价是 main 的 renderer/gpu 子进程可能成为孤儿，故由 helper 在杀完后
 * 用 wmic 按 ParentProcessId 补收。
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 插件显示名。cordis 的 `Fiber.name` 取自它，而非 loader 的行 id；
 *  不导出时日志（如 fiber-watch）里该插件会沿父级链显示为父节点名，
 *  排查时找不到它。导出后即可在 fiber 日志中按名检索。 */
export const name = 'app-restart'

/** 依赖 webServer 注册路由；缺少它时这条路由不会挂上。 */
export const inject = ['webServer']

/** 与客户端约定的路由路径。 */
const ROUTE = '/app-restart/api/restart'

/** 重启前的标准延时（毫秒）：留给浏览器渲染「正在重启…」并让 HTTP 响应落地。 */
const DEFAULT_DELAY_MS = 700

/**
 * 只接受同源请求：重启不可逆，绝不能被跨站页面触发。
 * @param request - Node HTTP 请求。
 * @returns 请求是否来自应用自身。
 */
function sameOrigin(request) {
  const origin = request.headers.origin
  if (origin === undefined || origin === null || origin === '') return true // 同源导航不带 Origin
  const host = request.headers.host
  if (typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 构造重启助手脚本。
 *
 * @param options - 目标进程、可执行文件与延时。
 * @returns 可直接交给 node 执行的脚本源码。
 */
function helperSource(options) {
  const { hostPid, mainPid, appExe, delayMs, logFile } = options
  // 用 JSON 序列化把关，避免路径里的引号破坏脚本。
  return `
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')

const hostPid = ${JSON.stringify(hostPid)}
const mainPid = ${JSON.stringify(mainPid)}
const appExe = ${JSON.stringify(appExe)}
const logFile = ${JSON.stringify(logFile)}
const delayMs = ${JSON.stringify(delayMs)}

function log(message) {
  try { fs.appendFileSync(logFile, new Date().toISOString() + ' ' + message + '\\n') } catch {}
}

function alive(pid) {
  const r = spawnSync('tasklist', ['/FI', 'PID eq ' + String(pid), '/NH'], {
    encoding: 'utf8', windowsHide: true,
  })
  return typeof r.stdout === 'string' && r.stdout.includes(String(pid))
}

// 从父进程继承的环境里必须去掉 ELECTRON_RUN_AS_NODE：
// 否则重新拉起的 exe 会以「node 模式」运行，而不是正常启动应用。
function appEnv() {
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

// 收走某个 PID 的全部子进程（main 被单杀后可能留下的 renderer/gpu 孤儿）。
function reapChildren(pid) {
  try {
    const r = spawnSync('wmic', ['process', 'where', 'ParentProcessId=' + String(pid), 'get', 'ProcessId'],
      { encoding: 'utf8', windowsHide: true })
    const ids = String(r.stdout || '')
      .split(/\\s+/)
      .map((x) => parseInt(x, 10))
      .filter((n) => Number.isInteger(n) && n > 0)
    for (const id of ids) {
      reapChildren(id)               // 先收孙子，避免它们被重新挂到别处
      spawnSync('taskkill', ['/PID', String(id), '/F'], { stdio: 'ignore', windowsHide: true })
    }
    if (ids.length) log('reaped ' + ids.length + ' orphan(s) of ' + pid)
  } catch (error) {
    log('reap failed for ' + pid + ': ' + error.message)
  }
}

log('helper started; host=' + hostPid + ' main=' + mainPid + ' exe=' + appExe)
log('helper pid=' + process.pid + ' — 注意：不带 /T，因为 detached 挡不住 /T 的进程树递归')

setTimeout(() => {
  // 关键：不带 /T。带 /T 会递归整条父子链，把 helper 自己也一起杀掉（已实测）。
  //
  // 顺序也有讲究：先停 main。main 一死，它与 host 之间的 IPC 通道断开，
  // host 的 process.once('disconnect') 处理（dsh-desktop-host/lib/index.js:325）
  // 会触发 stop() → shutdown.shutdown(0)，走的是**优雅关停**，
  // 比直接硬杀能少丢一点未落盘状态。
  log('stopping main ' + mainPid + ' (host should self-exit on disconnect)')
  spawnSync('taskkill', ['/PID', String(mainPid), '/F'], { stdio: 'ignore', windowsHide: true })

  let hostStoppedGracefully = false
  // 给 host 最多 4.5 秒自己优雅退出；超时才硬杀。
  setTimeout(() => {
    if (alive(hostPid)) {
      log('host still alive after grace period; forcing ' + hostPid)
      spawnSync('taskkill', ['/PID', String(hostPid), '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      hostStoppedGracefully = true
      log('host exited gracefully on disconnect')
    }
    // main 单杀后 renderer/gpu 可能成孤儿；补收。
    reapChildren(mainPid)
    if (!hostStoppedGracefully) reapChildren(hostPid)
  }, 4500)

  const deadline = Date.now() + 12000
  const tick = setInterval(() => {
    const mainAlive = alive(mainPid)
    const hostAlive = hostPid ? alive(hostPid) : false
    if ((!mainAlive && !hostAlive) || Date.now() > deadline) {
      clearInterval(tick)
      if (mainAlive || hostAlive) {
        log('still alive at deadline; main=' + mainAlive + ' host=' + hostAlive + ' -> forcing')
        if (mainAlive) spawnSync('taskkill', ['/PID', String(mainPid), '/F'], { stdio: 'ignore', windowsHide: true })
        if (hostAlive) spawnSync('taskkill', ['/PID', String(hostPid), '/F'], { stdio: 'ignore', windowsHide: true })
      } else {
        log('processes exited')
      }
      setTimeout(() => {
        log('relaunching ' + appExe)
        // spawn 的失败是**异步 error 事件**，try/catch 抓不到；
        // 不挂 'error' 监听会让整个 helper 进程崩掉（干跑已实测：
        // Error: spawn <exe> ENOENT → Unhandled 'error' event）。
        try {
          const child = spawn(appExe, [], {
            detached: true,
            stdio: 'ignore',
            env: appEnv(),
            windowsHide: false,
          })
          child.on('error', (error) => {
            log('relaunch FAILED (error event): ' + (error && error.message ? error.message : String(error)))
            // 最后兜底：交给系统 shell 再试一次（explorer 对已安装应用更宽容）。
            try {
              spawnSync('cmd', ['/c', 'start', '', appExe], { stdio: 'ignore', windowsHide: true })
              log('fallback relaunch via cmd start attempted')
            } catch (fallbackError) {
              log('fallback relaunch failed: ' + fallbackError.message)
            }
          })
          child.unref()
          log('relaunch issued pid=' + (child.pid === undefined ? '(awaiting)' : child.pid))
        } catch (error) {
          log('relaunch threw synchronously: ' + error.message)
        }
      }, 1500)
    }
  }, 350)
}, delayMs)
`.trim()
}

/**
 * 排定一次整应用重启。
 *
 * @param ctx - Host 上下文，用于记录日志。
 * @returns 目标进程信息。
 */
function scheduleRestart(ctx) {
  const hostPid = process.pid
  const mainPid = process.ppid

  if (!mainPid) {
    throw new Error('app-restart: 无法确定 Electron 主进程（process.ppid 为空）')
  }

  const logFile = join(homedir(), '.dsh', 'logs', 'app-restart.log')

  const source = helperSource({
    hostPid,
    mainPid,
    appExe: process.execPath,
    delayMs: DEFAULT_DELAY_MS,
    logFile,
  })

  const child = spawn(process.execPath, ['-e', source], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()

  try {
    ctx.logger?.info?.(`[app-restart] 已排定重启：host=${hostPid} main=${mainPid}`)
  } catch {
    /* 日志失败不影响重启 */
  }

  return { hostPid, mainPid }
}

/**
 * @param ctx - Host 上下文。
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (request, response) => {
      const send = (status, body) => {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify(body))
      }

      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!sameOrigin(request)) {
        send(403, { error: 'cross-origin restart rejected' })
        return
      }

      try {
        const scheduled = scheduleRestart(ctx)
        send(202, { ok: true, ...scheduled })
      } catch (error) {
        send(500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dsh-app-restart: restart route')
}
