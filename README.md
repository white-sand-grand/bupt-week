# BUPT-week

只做三件事的课表 / 作业查看器：**查课表、看作业、给出交作业的直达跳转链接**。

不实现评教、不实现站内提交作业、不做空教室查询、不做成绩查询。

---

## 为什么必须有后端

GitHub Pages 只能托管静态文件，跑不了服务。而本项目**必须**有服务端，原因不是偏好，是硬约束：

1. **读不到 CAS 的 302 Location。** 浏览器里 `fetch(url, { redirect: 'manual' })` 拿到的是一个 opaque redirect 响应，`Location` 头被浏览器吃掉，JS 拿不到。而 UCloud 登录的第二步就是要从 `Location` 里取 `ticket`。这一步只能在服务端做。
2. **Cookie 罐。** 云邮登录和教务处登录都要跨 2~3 个请求携带并合并 `Set-Cookie`，服务端做这件事远比在浏览器里可靠。
3. **`/file` 域名防盗链。** `fileucloud.bupt.edu.cn` 是 S3 兼容存储，校验 `Origin` / `Referer`，并且**拒绝携带 `Authorization` / `Blade-Auth` 等鉴权头**（收到非 AWS4 签名直接报 `InvalidRequest`）。浏览器无法同时满足"带头"和"不带头"，必须由服务端代理。

所以架构是**前后端分离**：

```
GitHub Pages（静态）                 Cloudflare Workers（Hono）
┌─────────────────────┐            ┌──────────────────────────┐
│  Vue 3 + Vite       │  HTTPS     │  /api/ucloud/*           │
│  · 课表网格          │ ─────────> │  /api/jwgl/*             │
│  · 作业列表          │  JSON      │  /file/*   （S3 代理）    │
│  · 交作业跳转按钮     │            │                          │
└─────────────────────┘            │  上游：                   │
                                   │  ucloud.bupt.edu.cn       │
  不接触学校域名，                   │  apiucloud.bupt.edu.cn    │
  不持有任何密码                      │  jwgl.bupt.edu.cn        │
                                   └──────────────────────────┘
```

前端**永远不直接请求学校域名**，只跟自己的后端说话。后端地址在构建时通过 `VITE_BACKEND_URL` 注入（见 [`docs/deployment.md`](docs/deployment.md)）。

---

## 技术栈选择

| 层 | 选型 | 理由 |
|---|---|---|
| 前端 | Vue 3 + Vite | 与 MYUCLOUD 同栈，抓取逻辑可以对照移植；`base: './'` 适配 Pages |
| 后端 | Hono | 与 MYUCLOUD 同栈；Hono 基于 Web 标准，**同一份代码既能跑 Node 也能跑 Cloudflare Workers**，不需要为 Pages 方案单独重写 |
| 后端托管 | Cloudflare Workers | 免费额度对个人够用；无需自己维护服务器。备选：任何能跑 Node 的 VPS，代码不用改 |

选 Hono 而不是 Express 的关键原因：`createBackend({ getSessionStore, allowedOrigins })` 这个工厂把**会话存储做成注入参数**。本地开发注入 Node 文件存储，Workers 上注入 KV 存储，业务代码一行不改。这正是 MYUCLOUD 已经做对的设计，直接借。

---

## 两个系统，一套登录

这是本项目最重要的架构事实，一开始就要接受：

| 数据 | 来源系统 | 凭证形式 |
|---|---|---|
| **课表** | `jwgl.bupt.edu.cn`（教务处 PC 版） | 会话 Cookie |
| **作业** | `ucloud.bupt.edu.cn`（云邮教学空间） | OAuth `access_token` + `refresh_token` |

两个系统是不同的服务、凭证互不通用，但**共用同一套统一身份认证（CAS）**——
实测两者都是注册过的 CAS service。所以前端只有一个登录表单，一次认证分别取两个
service 的 ticket。任一侧过期只影响对应功能，不级联。

---

## 核心功能：交作业跳转链接

这是本项目区别于"再做一个 MYUCLOUD"的地方，也是唯一需要认真逆向的部分。

我拉了云邮前端真实的 JS bundle（`course.js` + chunk 21 + chunk 49），把路由表和作业详情页的初始化逻辑读出来了，结论是：

**云邮的作业详情页在 `mounted` 时从 `$route.query` 读 `assignmentId`，并立即用它请求作业基本信息。** 所以深链不需要任何额外状态：

```
https://ucloud.bupt.edu.cn/uclass/course.html#/student/assignmentDetails_fullpage?activeTabName=first&assignmentId=<作业ID>
```

打开就是该作业的详情/提交页。

另外还发现一条**带鉴权的深链**，能顺带解决"作业列表页读不到 `site-id` cookie"的问题：

```
https://ucloud.bupt.edu.cn/uclass/course.html#/student/courseHomePage?siteId=<课程ID>&roleId=<roleId>&refresh_token=<refresh_token>
```

证据、参数逐个的含义、以及安全权衡，见 [`docs/api-reference.md`](docs/api-reference.md)。

---

## 快速开始

```sh
npm ci

# 终端 A：后端（本机，只绑 127.0.0.1）
npm run server          # → http://127.0.0.1:8787

# 终端 B：前端（同源，无需配 CORS）
npm run dev             # → http://127.0.0.1:5173
```

页面显示「后端已连接」即说明 前端 → Vite 代理 → 后端 → JSON 形状 这条链路是通的。

### 当前进度

第 0 期（脚手架与登录实验）已完成，并额外落地了**作业附件下载**的后端与前端模块：

| 能力 | 状态 |
|---|---|
| 后端工厂、三种会话存储、双入口 | ✅ |
| `/file` 代理（S3 防盗链绕过、Range、防穿越） | ✅ |
| 附件下载接口 `POST /api/ucloud/resource/download` | ✅ |
| 前端 `downloadResource(resourceId, filename)` | ✅ |
| 挂到作业卡片上 | ⬜ 等第 3 期作业列表 |
| **统一登录**（一个表单，一次认证登两个系统） | ✅ |
| CAS SSO 双 ticket（一次认证，两个 service） | ✅ |
| 教务处 CAS 入口（ticket → 会话） | ⬜ 端点待校园网验证，已配 `encodeInp` 回退 |
| 企业微信 / 微信内自动识别 | ✅ 骨架 + 实测跳转，回流后两步待你在微信里验 |
| token 静默续期（`access_token` 约 2 小时） | ✅ |

147 个接口测试 + 25 个浏览器测试全绿，Node 与 Workers 两条入口都验证过。
浏览器侧验过的包括：Vue 应用真的挂载、下载落盘且文件名是附件名、CORS 放行与拦截、
登录态在刷新后保持、localStorage 里只有 sessionId。

**尚未实现**：课表（第 2 期）、作业列表（第 3 期）。顺序见 [`docs/roadmap.md`](docs/roadmap.md)。

### 还没能验证的

- **真实学号密码登录两个系统。** 我用不存在的学号打过真的 CAS，拿到了
  `Invalid credentials.` + `stage: cas-login`，说明整条链路是通的；但**成功**
  登录需要你的凭证。教务处上游（`jwgl.bupt.edu.cn`）从我这台机器不可达，
  需要在校园网内试。
- **`grant_type=password` 能否直连**（第 0 期实验 A）。当前走的是 CAS 三步，
  MYUCLOUD 已验证过这条路。

附件下载的链路与为什么必须经服务端，见 [`docs/api-reference.md`](docs/api-reference.md) 2.6–2.8 节。

```sh
npm test            # 147 个接口/单元测试，不需要浏览器
npm run test:browser # 14 个浏览器测试，需要 chromium
npm run build       # 前端构建，产物在 dist/（相对路径，适配 Pages）
npx wrangler dev    # 本地 Workers 运行时，与 Node 入口共用同一份 server/
```

首次跑浏览器测试前：`npx playwright install chromium`。只装完整的 chromium 构建即可，
`chrome-headless-shell` 下载失败不影响——测试用 `channel: 'chromium'` 指定完整构建。

---

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | 双系统登录、数据流、会话与凭证模型、安全边界 |
| [`docs/api-reference.md`](docs/api-reference.md) | 逆向验证过的全部接口与深链，**标注了哪些是实测、哪些待验证** |
| [`docs/deployment.md`](docs/deployment.md) | GitHub Pages + Cloudflare Workers 部署，含 KV 会话存储 |
| [`docs/roadmap.md`](docs/roadmap.md) | 分期实施计划与每期验收标准 |
| [`docs/unified-login-plan.md`](docs/unified-login-plan.md) | 统一登录与企业微信登录的调研结论与方案 |

## 参考实现

- [AuceptinFang/MYUCLOUD](https://github.com/AuceptinFang/MYUCLOUD) — 主要参考。登录流程、课表解析器、截止时间分级直接借鉴。
- [Nemoyuzx/where_to_study](https://github.com/Nemoyuzx/where_to_study) — 参考其"截止时间是时刻不是时长"的时间规范化，以及已读作业的去重基线语义。

## 免责

本项目是个人便利工具，通过学校公开的 Web 接口读取自己的数据。请勿用于代查他人数据或任何违反学校规定的用途。凭证只保存在服务端会话存储中，不落库、不外传。
