# BUPT-week

[![gate](https://github.com/white-sand-grand/bupt-week/actions/workflows/gate.yml/badge.svg)](https://github.com/white-sand-grand/bupt-week/actions/workflows/gate.yml)
[![deploy](https://github.com/white-sand-grand/bupt-week/actions/workflows/deploy.yml/badge.svg)](https://github.com/white-sand-grand/bupt-week/actions/workflows/deploy.yml)

给北邮学生的个人课表 / 作业小站：**查课表、看作业、交作业一键直达**，微信里也能用。

- **在线地址**：<https://white-sand-grand.github.io/bupt-week/>
- 一套学号密码登录，课表、作业、班级三个标签页
- 前端部署在 GitHub Pages，后端跑在 Cloudflare Workers——**前端不直接接触任何学校域名，也不持有任何密码**

只做这三件事。不实现评教、不做站内提交作业、不做空教室查询、不做成绩查询。

---

## 功能

**统一登录**
- 一个表单登两个系统：课表来自教务处（jwgl），作业来自云邮教学空间（ucloud），二者共用统一身份认证，一次认证各取所需
- 微信内打开自动识别企业微信身份，免输密码（基于校方 mc-wx 静默授权，回流带一次性 state 防劫持）
- 会话持久化：正常使用自动续期（滑动 7 天），30 天绝对上限到期需重登；每小时静默探活，token 过期前完成续期

**课表**
- 数据源为移动教务（jwglweixin，公网可达，校外可用），教务处 PC 版为回退源
- 跨节课卡片纵向铺满全部节次；同名课程固定同色
- 节次时刻**北京 / 海南双校区**可切换（双显默认），悬停课程卡可见两校区具体起止时间
- 周次补齐到学期末（含期末空周），逐周本地缓存，切周不联网；「今天」列自动定位

**作业**
- 全量列表按紧急度排序：已逾期 → 今天/明天截止 → 一周内 → 待完成 → 已提交 → 往期未交
- 未提交作业显示**距截止倒计时（精确到分钟）**与截止进度条（颜色即紧急度）
- 只显示本学期；截止时间一律按北京时间解释，不随设备时区漂移
- 附件在卡片内直接下载（服务端代理，绕开云邮存储的防盗链限制）；「去交作业」直达该作业的提交页

**班级**（同学间共享作业）
- 创建班级（名称 + 密码）得 8 位班级号（无易混字符，点击即复制），同学凭班级号 + 密码加入；可加入多个班
- 任何成员都能手动录入作业（必填：标题 / 科目 / 内容；截止时间可选），全班共享
- 作业栏里班级作业按科目分组、带来源班级标签，排序 / 倒计时与云邮作业同构
- 密码 PBKDF2 加盐存储，明文不落任何地方；班级创建者可解散班级，录入者可删自己录的作业

## 使用

1. 打开 <https://white-sand-grand.github.io/bupt-week/>（微信内打开会自动识别，无需输密码）
2. 浏览器里用学号 + 统一身份密码登录；微信内识别成功后，若要看课表，在课表页黄条里**补填一次教务密码**（通常与统一身份密码相同），之后 30 天内不再询问
3. 课表页看课、作业页看作业、班级页和同学共享作业

> 网络说明：后端在 `*.workers.dev` 上，国内部分运营商网络可能无法直连。若页面打得开但登录失败，换网络 / 开代理再试；自托管后端绑定自定义域名可彻底解决，见部署文档。

## 部署（自托管）

前端 GitHub Pages + 后端 Cloudflare Workers，推送 `master` 自动构建发布：

```sh
npx wrangler login
npx wrangler kv namespace create SESSIONS   # id 填入 wrangler.toml（[[kv_namespaces]] 表头要一起取消注释）
npm run deploy:worker                        # 后端；前端由 CI 自动发布
```

仓库需要两个 Actions 配置：`VITE_BACKEND_URL`（变量，后端来源）与 `wrangler.toml` 里的 `FRONTEND_URL`（企微回流跳回地址，含子路径）。完整步骤、CORS、KV、WAF 限速建议见 **[docs/deployment.md](docs/deployment.md)**；后端也可以跑在任何 Node 服务器上（`npm run server`），代码零改动。

## 本地开发

```sh
npm ci

npm run server    # 终端 A：后端 → http://127.0.0.1:8787（只绑回环）
npm run dev       # 终端 B：前端 → http://127.0.0.1:5173（/api 代理到后端）
```

```sh
npm test               # 271 个单元/接口测试，不需要浏览器
npm run test:browser   # 42 个浏览器测试（首次先 npx playwright install chromium；
                       #   可用 BROWSER_EXECUTABLE 指向本机 Edge/Chrome）
npm run gate           # 全量门禁：单元 → 安全（audit/密钥扫描/响应头）→ 构建 → 浏览器 → 性能预算
npm run build          # 前端构建，产物在 dist/（相对路径，适配 Pages 子路径部署）
npx wrangler dev       # 本地 Workers 运行时，与 Node 入口共用同一份 server/
```

CI 在 PR 和 `master` 推送上跑同一条 gate；`deploy.yml` 跑测试、构建并发布 Pages。

## 工作原理

```
GitHub Pages（静态）                 Cloudflare Workers（Hono）
┌─────────────────────┐            ┌──────────────────────────┐
│  Vue 3 + Vite       │  HTTPS     │  /api/auth/*  登录与会话  │
│  课表 / 作业 / 班级  │ ─────────> │  /api/ucloud/*  云邮      │
│  不接触学校域名，    │  JSON      │  /api/jwgl/*   教务       │
│  不持有任何密码      │            │  /api/classes/* 班级      │
└─────────────────────┘            │  /file/*       S3 代理    │
                                   └──────────────────────────┘
```

**为什么必须有后端**（不是偏好，是硬约束）：

1. 浏览器拿不到 CAS 302 的 `Location`（opaque redirect），而取 ticket 全靠它
2. 跨多个请求合并学校各系统的 `Set-Cookie`，服务端做才可靠
3. 云邮文件存储的防盗链同时要求"带头"与"不带头"，只能服务端代理

同一份 `server/` 代码同时跑 Node 与 Workers——会话存储是工厂注入的（本地文件 / KV），业务代码零分支。技术栈与两个参考实现同源（Vue 3 + Hono），抓取逻辑可对照移植。

## 安全与隐私

- 密码只在登录/补填的那一次请求里使用，**不写入任何存储、日志或响应**（有测试断言守着）
- 浏览器本地只存 `sessionId`、学号、姓名、过期时间；token / Cookie 罐只在服务端会话里
- 服务端会话滑动续期 7 天，30 天绝对上限；登录与班级加入有失败限速（10 分钟 10 次）
- 企微回流一次性绑定 CAS state，sessionId 走 URL fragment 不进 Referer，落地即清
- `/file` 代理校验来源，接口响应统一 `no-store / nosniff / no-referrer`

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 双系统登录、数据流、会话与凭证模型、安全边界 |
| [docs/api-reference.md](docs/api-reference.md) | 逆向验证过的学校接口与深链，标注了实测/待验证 |
| [docs/deployment.md](docs/deployment.md) | Pages + Workers 部署全流程（KV、CORS、FRONTEND_URL、限速） |
| [docs/jwglweixin-source.md](docs/jwglweixin-source.md) | 移动教务协议逆向与实测结论（含 token 过期真实形状） |
| [docs/unified-login-plan.md](docs/unified-login-plan.md) | 统一登录与企微登录的调研、候选方案与实测记录 |
| [docs/delivery-report-2026-10-24.md](docs/delivery-report-2026-10-24.md) | 全产品交付报告 |

## 参考实现

- [AuceptinFang/MYUCLOUD](https://github.com/AuceptinFang/MYUCLOUD) — 主要参考：登录流程、课表解析器、截止时间分级
- [Nemoyuzx/where_to_study](https://github.com/Nemoyuzx/where_to_study) — 参考："截止时间是时刻不是时长"的时间规范化、移动教务协议语义

## 许可与免责

未附带开源许可证（保留所有权利）；个人学习交流请随意，复用前请先联系作者。

本项目是个人便利工具，通过学校公开的 Web 接口读取**自己的**数据。请勿用于代查他人数据或任何违反学校规定的用途。凭证只保存在服务端会话存储中，不落库、不外传。
