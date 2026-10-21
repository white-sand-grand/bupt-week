# 统一登录与企业微信登录 — 调研结论与实施计划

> 标注沿用 `api-reference.md` 的约定：**【实测】** /**【推断】** /**【待验证】**。
> 除标注外，本文所有结论都来自 2026-10-20 对 `auth.bupt.edu.cn` 的实测请求。

---

## 一、两个参考库的结论：都没有

| 能力 | MYUCLOUD | where_to_study |
|---|---|---|
| 统一登录（一次认证服务多个系统） | **无** | **无** |
| 企业微信 / 扫码登录 | **无** | **无** |

**MYUCLOUD**：`server/services/ucloud.js`（CAS）与 `server/services/jwgl.js`（`encodeInp` + Cookie 罐）
彼此不引用、不共享凭证。

**where_to_study**：三条互不相干的认证路径——
教务处走 `jwglweixin.bupt.edu.cn` 自己的 token 登录，云邮走 CAS，
QMplus 根本没实现。云邮的 `access_token` 从不发给教务处，教务处的 token 也从不发给 CAS。
CAS 的 ticket 被钉死在 `service=https://ucloud.bupt.edu.cn`，没法重放给别的系统。

唯一算"共享"的地方：两边的登录都读同一份 keychain 里的学号密码
（`src-tauri/src/auth.rs` 的 `resolve_credentials`）。**一份凭证喂两次独立登录**，
不是共享会话——登录函数彼此不调用。这正好对应本计划 Part 1 的思路。

**所以这两块都得自己设计。**

> 顺带一个关键事实：where_to_study 用的教务处是 **`jwglweixin.bupt.edu.cn`**，
> 不是 MYUCLOUD 用的 `jwgl.bupt.edu.cn`。这是**两套不同的教务系统**，见第四节。

---

## 二、实测：CAS 确实是统一入口（你的判断是对的）

CAS 对未注册的 service 会返回 `Application Not Authorized to Use CAS` 页面。
拿它当探针，逐个试：

| service | CAS 反应 | 结论 |
|---|---|---|
| `https://ucloud.bupt.edu.cn` | CAS Login | ✅ 已注册 |
| `https://jwgl.bupt.edu.cn/` | CAS Login | ✅ **已注册** |
| `https://app.bupt.edu.cn/` | CAS Login | ✅ 已注册 |
| `https://jwglweixin.bupt.edu.cn/` | Application Not Authorized | ❌ 未注册 |

**教务处（`jwgl.bupt.edu.cn`）是注册过的 CAS service。** 两个系统确实共用同一套统一身份认证。
where_to_study 用的 `jwglweixin.bupt.edu.cn` 反而是另一套、没接 CAS。

CAS 也提供标准的 ticket 校验端点（实测可用）：

```
GET /authserver/serviceValidate?service=<service>&ticket=<ticket>
GET /authserver/p3/serviceValidate?service=<service>&ticket=<ticket>
```

---

## 二·补、两套教务系统，取舍不同

调研中发现"教务"有两个完全不同的实现，这会影响 Part 2 怎么做：

| | PC 版 `jwgl.bupt.edu.cn` | 微信版 `jwglweixin.bupt.edu.cn` |
|---|---|---|
| 登录 | `encodeInp` + Cookie 罐（已实现） | `POST /bjyddx/login` 拿 `data.token` |
| 课表接口 | HTML，要解析 `xsdPerson.jsp` | **JSON**：`POST /bjyddx/student/curriculum?week=all` |
| 接入 CAS | ✅ 是（实测） | ❌ 不是（实测 Not Authorized） |
| 空教室 | — | `GET /bjyddx/todayClassrooms?campusId=` |
| 参考实现 | MYUCLOUD | where_to_study |

**这是个真实的岔路**：微信版接口干净得多（不用解析 HTML），但它接不进 CAS，
统一登录就套不在它身上。PC 版能统一，但要继续做 HTML 解析。

本计划默认走 **PC 版**（因为统一登录是你的核心诉求，且 MYUCLOUD 的解析器可以直接移植）。
如果你想改用微信版，Part 2 要整个换掉——说一声我改。

---

## 三、CAS 支持的登录方式（实测 6 种）

入口统一是 `clientredirect?client_name=X&service=<service>`，全部经 `state=TST-<编号>-<随机>` 回到 CAS：

| client_name | 302 去向 | 用途 |
|---|---|---|
| *(不带)* | 页内表单 | 学号 + 密码 |
| `ww-direct` | `open.weixin.qq.com/connect/oauth2/authorize?appid=wxf1bb5361ed86c6ec` | **企业微信**（appid 即企微 corpid） |
| `mc-wx` | `app.bupt.edu.cn/uc/api/oauth/index?appid=200210806102757400` | 微信内打开 |
| `mc-qr` | 同上 | 扫码登录 |
| `cs` | `api.campushoy.com/connect/oauth2/authorize` | 今日校园 |
| `carsi` | `spoauth2pre.carsi.edu.cn/api/authorize` | CARSI 教育网联盟 |
| `net-online` | 自身 | 网络自助 |

---

## 四、企业微信的硬阻塞（这块要先跟你确认）

`ww-direct` 的 `redirect_uri` 被 CAS 固定成 `https://auth.bupt.edu.cn/authserver/login?client_name=ww-direct`，
我们改不了。于是流程必然是这样：

```
浏览器 → CAS clientredirect(ww-direct, service=X)
      → 微信/企微 OAuth 授权
      → 回到 CAS（带 code）
      → CAS 换到身份，302 到 <service>?ticket=ST-xxx
      → <service> 把 ticket 吃掉
```

**最后一步 ticket 落在一个已注册的 service 上，而那个域名不是我们的。**
实测把 `service` 换成一个未注册地址，CAS 直接返回
`Application Not Authorized to Use CAS`——所以不能把自己的后端设为 service 来接 ticket。

浏览器里也读不到：popup 一旦跳到 `ucloud.bupt.edu.cn`，跨域策略让我们拿不到它的 URL。

### 候选出路

**候选 A：走 `app.bupt.edu.cn` 的 OAuth —— 已验证可行，设为主方案。**

关键发现：让 CAS 自己生成 `mc-wx` 跳转，会拿到一个**带 CAS 生成 state** 的
app.bupt URL。此时只把 `redirect` 换成我们自己的地址，app.bupt 照单全收，
而且我们的地址一路存活进登录流程：

```
CAS: clientredirect?client_name=mc-wx&service=<ucloud>
  → 302 app.bupt.edu.cn/uc/api/oauth/index?...&redirect=<CAS登录页>&state=TST-109420-xxx
                                                        ^^^^^^^^^^^ 换掉这个
  → 302 app.bupt.edu.cn/uc/wap/login?redirect=<带着我们地址的完整 URL>
```

于是闭环了：

```
1. 后端请 CAS 生成 mc-wx 跳转（service=ucloud）→ 拿到带 CAS state 的 app.bupt URL
2. 把该 URL 的 redirect 换成本后端 /api/auth/wecom/callback，302 给浏览器
3. 用户在微信里被企业微信自动识别，app.bupt 登录
4. app.bupt 302 回我们的 callback，带 ?code=XXX&state=TST-...（state 是 CAS 认的）
5. 后端带 code+state 请求 auth.bupt.edu.cn/authserver/login?client_name=mc-wx
6. CAS 校验 state、换 code，302 到 service?ticket=ST-xxx ← 从 Location 拿到 ticket
7. 用 ticket 走 Part 2 的既有逻辑换云邮 token / 教务处会话
8. 302 浏览器回前端，带上 sessionId
```

`ww-direct` 那条路走不通——它的 `redirect_uri` 由微信侧固定校验，改不了。
`mc-wx` 的 redirect 在 app.bupt 侧，可以换。

**仍未验证**（需要你在微信里实测一次）：
- 第 4 步：app.bupt 登录后是否真回到我们换过的地址（入口处已验证接受，登录后未验）
- 第 6 步：CAS 是否容忍 redirect 被改过（state 本身没改，大概率认）

任何一点不成立就退候选 B。代码里留好开关。

**候选 B：放弃企业微信入口。**
统一登录仍用学号密码，企业微信登录云邮官网的行为不变。

---

## 五、实施计划

### Part 1 — 合并登录界面（确定可做）

现在前端是两个面板。改成一个：学号 + 密码 + 一个登录按钮。

- `POST /api/auth/login` 一次认证两个系统，返回两个 sessionId
- 前端合成一个登录态展示（内部仍是两个 sessionId，互不影响这条不变）
- 任一侧过期只禁用对应功能

**验收**：输一次学号密码，课表和作业两个系统都登进去。

### Part 2 — CAS SSO 双 ticket（确定可做，教务处端点待验证）

这是"同一套登录系统"的真正落地方式：

```
casLogin(学号, 密码, service=A)  → CASTGC Cookie + ticket A
casLogin(学号, 密码, service=B)  → 同一个 Cookie 罐，直接给 ticket B（不重新认证）
```

- ticket A（`service=ucloud.bupt.edu.cn`）→ 换云邮 OAuth token ← **已验证可用**
- ticket B（`service=jwgl.bupt.edu.cn/`）→ 换教务处会话 ← **端点待验证**

ticket B 的用法是【待验证】：大概率是 `GET https://jwgl.bupt.edu.cn/?ticket=ST-xxx`，
由教务系统自己建会话。但 `jwgl.bupt.edu.cn` 从我这台机器完全不可达（`curl` 都是 000），
验不了，需要你在校园网内试。

**设计上留 fallback**：ticket B 走不通就继续用现在已经跑通的 `encodeInp` 登录。
两条路都在，按可用性切换，不影响其他部分。

### Part 3 — 企业微信登录（实现骨架，标注阻塞）

不管候选 A 能不能成，先把两端骨架写好：

- `GET /api/auth/wecom/start` → 302 到 `clientredirect?client_name=ww-direct&service=...`
- `GET /api/auth/wecom/callback` → 接收回流

阻塞点和候选 A 的验证方法写进代码注释和 `api-reference.md`，等你实测后补上
"code 换凭证"那一环。

---

## 六、需要你定的三件事

1. **企业微信走候选 A 还是 B？** A 需要你在企业微信里实测一次 `code` 能换出什么；
   B 是放弃企业微信入口。我倾向先把 A 的骨架搭好、你去测，测不通再退 B。
2. **教务处的 CAS 入口**：如果你知道 `jwgl.bupt.edu.cn` 收 ticket 的确切路径，告诉我，
   能省掉一轮试错。不知道的话我就按 `/?ticket=` 猜，配上 fallback。
3. **教务系统用 PC 版还是微信版？** 见第二节补述。默认 PC 版（能统一登录），
   微信版接口更干净但接不进 CAS。
