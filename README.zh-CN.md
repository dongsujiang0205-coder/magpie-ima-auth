<p align="center">
  <img src="icon.png" width="96" alt="ima">
</p>

# magpie-ima-auth

[English](README.md) | **简体中文**

登录 **ima**（腾讯 ima.copilot，`ima.qq.com`）——AI 知识工作台——并把它账号下的
模型交给 Agent 使用，消耗的是该账号自己的**算力**。

一个 provider，id 是 `ima`。magpie 没有内置，所以 Agent 里设成 `ima/<模型名>`
就直接连 ima。

> **非官方。** 本项目是第三方插件。ima 和 ima.copilot 属于腾讯，与腾讯无隶属
> 或背书关系。它靠调用 ima 未公开的接口工作——这些接口可能随时变化或消失，
> 届时本插件会失效。你的凭据归你自己：插件只把它们发往 `ima.qq.com`，存在
> OpenCode 或 magpie 自己的 auth 文件里，这里没有任何东西回传。

## 这个插件在做什么

ima 没有 OpenAI 兼容接口，本插件也不假装有。它做了三件事：

1. **用一个 ima 会话对应一段 Agent 对话。** ima 的接口每次只收一个字符串，
   没有 messages 数组。插件把客户端的整段对话压成那一个问题，再把 ima 返回的
   SSE 翻译成 `chat.completion` 的流式分片。
2. **模型是 `(type, id)` 二元组，不是名字。** 例如 `deepseek-v4-flash` 对应
   `model_type: 3` + `model_id: "official_3"`。
3. **业务错误藏在 HTTP 200 里。** 登录过期是 `code 41`，被拒绝是 `600001`，
   会话失效是 `5` 或 `51`——全都在 200 的 body 里。只看状态码会让一个死账号
   看起来还活着。

协议细节（字段、错误码、模型 ID）见 [English 版](README.md)，那边是完整的。

## 登录

ima 没有授权页可以跳转，也没有 token 端点可以轮询，所以**没有自动登录**。
两种方式：

### 粘贴 cookie（唯一可靠的方式）

1. 浏览器打开 <https://ima.qq.com> 登录，给 ima 发任意一条消息。
2. F12 → **Network** → 点开 `/cgi-bin/assistant/qa` 这个请求 →
   **Request Headers**。
3. 把 **`x-ima-cookie`** 这个请求头的**整个值**复制下来，粘贴给 magpie。

> **必须是这个请求头的值，不能是浏览器的 cookie 存储。** ima 前端会往这个头里
> 放一些 cookie 存储里没有的字段，只用存储重建的 cookie 会被回 `600001
> 服务繁忙`。插件会提示你这一点，否则这个报错看起来像是 ima 在忙。

### ima 桌面端登录 —— 已移除

曾经有过第二个登录方式，读 ima 桌面应用自己的 cookie 存储（用登录用户的
DPAPI 密钥解密）。**它不能用，已移除而不是作为一个必然失败的选项发出去。**
实测结论：

- ima **从不把登录态写进磁盘**。Extension Cookies 里只有 ima 客户端组装的
  11 个字段里的 5 个，而按 token 值（明文和 base64 两种形式）扫遍 profile 下
  每个文件，零命中。登录态在进程内存里。
- 那 5 个字段是**上次退出登录前**的。重新登录只改写 `IMA-GUID`，两个 token 的
  密文长度一字未变，ima 答 `code 41` / `110031 token session expired`。
- 拿完整的 11 个字段需要运行中客户端的 cookie，也就是要调试端口，而
  `--remote-debugging-port` 现在无效。

所以这个选项只会失败，用户也看不出为什么失败。粘贴 cookie 是唯一可行的。

## 使用

在 magpie 的 **设置 → 插件**，把下面任意一条粘进标着 *"已有想装的？"* 的输入框，
点**安装**：

```
github:dongsujiang0205-coder/magpie-ima-auth    从 GitHub
D:\path\to\magpie-ima-auth                      本机文件夹
magpie-ima-auth                                 从 npm（发布后）
```

或者命令行。下面用 magpie 的可执行文件名 `magpie-windows-amd64.exe`（如果你
把它加进了 PATH，直接写 `magpie` 即可）：

```powershell
& "D:\magpie-windows-amd64.exe" plugin add github:dongsujiang0205-coder/magpie-ima-auth
& "D:\magpie-windows-amd64.exe" plugin login ima
```

`plugin login ima` 会打印上面的 cookie 步骤，然后等你粘贴。

OpenCode 用户在 `opencode.json` 里：

```json
{ "plugin": ["magpie-ima-auth"] }
```

然后 `opencode auth login`。

## 模型

登录后 magpie 里会看到：

- **知识库模型**（8 个）：`deepseek-v4-flash`、`hy3` 等，ima 官方，免费。
- **Copilot 模型**（12 个，`copilot/` 开头）：消耗算力，每个模型倍率不同，
  比如 `copilot/hy3` 是 ×0.2、`copilot/kimi-k3` 是 ×4.5。倍率显示在模型名里。
- **自定义模型**（你在 ima 里自己加的那些）：数量因账号而异。代码里没有硬编码，
  每个用户只看到自己账号下的——不会出现在别人的列表里。

同名模型在两套目录里是不同的 ima 模型，所以 Copilot 的用 `copilot/` 前缀区分。
没登录时只显示前 8 个（静态表）。

## 不支持

**工具调用（tools）。** ima 的问答接口一次只收一个字符串，没有工具通道。所有
模型都声明不支持工具。这是 ima 的限制，不是 bug——有其他插件用"把 schema 写进
prompt、解析打标签的回复"的方式模拟，但那依赖模型本来就没训过输出那些标签，
这里刻意没做。

**知识库定向。** ima 的问答跑在会话打开时绑定的知识库上，本插件开的是普通
会话，不是绑定某个知识库 id 的。

## 每日签到（未实现）

ima 每登录一天给 50 算力，领取接口是
`/cgi-bin/daily_login_activity/check_in`。**它无法从 ima 客户端之外调用**——
以下都是在 app 自己标为可领的那天（`status: 3`、`button: "签到"`）实测的：

- 路由确实存在：它回 403，而同前缀下其他名字（`claim_reward`、`share`、
  `sign`、`reward` 等）全回 404。
- 所有请求体都被拒：`{}`、`reward_type` 0–20、`day`、`date`、`top`。
- 所有请求头组合都被拒：加/不加 `x-ima-uid`、`x-ima-token`、`sec-fetch-*`；
  以及 `text/plain`、form-encoded、不带 Content-Type。
- 放在加密前缀 `/cgi-bin/s/` 下是 404。
- 调用它的代码不在 ima **1663 个扩展脚本**中的任何一个里，所以连请求体
  长什么样都读不出来。
- 唯一能让请求加密的办法是客户端自己的调试端口，而 ima 已经不再开放：
  `--remote-debugging-port` 进了主进程命令行，但没有任何东西监听。

所以本插件**不导出** `auth.checkin`。否则 magpie 界面上会出现一个每天
都失败、用户也无从处理的「每日签到」——和下面那个桌面端登录是同一个道理。

读取签到状态仍然可以：`/cgi-bin/daily_login_activity/get_activity_info`
按天返回，每行带 `top`、`status`、`reward`，还有一个很有用的 `button`——
它直接告诉你 app 会做什么（`签到` / `已领取` / `已过期`）。

## 排查

| 现象 | 原因 |
|---|---|
| 登录时报 `600001 服务繁忙` | 粘贴的不是 `x-ima-cookie` 请求头的值，而是 cookie 存储 |
| 登录时报 `41 登录过期` | cookie 是旧的，重新取一次 |
| 模型列表只有 8 个 | 没登录。登录后会多出 copilot 模型和你自己的自定义模型 |
| 没有 `copilot/` 开头的模型 | 没登录，或该账号的 Copilot 没开通 |
| 用量卡显示算力但很慢 | ima 的接口慢，`get_balance` 是实时的 |
| Agent 报工具错误 | 预期内，不支持工具 |

## 自查

```sh
npm test             # 40 个测试，含对假服务器的一次端到端对话
node smoke.mjs       # 10 项检查：magpie 调的每个钩子，形状按 magpie 源码
npm run scan         # 这个仓库要发出去的东西里没有个人信息
```

## 发布

每次推送都是一个版本。`package.json` 里的版本号标记这次发布描述的状态，
`v*` 标签标记代码是从哪个提交切出来的。

```sh
# 1. 定版本：修 bug 用 patch，加功能用 minor，
#    插件与 magpie 的契约变了才用 major
npm version patch        # 0.1.0 -> 0.1.1（同时提交并打标签）

# 2. 提交和标签一起推
git push origin main --tags

# 3. 发到 npm
npm publish
```

标签比看起来重要：magpie 的 `magpie plugin update` 会装每个插件的最新版本，
而标签就是声明"最新版本对应哪个提交"。两个标签之间的提交属于开发过程——
版本号只在切发布时才动，所以多个提交可以共用一个版本号。

GitHub 上也有发布页：**Releases → Create a new release** → 选刚推的标签。

## 许可

MIT。详见 [LICENSE](LICENSE)。