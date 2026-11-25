# 用自己的 Agent 管理班级

HTTP API 支持创建／加入班级、查询与录入作业、添加班级共享资料源。机器可读契约位于后端的 `/api/agent/v1/openapi.json`。

无需注册新账号。先用现有方式登录本站，到「班级 → Agent 接入」生成独立 Agent Key，把 Key 配置到自己的 Agent 或脚本中。新功能不接收或保存学校账号密码，不把学校 token 交给 Agent；原有学校登录流程保持不变。

## 1. 生成授权

默认授权只覆盖选择的班级，允许读取、录入作业和添加资料源。需要 Agent 创建或加入班级时，选择「本人当前及以后加入的全部班级」，单独勾选创建／加入权限。入班使用的是同学共享的**班级密码**，不是学校密码。

有效期可选 7／30／90 天，默认 30 天，每人最多 10 个有效授权。完整 Key 只在生成时显示，不写入浏览器存储，后端仅保存其摘要；关闭面板后请到自己的凭证配置查找，丢失则撤销重建。授权记录关联已有的班级成员身份，不新增账号或密码表。

退出本站不会自动撤销 Agent Key，可以让脚本继续工作；需要停止访问时，在网页撤销单个或所有授权。撤销成功后开始的新请求会被拒绝，已经通过校验并在执行中的操作可能完成。

## 2. 调用

以下命令在 **WSL Ubuntu / Bash** 中运行。`BUPT_WEEK_BACKEND` 设为实例的后端 origin，不是 GitHub Pages 地址。Key 用隐藏输入读入当前终端，避免进入命令历史：

```bash
export BUPT_WEEK_BACKEND='https://你的后端域名'
read -rs -p 'Agent Key: ' BUPT_WEEK_API_KEY
export BUPT_WEEK_API_KEY
printf '\n'

curl "$BUPT_WEEK_BACKEND/api/agent/v1/classes" \
  -H "Authorization: Bearer $BUPT_WEEK_API_KEY"
```

Agent 或 SDK 应在请求内存中设置 Authorization。不要把 Key 写入源码、URL、提示词、日志或版本控制。curl 示例只用于本地调试，在共享机器上应使用提供安全凭证存储的客户端。

从列表取得 classId 后，录入作业：

```bash
curl "$BUPT_WEEK_BACKEND/api/agent/v1/classes/<classId>/assignments" \
  -H "Authorization: Bearer $BUPT_WEEK_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: notice-probability-03' \
  --data '{"title":"第三次作业","subject":"概率论","content":"完成第 3 章第 1、4、8 题。","deadline":"2026-11-29T23:59:00+08:00","externalId":"notice-probability-03"}'
```

首次创建返回 201，成功响应为 `{ "success": true, "data": { ... } }`。网页重新进入班级／作业页可见新增内容，标明由哪个 Agent 授权录入。

## 3. 接口和权限

所有相对路径以 `/api/agent/v1` 开头，携带 `Authorization: Bearer <Agent Key>`：

| 方法与路径 | 权限 | 用途 |
| --- | --- | --- |
| `GET /me` | 有效 Key | 查看本授权范围与期限 |
| `GET /classes` | `classes:read` | 查看范围内本人已加入的班级 |
| `POST /classes` | `classes:create`，全部班级范围 | 创建班级：name、password |
| `POST /classes/join` | `classes:join`，全部班级范围 | 加入班级：code、password |
| `GET /classes/{classId}/assignments` | `assignments:read` | 查看班级作业 |
| `POST /classes/{classId}/assignments` | `assignments:create` | 录入作业 |
| `GET /classes/{classId}/sources` | `sources:read` | 查看班级资料源 |
| `POST /classes/{classId}/sources` | `sources:create` | 添加资料源 |

每次请求都同时检查 Key 权限和当前班级成员身份。没有学校数据接口、个人资料源同步、删除接口或解散接口；这些 Key 不能替代网页登录会话，也不能签发其他 Key。

作业字段：title 1–100 字、subject 1–40 字、content 1–2000 字，正文按纯文本展示。deadline 可省略或为 null，提供时必须是带时区、秒为 00 的合法日期，后端转换成北京时间。externalId 可选，1–128 字，用于标识上游通知。

资料源字段：

```json
{ "type": "github", "url": "https://github.com/teacher/materials", "name": "老师的资料仓库" }
```

```json
{ "type": "link", "url": "https://example.org/course", "name": "课程主页" }
```

github 只接受公开仓库首页，验证后复用已有目录浏览和下载；link 只保存公开 HTTPS 地址并跳转，不在服务端抓取网页。一个班最多 100 个源；同一仓库或规范化链接重复添加返回已有记录，不覆盖名称。查询参数不同的网页链接分别保存。Key 不具备 BYR Docs 下载凭证。

班级资料源在「添加源」页显示，点击「刷新班级资料源」获取最新数据。原本未登录使用的 GitHub 列表仍留在当前浏览器，不会自动上传。

## 4. 预览、重试和限流

- 所有业务 POST 可加 `"dryRun": true`，校验目标、字段、密码、容量与重复记录，返回规范化结果，不创建业务数据、不消费幂等键。正式提交时会重新校验，不预留容量。
- 正式 POST 必须携带 1–128 位可打印非空格 ASCII 的 Idempotency-Key。超时后使用原值重试，至少 24 小时内返回原结果；同键不同内容返回 409。
- 作业的 externalId 在「班级 + 录入者」内唯一，换 Key 后仍防重复；同标识不同内容返回 409，需要先查询原记录。
- 账号下所有 Key 合计每分钟最多 60 次请求、20 次正式写入；失败请求和预览也消耗请求额度。资料源验证前先计数，GitHub 失败也不会绕过限流。另有按来源 IP 的进程内入口保护；公网部署仍需可信反向代理／边缘限流。
- 加入班级密码错误 10 次后限流 10 分钟，预览同样计入。返回 429 时按 Retry-After 延迟，避免无限重试。

错误响应保留 `{ "success": false, "msg": "中文说明", "code": "稳定错误码" }`。常见状态：400 输入错误；401 Key 无效／过期／撤销；403 动作无权限或班级密码错误；404 对象不存在或超出授权范围；409 重试内容冲突；413 请求过大；429 限流；502 资料源上游异常；503 存储暂时不可用。

## 5. 自托管与数据迁移

Workers 班级读写通过 BUSINESS Durable Object 事务完成。当前规模使用一个权威对象，班级号、成员索引、授权和作业可一起原子提交；新增绑定和 SQLite migration 已写在 `wrangler.toml`。没有 BUSINESS 绑定时明确返回 503，不退回无法保证原子性的 KV 写入。它增加一个集中处理点，适合目前小规模班级工具，日后有容量需求再按实测拆分。

旧 CLASSES KV 作为只读迁移来源，访问某个旧业务键时导入；已有班级 ID、班级号、成员、密码哈希和作业保留。迁移前备份 KV；切换后所有网页与 Agent 入口都使用新存储，删除墓碑避免旧记录复活。不要混跑仍写旧 KV 的旧版后端，不要直接降级回旧 KV 版本。

Node 的学校会话仍保存在 `.sessions.local.d/`；班级、授权、幂等及审计记录改用 `.business.local.d/` 中独立的原子快照，旧班级数据按需迁入。备份两份目录，同一目录只运行一个 Node 实例。此业务快照适合当前小规模部署，每次事务原子替换整份业务快照，学校凭证不会复制进去。

审计只保留时间、动作、对象 ID、授权 ID 与结果，每人最多 1000 条、最长 30 天，不保留作业正文、完整 Key 或任何密码。幂等结果包含本站业务操作的返回数据，24 小时后清理。授权按有效期回收。

验证按项目的 `npm run gate` 执行，并分别启动 `npm run server` 与 `npx wrangler dev`。迁移和部署步骤见 [部署说明](deployment.md)。
