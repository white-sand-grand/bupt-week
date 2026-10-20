# 第 0 期实施计划（文件级）

本文是 `roadmap.md` 第 0 期的展开。目标只有一个：**把最不确定的技术风险排掉，并留下一个能跑、能验的地基**。

不写业务代码。第 0 期结束时，`/api/health` 能通、三种会话存储能跑、Workers 边界有测试守着，但没有登录、没有课表、没有作业。

---

## 为什么是这个顺序

第 0 期要回答两个问题，它们决定了后面所有的写法：

1. **`grant_type=password` 能不能用** —— 能用，登录层从三步塌缩成一步；不能用，就按 CAS 三步写，MYUCLOUD 已经跑通，有 fallback。
2. **`refresh_token` 能不能连续续期** —— 能，用户登一次管几天；不能，每 2 小时重登，必须缩短会话 TTL 并在 UI 上说明。

这两个是**实验**，不是实现，用 curl 就能验，不需要先搭完整脚手架。但脚手架是实验的载体（要在 Workers 环境下试 `getSetCookie`），所以顺序是：**先搭地基 → 再做实验 → 按实验结果写第 1 期**。

---

## 文件清单

### 后端 `server/` —— 约束：除 `storage/file.js` 外禁止 `import ... from 'node:*'`

这条约束是「同一份代码跑 Node 和 Workers」的前提，用测试守着（见下）。违反它的表现是 Workers 部署直接挂，而本地完全正常——这类 bug 极其难查，必须前置防御。

| 文件 | 职责 | 关键点 |
|---|---|---|
| `server/http.js` | `ApiError` + `readJson` | 错误统一成 `{success:false, msg, stage?}` |
| `server/cors.js` | 跨域中间件 | origin 精确匹配，**不含路径** |
| `server/app.js` | `createBackend({ allowedOrigins })` 工厂 | 第 0 期只收跨域配置；`getSessionStore` 注入参数等第 1 期有路由消费它时再加，不留没人读的参数 |
| `server/storage/memory.js` | 内存存储 | 测试用；`get` 时惰性剔除过期项 |
| `server/storage/file.js` | 文件存储 | **唯一允许 `node:fs` 的文件**；`0600` 权限、`.local` 后缀 |
| `server/storage/kv.js` | KV 存储 | 内存 L1 + KV L2 写穿透，规避最终一致性 |
| `server/routes/proxy.js` | `/file/*` S3 代理 | 设 Origin/Referer、**删掉鉴权头**、剥掉上游 CORS 头、防路径穿越 |
| `server/services/resources.js` | 附件下载地址解析 | `preview-url` → `/file` 路径；只认 fileucloud 域名 |
| `server/routes/api.js` | 本站业务接口 | `POST /api/ucloud/resource/download` |
| `server/entries/node.js` | `npm run server` 入口 | 注入 `FileSessionStore`，默认只绑 `127.0.0.1` |
| `server/entries/worker.js` | `wrangler` 入口 | 注入 `KvSessionStore`（未绑 KV 时退内存存储并告警） |

**本期不建** `services/jwgl.js`、`services/ucloud.js`、`parsers/` —— 它们是第 1、2 期的内容。留空目录比留空文件好。

> 附件下载（`services/resources.js` + `routes/api.js` + `src/api/files.js`）是第 0 期之后单独加的，
> 因为它只依赖已经建好的 `/file` 代理和会话存储，不依赖登录态的产生。

### 前端 `src/`

| 文件 | 职责 |
|---|---|
| `index.html` | 挂载点 |
| `src/main.js` | `createApp` + 引入样式 |
| `src/App.vue` | 外壳 + 后端健康状态指示（第 0 期唯一 UI） |
| `src/api/client.js` | **与后端通信的唯一出口** |
| `src/styles.css` | 最小样式 |

`client.js` 是本期的隐藏重点。它把「后端地址可能是空（同源）也可能是跨域」这件事收敛到一个地方，后面所有 API 调用都走它，不各自拼 URL。

### 测试 `tests/`

| 文件 | 断言什么 |
|---|---|
| `tests/server-boundaries.test.js` | ① 只有 `storage/file.js` 能 import `node:*`；② 从 `entries/worker.js` 出发做 import 图遍历，**不可达**任何 `node:*` |
| `tests/storage.test.js` | 三种存储的 set/get/delete/过期行为；`FileSessionStore` 跨实例恢复 |

第 ② 条是关键：它防的不是「有人写了 node:fs」，而是「有人让 worker.js 传递依赖到了 node:fs」——后者才是真实会发生的事故。

### 配置

| 文件 | 改动 |
|---|---|
| `package.json` | 加 `@hono/node-server`、`test` 脚本 |
| `vite.config.js` | 加 `/api`、`/file` 开发代理到 `127.0.0.1:8787` |
| `CLAUDE.md` | 新建，记下不变量与「先读哪篇文档」 |

---

## 验收判据

```sh
npm install
npm test                      # 45 个测试全绿
npm run server &              # 127.0.0.1:8787
curl -s 127.0.0.1:8787/api/health
npm run dev                   # 127.0.0.1:5173，页面显示后端已连接
npx wrangler dev              # 本地 Workers 运行时，同样能通 /api/health
```

### 实际结果（2026-10-20）

| 判据 | 结果 |
|---|---|
| `npm test` | ✅ 45/45 |
| 边界测试能在引入 `node:fs` 时失败 | ✅ 直接违规、传递违规两种场景各验证一次，之后已还原；加附件下载后又复验一次 |
| Node 与 Workers 同一份 `server/` | ✅ 无环境分支，`/api/health`、CORS 预检、`/file` 代理、下载接口在两端行为一致 |
| 前端显示后端连通状态 | ✅ |
| `FileSessionStore` 重启恢复 + `0600` | ✅ |

### 与计划的偏差

- 多建了 `server/storage/is-live.js`：三种存储共用「过期即不存在」的判定，抽出来避免某一种忘记剔除过期项。
- 多建了 `tests/proxy-headers.test.js` 和 `tests/file-proxy.test.js`：前者测纯函数，后者测路由行为（Range、鉴权头剥离、流式、防穿越）。
- `npm test` 用 `node --test tests/*.test.js` 而不是 `node --test tests/`——后者在本机 Node v24 下会把目录当成模块路径报 `MODULE_NOT_FOUND`。
- `createBackend` 的 `getSessionStore` 参数原本打算等第 1 期再加，但附件下载接口提前消费了它，于是提前接入，并把两个入口改成传工厂（`() => store`）而非实例——这样文件存储可以延迟到首个请求才打开。

### 实测中发现的两个 bug

见 `roadmap.md` 第 0 期「过程中发现并修掉的两个真 bug」。两个都不是测试先行发现的，是跑起来才暴露的。

---

## 第 0 期之后立刻要做的两件事

地基完成后，**先做实验再写第 1 期**：

```sh
# 实验 A：密码直连是否可用
curl -X POST https://apiucloud.bupt.edu.cn/ykt-basics/oauth/token \
  -H 'Authorization: Basic cG9ydGFsOnBvcnRhbF9zZWNyZXQ=' \
  -H 'Tenant-Id: 000000' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'username=<学号>' \
  --data-urlencode "password=$(printf '%s' '<密码>' | md5sum | cut -d' ' -f1)" \
  --data-urlencode 'grant_type=password' \
  --data-urlencode 'scope=all'

# 实验 B：续期是否稳定（拿实验 A 或 CAS 流程得到的 refresh_token）
# 连续换 3 次，每次都应返回新的 access_token
```

结论写回 `docs/api-reference.md` 的「待验证清单」，再动第 1 期。
