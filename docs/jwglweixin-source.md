# 移动教务（jwglweixin）作为校外可达课表源 — where_to_study 实现研究

> 2026-10-24 调研。问题：课表现走 `jwgl.bupt.edu.cn`（校内 DNS，校外 NXDOMAIN，
> 见 docs/login-test-2026-10-24.md），而 where_to_study 不需要校园网就能拿课表。
>
> **2026-10-24 晚更新：本项目已按本文协议接入（server/services/jwglweixin.js），
> 作为课表主源；登录协议已经真实上游验证**——假密码打 `/bjyddx/login` 返回
> `{"code":"0","Msg":"该帐号不存在或密码错误！","data":{}}`，与源码推断一致：
> code 为字符串、错误消息在 `Msg`、HTTP 200 + code 语义。登录编排（统一登录先试
> 移动教务，失败回退 jwgl CAS/legacy）与教务密码补填（POST /api/auth/jwglweixin/
> password，云邮会话鉴权）见 server/routes/auth.js。

## 一、关键事实：两套教务系统

| | 本项目/MYUCLOUD 现走 | where_to_study 走 |
|---|---|---|
| 域名 | `jwgl.bupt.edu.cn`（桌面版教务） | `jwglweixin.bupt.edu.cn`（移动教务/微信端） |
| 校外可达性 | **不可达**（域名只在校内 DNS，公网 NXDOMAIN） | **公网可达**（2026-10-24 校外实测：解析 211.68.69.240，HTTPS 200；与 ucloud 同 IP） |
| 认证 | CAS ticket / encodeInp 老登录 | **自有 token 登录，不走 CAS** |

## 二、协议（逐字读自 Nemoyuzx/where_to_study `src-tauri/src/{classrooms,academic,schedule,config}.rs`）

### 登录（明文表单，无 CAS 无加密）

```
POST https://jwglweixin.bupt.edu.cn/bjyddx/login
Content-Type: application/x-www-form-urlencoded
Origin/Referer: https://jwglweixin.bupt.edu.cn/sjd/#/login
User-Agent: Mozilla/5.0

userNo=<学号>&pwd=<教务密码明文>
```

- 成功响应：`{"code":1,"data":{"token":"...","expires_in":...}}`（code 也可能是字符串 "1"）
- 失败：`code != 1`，人话在 `Msg`/`msg`
- token 校验失败的表现：HTTP 500 + JSON（他们的 `parse_sjd_response_bytes` 特判了这个）

### 课表

```
POST https://jwglweixin.bupt.edu.cn/bjyddx/student/curriculum?week=      ← 当前周
POST https://jwglweixin.bupt.edu.cn/bjyddx/student/curriculum?week=all   ← 整学期
token: <登录拿到的 token>          ← 自定义请求头，不是 Authorization
Origin/Referer: https://jwglweixin.bupt.edu.cn/sjd/#/restClassroom
```

- 响应：`{"code":1,"data":[{ "item"/"courses": [ { courseName, teacherName, buildingName, classroomName, weekDay, classWeek, startTime, endTime, jx0408id, ... } ] }]}`
- 条目是**平铺的课程实例**（每条带星期、节次、周次文本），不是周网格；`weekDay` 首字符是星期数字，周次在 `classWeek`/`classWeekDetails` 文本里解析
- where_to_study 用 `jx0408id` + 名称/教师/地点/时间拼稳定 ID（SHA1 前 12 位）去重
- 学期接口：`GET /bjyddx/currentTerm`、`GET /bjyddx/semesterList`（academic.rs）

### 会话管理（classrooms.rs / session_cache.rs）

token 带 TTL 缓存（进程内），失效（HTTP 500 + 特定 JSON）自动重登一次；请求带 4MB 响应上限与重定向校验（`sjd_redirect_policy` 只认 https 同站）。

## 三、对本项目的可行性结论

**可行，且价值明确**：接入后课表不再依赖校园网（降级登录场景的课表黄条可以变成真课表），也是 jwgl 主源故障时的备份源。工作量与风险：

1. **后端**：新 service（登录 + token 缓存 + 课表拉取），平铺条目 → 本站周网格格式的转换（`classWeek` 文本解析周次是主要脏数据面，需要对抗性测试）。
2. **会话模型**：教务密码可能与统一身份密码不同（where_to_study 的 UI 就是分开填的「学号和教务密码」）。要么假设同密码试一次、失败再让用户补填，要么独立一个「教务密码」设置项——这是产品决策。
3. **策略**：jwgl 主源可达时仍走主源（数据更权威），不可达/失败时降级到 jwglweixin；两者解析结果进同一缓存（`bupt-week-timetable-v1`），前端无感。
4. **验证缺口**：登录与课表闭环需要真实教务密码实测（本文档的协议来自 where_to_study 源码逐字比对，未在本机实测请求）。

建议作为独立一期做（「课表第二数据源」），不与当前改动混批。

## 四、实测结论（2026-10-24，真实账号全量课表）

集成已完成（`server/services/jwglweixin.js`，登录→课表→渲染全链路真实验证通过）。与源码比对的出入与补充：

- **登录**：`code` 是字符串 `"1"`，错误消息在 `Msg`（大写 M）——均已按此实现。
- **token 失效的真实形状**：HTTP 200 + `{"code":401,"Msg":"非法访问：/student/curriculum"}`。Msg 里没有 token/登录/认证字样，只认关键词会错报 502；必须同时认 `code===401`（本次修复的实测依据）。
- **classTime 编码**：首字符节数门数丢弃、后续每两位一个 1-based 节点——真实数据 38 条全部吻合（如 `毛概 3-5 节、物理实验B 10-12 节`）。
- **学期信息**：`data[0].topInfo[0] = {semesterId, week, today, weekday, maxWeek}`。`maxWeek`（实测 "22"）是学期总周数，周次索引必须补齐到它——只补到课程周次并集（18）会丢期末考试周。
- **学期起点**：当前周 payload 的 `date[]` 带 `{mxrq, xqid, zc}`（0=周日按 7 处理），`monday = mxrq-(xqid-1)d`、`termStart = monday-(zc-1)w`，真实数据推得 2026-09-07，与校历一致。
- **海南作息不在数据里**：真实课表含「健美操(海南校区)」等海南校区课程，但接口不返回作息时刻表。海南 15 节制（北京 14 节）按用户提供的作息表内置前端常量（`src/utils/period-times.js`），节次列京/琼双行展示。
