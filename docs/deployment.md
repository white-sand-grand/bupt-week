# 部署

目标形态：**前端在 GitHub Pages，后端在 Cloudflare Workers**，两边独立发布。

```
https://<user>.github.io/<repo>/          ← GitHub Pages（Vite 构建产物）
https://bupt-week.<subdomain>.workers.dev ← Cloudflare Workers（Hono）
```

## 1. 为什么这么分

GitHub Pages 只服务静态文件，跑不了 Node。而本项目必须有服务端（见 README「为什么必须有后端」）。所以是静态前端 + 独立后端。

选 Cloudflare Workers 而不是自己找台 VPS：

- 免费额度对单用户个人工具完全够（10 万次请求/天）
- 不用维护服务器、不用配 HTTPS、不用管进程守护
- Hono 基于 Web 标准，**server/ 下的代码原样跑在 Workers 上**，不需要为部署目标写第二套

**代价与风险，说清楚：**

1. **`workers.dev` 域名在部分校园网/国内网络下不稳定。** 这是真实存在的风险，我不打算假装没有。缓解办法：Workers 可以绑自己的域名（需要你有域名），或者退回到 VPS 部署——后端代码不用改，`npm run server` 即可。
2. **没有文件系统。** 会话存储必须换成 KV。这正是 `createBackend` 把存储做成注入参数的原因。
3. **免费版 Workers 有 CPU 时间限制**（每次请求 10ms CPU，不含等待 IO）。本项目的耗时全在等学校服务器响应，不触这个限制。

## 2. 一次性准备

```sh
# 登录 Cloudflare
npx wrangler login

# 建 KV 命名空间，把输出的 id 填进 wrangler.toml
npx wrangler kv namespace create SESSIONS
```

`wrangler.toml`：

```toml
name = "bupt-week"
main = "server/entries/worker.js"
compatibility_date = "2025-01-01"

[vars]
CORS_ORIGINS = "https://<user>.github.io"

[[kv_namespaces]]
binding = "SESSIONS"
id = "<上一步的 id>"
```

`CORS_ORIGINS` 填你的 Pages 地址。**只填协议+域名+端口，不带路径**——`https://user.github.io` 而不是 `https://user.github.io/BUPT-week/`。CORS 校验的是 origin，不含 path。

## 3. 后端部署

```sh
npm run deploy:worker     # wrangler deploy
```

发布后记下 Workers 地址，形如 `https://bupt-week.<subdomain>.workers.dev`。

### 本地先验证 Workers 行为

```sh
npx wrangler dev          # 本地模拟 Workers 运行时，含 KV
```

**不要跳过这一步直接 deploy。** KV 的最终一致性、`getSetCookie` 的可用性、冷启动行为，都值得在本地先撞一次。

### 国内可达：workers.dev 被墙的两个解法 【实测 2026-10-26】

`*.workers.dev` 在国内被 DNS 污染 + 连接层封锁（本机解析到 Facebook IP，`--resolve` 指真实 CF IP 也是 000），手机蜂窝流量部分运营商能通、家宽/校园网普遍不通。**封的是 `workers.dev` 这个域名，不是 Cloudflare 整体**——绑自定义域名即可绕开。本机实测数据（同一网络）：

| 目标 | 结果 |
|---|---|
| `*.workers.dev` | 000，完全不通 |
| CF 自定义域上的知名服务（gh-proxy.com） | 200，TTFB 3.2s——可达但慢 |
| 腾讯 EdgeOne（edgeone.ai / *.edgeone.app） | 200，0.45–1.7s——腾讯香港节点，国内体验好 |
| 前端 `github.io` | 200，0.95s——前端当前可达，不用动 |

**解法 A：Worker 绑自定义域名（推荐，改动≈0）**

1. 弄一个域名：买一个（.top/.xyz 首年 ¥10 内）或用免费域（如 DigitalPlat dpdns.org，需实名审核，免费域名有失效风险，正式用建议付费）。
2. 域名接入 Cloudflare（免费计划，注册商处改 NS，等 zone 激活）。
3. `wrangler.toml` 加一行路由（zone 激活前 deploy 会报错，先加域再加这行）：

   ```toml
   routes = [{ pattern = "api.<你的域名>", custom_domain = true }]
   ```

4. `npx wrangler deploy`——Cloudflare 自动签证书、建 DNS，无需手动配。
5. 仓库 **Settings → Variables → Actions** 把 `VITE_BACKEND_URL` 从 workers.dev 改成 `https://api.<你的域名>`，推送 master 让 Pages 重建（它是构建期变量，改了必须重构建）。
6. `CORS_ORIGINS`/`FRONTEND_URL` 不用动（前端 origin 没变）；企微回调地址按请求 Host 推导，自动跟随新域。
7. 验收：家宽/校园网无代理打开前端 → 登录 → 看作业，全通。

速度预期：国内用户落到 CF 海外节点，TTFB 1–3s（见实测），晚高峰可能更差。本项目请求本身要多跳学校服务器，占比可接受。想提速可玩 CloudflareSpeedTest 优选 IP，但那是另一个坑，先不展开。

**解法 B：整体迁腾讯 EdgeOne Pages（国内体验最好，半天～一天工作量）**

EdgeOne Pages（腾讯，免费）官方提供 Hono 模板与 CF 迁移文档，默认域 `*.edgeone.app` 免备案、非大陆可用区（香港节点）国内实测可达。迁移点：

- 入口：写 `functions/[[default]].js` catch-all 把请求转给现有 Hono app（约 20 行，`server/app.js` 零改动）。
- KV：EdgeOne KV **key 只允许字母数字下划线**——现有 key 含 `:`（`class:{uuid}:members` 等）和 `-`（UUID），需要一层 key 转义适配器（`storage/` 本来就是注入式，加一个 EdgeOneKvStore 即可）；`put` 无 TTL 参数，但本项目判活靠值内 `expiresAt`（is-live 契约），只影响垃圾回收不影响正确性。
- 全链路重验收：CAS/企微 OAuth/文件代理/深链都要在新域上再点一遍。

结论：先用解法 A 当天解决可用性；EdgeOne 留作国内体验有硬需求时的后续选项。

## 4. 前端部署

前端需要知道后端地址，构建时注入：

```sh
VITE_BACKEND_URL=https://bupt-week.<subdomain>.workers.dev npm run build
```

**只写来源，不带路径、不带尾斜杠。**

GitHub Actions 已配好（`.github/workflows/deploy.yml`），推送到 `master` 自动跑测试、构建、发布。需要做两件事：

1. 仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**
2. 仓库 **Settings → Secrets and variables → Actions → Variables** 新建 `VITE_BACKEND_URL`，值为 Workers 地址

改了 `VITE_BACKEND_URL` 必须重新构建才生效——它是构建期变量，不是运行时变量。

### 仓库名带子路径的情况

如果仓库名不是 `<user>.github.io`，Pages 地址会带子路径（`https://<user>.github.io/BUPT-week/`）。`vite.config.js` 里 `base: './'` 已经处理了这种情况，静态资源用相对路径引用，无需额外配置。

### 自定义域名（可选）

Pages 绑自定义域名：仓库里放 `CNAME` 文件写域名，DNS 加 CNAME 指向 `<user>.github.io`。后端要同步改 `CORS_ORIGINS`。

## 5. 本地开发

```sh
npm ci

# 终端 A
npm run server          # 后端 → 127.0.0.1:8787

# 终端 B
npm run dev             # 前端 → 127.0.0.1:5173，/api 代理到 8787
```

开发时前端与后端**同源**，不需要配 CORS。后端默认只绑 `127.0.0.1`，不暴露到局域网。

### 本机走了代理的话

**Node 的 `fetch` 默认不读 `HTTP_PROXY`。** 如果开发机设了代理环境变量，后端连学校会直接
`ETIMEDOUT`——而 `curl` 是能通的，很容易误判成学校挂了。

两个 npm script 已带上 `NODE_USE_ENV_PROXY=1`（没有代理时它是空动作，无害）。
这个变量**只有 Node 24+ 认识**，Node 20/22 会被静默忽略；老版本要么升 Node，
要么自己用支持代理的方式起服务。

Cloudflare Workers 不受影响——它的 `fetch` 不走系统代理，直连。

> 副作用：`VAR=value cmd` 这种写在 script 里的形式在 Windows `cmd` 下不成立。
> Windows 上请用 PowerShell 设 `$env:NODE_USE_ENV_PROXY=1` 后再手动跑命令，
> 或者直接升到 Node 24 并用 WSL。

## 6. 凭证与会话的运维事实

| 环境 | 会话存哪 | 重启后 | 多实例 |
|---|---|---|---|
| 本机 Node | `.sessions.local.d/`（目录 0700，记录 0600） | 恢复 | 单实例 |
| Workers + KV | KV，带 TTL | 保留 | 多实例共享 |
| Workers 无 KV | 内存 | 丢失 | 不共享 |

**强烈建议配 KV。** 不配的话用户每次冷启动都可能要重新登录——Workers 的 isolate 随时可能被回收，内存会话不可靠。

Node 按键异步落盘，写入成功后接口才返回；同一目录只运行一个后端进程。
升级时旧 `.sessions.local` 会在首次访问存储时自动迁移，全部成功后删除旧文件。
备份应保存整个 `.sessions.local.d/` 目录，迁移前则保存旧文件。

会话 TTL 设 7 天（与 MYUCLOUD 一致）。上游会话可能提前失效，届时提示重新登录即可，不需要更短的 TTL。

### 登录限速

三个登录接口（`/api/auth/login`、`/api/ucloud/login`、`/api/jwgl/login`）内置了
进程内限速：同一来源 IP 10 分钟内密码错 10 次后返回 429。它挡的是单一来源的
低成本爆破；分布式攻击、以及 Workers 多 isolate 各自计数的问题，应用层挡不住。
另外 `/api/auth/wecom/start` 是匿名入口但每次命中都写一条 KV（企微回流的
state 暂存），应用层已按同 IP 10 分钟 30 次限速。上线后建议在 Cloudflare 控制台
给后端域名加一条 **WAF 限速规则**（同 IP 对这四个路径限速），作为外层兜底。

## 7. 发布前检查

- [ ] `npm test` 全绿
- [ ] `npm run test:browser` 全绿（需先 `npx playwright install chromium`）
- [ ] `npx wrangler dev` 下能完成两个系统的登录
- [ ] `CORS_ORIGINS` 已改成真实 Pages 地址，且**不含路径**
- [ ] 无痕窗口打开 Pages 地址，登录 → 看课表 → 看作业 → 点跳转按钮，全通
- [ ] 跳转按钮打开的云邮页面确实是**那一门作业**的提交页，不是列表页也不是首页
- [ ] 后端日志里没有出现密码或完整 token（只允许长度和前后的 redact 形式）

## 8. 浏览器测试

部署前除了接口测试，还要过一遍真实浏览器——接口测试覆盖不到 blob 落盘、`<a download>`
的文件名、以及 CORS 在真实浏览器里的放行/拦截。

```sh
npx playwright install chromium   # 只需完整的 chromium 构建
npm run test:browser
```

它内部会自己起后端、Vite dev server 和两个跨域静态源，不需要你手动准备。
chromium 装不上的机器上这条会直接报错并提示安装命令，不会假装通过。

## 9. 出问题时先看哪里

| 现象 | 先查 |
|---|---|
| 前端白屏，Console 报 CORS | `CORS_ORIGINS` 是否含路径 / 是否少了协议 |
| 登录一直失败，stage 在 `cas-get` | 校园网能否直连 `auth.bupt.edu.cn` |
| 报 `cas-connect` 且提到代理 | 开发机走了代理但 Node 的 fetch 不读它，见第 5 节 |
| 能登录但课表空 | 教务处会话过期，重新登录 |
| 作业列表空，课表正常 | 云邮 token 过期且续期失败 |
| 跳转按钮打开了登录页 | 用户浏览器没有云邮会话，属预期，登一次 |
| Workers 偶尔 500 | `wrangler tail` 看实时日志 |
