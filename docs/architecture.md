# 架构

## 1. 总体数据流

```
浏览器                         本后端                        学校
──────                      ──────                       ─────
输入学号/密码
  │
  ├─ POST /api/jwgl/login ──► jwglLogin()                  jwgl.bupt.edu.cn
  │                            encodeInp(id)+%%%+encodeInp(pw)
  │                            POST /jsxsd/xk/LoginToXk
  │                            ◄─ Set-Cookie (3 次请求合并)
  │                            GET  /jsxsd/xspj/xspj_find.do  ← 验证登录
  │ ◄─ { sessionId, expiresAt }
  │
  ├─ POST /api/jwgl/timetable {sessionId, week}
  │                          GET /jsxsd/framework/xsdPerson.jsp?xkzc=N
  │                          parseTimetable(html)
  │ ◄─ { week, days, periods, courses }
  │
  ├─ POST /api/ucloud/login ─► casLogin()                  auth.bupt.edu.cn
  │                            GET  /authserver/login?service=…
  │                              取 execution / type / _eventId + Cookie
  │                            POST 同 URL（redirect: manual）
  │                            ◄─ 302 Location: …?ticket=ST-xxx
  │                          exchangeToken(ticket)          apiucloud.bupt.edu.cn
  │                            POST /ykt-basics/oauth/token
  │                            ◄─ { access_token, refresh_token }
  │ ◄─ { sessionId, expiresAt }
  │
  ├─ GET /api/ucloud/assignments {sessionId}
  │                          GET /ykt-site/work/student/list (Blade-Auth)
  │ ◄─ [ { id, title, courseName, deadline, … } ]
  │
  └─ 用户点"去交作业"
       window.open(云邮深链) ──────────────────────────────► ucloud.bupt.edu.cn
```

前端只跟 `VITE_BACKEND_URL` 说话，**从不直接出现学校域名**。

## 2. 两个登录态

| | 教务处（jwgl） | 云邮（ucloud） |
|---|---|---|
| 会话标识 | `sessionId`（UUID） | `sessionId`（UUID） |
| 服务端存什么 | Cookie 串 | `access_token` + `refresh_token` + `userId` |
| 有效期 | 服务端 7 天，上游可能提前失效 | `access_token` 约 2 小时，`refresh_token` 更长 |
| 续期方式 | 上游会话自然延续，失效则重新登录 | `grant_type=refresh_token` 静默换新 |
| 过期表现 | 返回登录页 HTML 或 401/403 | 401 |

两者在 localStorage 用**不同的 key**存放，互不影响。任一方过期只禁用对应模块，不清空另一个。

### 云邮的静默续期

`access_token` 只有约 2 小时（`expires_in: 7199`）。如果不做续期，用户每两小时就要重新登录一次，不可用。

做法：后端持有 `refresh_token`，检测到 401 时自动 `grant_type=refresh_token` 换新的 `access_token` 并重试原请求，然后更新会话存储。前端完全无感。

这个机制不是我发明的——云邮前端自己就是这么做的（见 `docs/api-reference.md` 1.3 节）。照抄即可。

## 3. 会话存储：注入而不是写死

`server/app.js` 导出工厂而不是单例：

```js
export function createBackend({ getSessionStore, allowedOrigins }) { … }
```

三个存储实现，接口相同（`get` / `set` / `delete`，`get` 时顺带剔除过期项）：

| 实现 | 用在哪 | 文件 |
|---|---|---|
| `MemorySessionStore` | 单元测试 | `server/storage/memory.js` |
| `FileSessionStore` | 本机 `npm run server` | `server/storage/file.js` |
| `KvSessionStore` | Cloudflare Workers | `server/storage/kv.js` |

**约束：`server/` 下除 `storage/file.js` 外禁止 import `node:*`。** 这条约束是"同一份代码跑 Node 和 Workers"的前提，违反它 Workers 部署会直接挂。

会话文件权限 `0600`，文件名加 `.local` 后缀确保被 `.gitignore` 挡住。

## 4. 安全边界

### 密码流向

```
用户浏览器 ──HTTPS──► 本后端 ──HTTPS──► 学校
                       （唯一经手密码的环节）
```

- 前端**不存储密码**，登录成功后立即从内存丢弃。
- 后端不落盘密码，只在请求内存里存活。
- 服务端会话存的是**派生凭证**（Cookie / token），不是密码。

### 前端存什么

| 数据 | 存哪 | 说明 |
|---|---|---|
| `jwgl.sessionId` | `localStorage` | 不透明标识，泄露了也只能调到自己的课表 |
| `ucloud.sessionId` | `localStorage` | 同上 |
| 学号 | `localStorage` | 仅用于 UI 显示 |
| 密码 | **不存** | |
| `Blade-Auth` / `refresh_token` | **不存前端** | 只存在于服务端会话中 |

这一条是相对 MYUCLOUD 的**刻意收紧**：MYUCLOUD 把 `Blade-Auth` token 放在前端 localStorage，本项目改为服务端持有，前端只拿不透明 `sessionId`。代价是每次请求多一跳服务端查询，收益是 token 不暴露给 XSS。

### CORS

后端默认只允许自己的 Pages 来源。跨域配置覆盖 JSON、鉴权头、文件 Range 请求；登录凭证走请求头/请求体，**不依赖跨站 Cookie**。所有响应（含未命中白名单的）都带 `Vary: Origin`，防止共享缓存把无 CORS 头的响应错发给放行来源。

### 其他边界（2026-10-24 安全审查后固化）

| 机制 | 位置 | 作用 |
|---|---|---|
| 企微 state 一次性绑定 | `routes/auth.js` | start 把 CAS state 存 HttpOnly+Secure cookie，callback 对不上即拒绝——回流必出自本站发起的流程 |
| 前端地址只认白名单 | `routes/auth.js` | `/wecom/start` 的 Referer 必须命中 `CORS_ORIGINS` 才种前端 cookie，防 sessionId 被 302 到任意地址 |
| 登录限速 | `rate-limit.js` | 同 IP 10 分钟 10 次密码错后 429（只数 401）；分布式攻击靠 Cloudflare WAF 兜底 |
| `/file` 来源准入 | `routes/proxy.js` | 带 Origin/Referer 的请求必须命中白名单（回环放行供本机开发），防外链滥用 |
| 未知异常兜底 | `app.js` | 非 ApiError 异常响应固定文案，内部细节只进日志 |
| 密码可证明不留痕 | `tests/privacy.test.js` | 断言密码不进响应体、不进三种会话存储、不进日志、失败不回显 |

## 5. 错误处理约定

所有 `/api/*` 返回统一形状：

```json
{ "success": true,  "data": { … } }
{ "success": false, "msg": "人话错误信息", "stage": "cas-login" }
```

`stage` 只在登录链路出现，取值与含义见 `docs/api-reference.md`。前端把 `msg` 直接展示给用户，**不要**把 `stage` 或原始堆栈透出。

上游不可达时，错误信息要能告诉用户"连不上哪个域名"，而不是一句 `fetch failed`。

## 6. 前端状态

不引状态管理库。三个 `ref` / `reactive` 足够：

- `jwglAuth` — `{ sessionId, username, expiresAt }`
- `ucloudAuth` — `{ sessionId, username, expiresAt, realName }`
- `timetableCache` — 已同步的周次，按 `username + mode` 隔离

课表缓存策略借鉴 MYUCLOUD：**按周增量写入 localStorage**，中途断网或过期都不丢已拿到的周次。这一点对校园网体验很重要，值得保留。

## 7. 目录结构

```
src/                         前端（构建到 dist/，部署到 Pages）
├── main.js
├── App.vue
├── api/
│   ├── client.js            与后端通信的唯一出口
│   ├── jwgl.js
│   └── ucloud.js
├── composables/
│   ├── useJwglAuth.js
│   └── useUcloudAuth.js
├── components/
│   ├── LoginPanel.vue       两个系统的登录（同一组件，配置不同）
│   ├── TimetableGrid.vue    课表网格
│   ├── TimetablePage.vue    周次切换 + 同步
│   ├── AssignmentList.vue   作业列表
│   └── AssignmentCard.vue   单条作业 + 跳转按钮
└── utils/
    └── deadline.js          截止时间分级（借鉴 MYUCLOUD）

server/                      后端（Node 与 Workers 通用）
├── app.js                   createBackend 工厂
├── http.js                  ApiError / readJson
├── cors.js
├── services/
│   ├── ucloud.js            CAS → ticket → OAuth + 业务接口 + 静默续期
│   └── jwgl.js              教务处登录 + 课表
├── parsers/
│   └── timetable.js         课表 HTML 解析（从 MYUCLOUD 移植）
├── storage/
│   ├── memory.js
│   ├── file.js              （唯一允许 node:fs 的文件）
│   └── kv.js
├── routes/
│   ├── api.js               /api/ucloud/*、/api/jwgl/*
│   └── proxy.js             /file/* S3 代理
└── entries/
    ├── node.js              npm run server 入口，注入 FileSessionStore
    └── worker.js            wrangler 入口，注入 KvSessionStore
```
