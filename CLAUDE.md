# CLAUDE.md

## 这个项目是什么

BUPT 学生用的个人工具，只做三件事：查课表、看作业、给交作业的跳转链接。
不实现站内提交作业、评教、空教室、成绩。范围刻意收窄，别扩大。

## 动手前必读

| 要改什么 | 先读 |
|---|---|
| 登录、课表、作业、跳转链接 | `docs/api-reference.md`（标注了哪些实测、哪些待验证） |
| 架构、凭证怎么存 | `docs/architecture.md` |
| 做到哪一步了 | `docs/roadmap.md` |
| 本期文件级计划 | `docs/implementation-plan.md` |

`docs/api-reference.md` 里的结论分**【实测】/【推断】/【待验证】**。标「待验证」的不要当成事实写进代码。

## 两条硬约束

1. **`server/` 下除 `storage/file.js` 外禁止 `import ... from 'node:*'`。**
   `tests/server-boundaries.test.js` 守着这条，包括传递依赖。违反它本地一切正常、Workers 部署直接挂。
2. **课表和作业在两个不同系统，两套登录。** 课表走 `jwgl.bupt.edu.cn`，作业走 `ucloud.bupt.edu.cn`，凭证不通用。别试图合并成一套。

## 容易踩的坑（都是实测踩过的）

- `fetch()` 返回的 `Response`，其 `headers` 是 **immutable** 的，就地 delete/set 会抛 `TypeError: immutable`。改头必须重建 `Response`，并且丢掉 `content-length` / `content-encoding`。
- Hono 里 handler 返回**原始 `Response`** 时，中间件用 `c.header()` 设的头会被丢掉。需要自己补。
- 教务处登录的 `encodeInp` 是自定义 base64 变体，**照抄 MYUCLOUD 不要重写**。抄错的表现是静默登录失败，极难查。
- Vite dev server 开了 SPA fallback：**不存在的文件会返回 `index.html` 且状态码 200**。想测 404 要走 `/api` 代理打到后端。

## 交作业跳转链接

核心功能，参数集中在 `buildAssignmentUrl()` 一处（第 3 期落地）。改动前必须：
1. 重新拉云邮前端 bundle 确认路由没变（bundle 哈希记在 `docs/api-reference.md` 3.1 节）
2. 人工点验跳转打开的是**那一门作业的提交页**，不是列表页也不是首页

列表页不能深链——它从 `site-id` cookie 读课程，冷启动会空。只能跳详情页。

## 代码约定

- 匹配现有风格：ES modules、无分号、单引号、2 空格缩进。
- 错误统一 `{ success: false, msg }`，登录链路加 `stage`。`msg` 是给人看的，要能看懂。
- 不加依赖。现有依赖（hono / vue / vite）够用就别引新的。
- 改动要小。修 bug 就修 bug，别顺手重构旁边看着不顺眼的代码。

## 验证

```sh
npm test            # 45 个接口/单元测试，不需要浏览器
npm run test:browser # 6 个浏览器测试，需要 chromium
npm run build       # 前端构建，产物相对路径（Pages 子路径部署）
```

浏览器测试是单独一个脚本，不并进 `npm test`：它要先装 chromium，且慢一个量级。
首次使用前执行 `npx playwright install chromium`——只装完整的 chromium 构建即可，
`chrome-headless-shell` 下载失败不影响（测试用 `channel: 'chromium'` 指定完整构建）。

改完 `server/` 必须两个入口都验：`npm run server` 和 `npx wrangler dev`。
改完前端必须 `npm run build` 通过——它是 SFC 编译的真门槛（dev server 有模块缓存，200 不代表编译成功）。

## 关于依赖

`playwright` 是唯一的例外，只作为 devDependency 存在，不进产物。加它是因为
浏览器行为（blob 落盘、`<a download>` 的文件名、CORS 在真实浏览器里的放行/拦截）
无法用接口测试覆盖。除此之外不加新依赖。
