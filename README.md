# magpie-ima-auth

Signs in to **ima** (腾讯 ima.copilot, `ima.qq.com`) — the AI knowledge
workbench — and puts its models in front of an agent, drawn on that account's
own 算力.

One provider, `ima`. magpie has no built-in for it, so an agent set to
`ima/<model>` talks to ima directly.

> **Not official.** This is a third-party plugin. ima and ima.copilot belong to
> Tencent; this repository is not affiliated with or endorsed by them. It works
> by calling endpoints that ima publishes to no one — they can change or vanish
> without notice, and this will break when they do. Your credentials are yours:
> the plugin sends them only to `ima.qq.com`, stores them in OpenCode's or
> magpie's own auth file, and nothing here phones home.

## What ima is, and why this plugin is a bridge

ima has no OpenAI-compatible endpoint, and this plugin does not pretend
otherwise. Three of its facts shape everything:

1. **It is session-based and takes ONE question.** There is no messages array
   to send. A conversation is opened first:

   ```http
   POST /cgi-bin/session_logic/init_session
   {"env_info":{"interact_type":2,"robot_type":10000},"name":"…","msgs_limit":20}
   → {"code":0,"session_id":"…"}
   ```

   and each turn is then asked on its own:

   ```http
   POST /cgi-bin/assistant/qa          (SSE)
   {"session_id":"…","robot_type":10000,"question":"…","question_type":2,
    "client_id":"<uuid>","model_info":{"model_type":3,"model_id":"official_3"}}
   ```

   So this plugin keeps **one ima session per agent conversation**, flattens
   the client's messages into the single question ima takes, and translates
   ima's SSE back into `chat.completion` chunks.

2. **Models are a `(type, id)` pair, not a name.** `deepseek-v4-flash` is
   `model_type: 3` and `model_id: "official_3"`. Nothing in the request is
   ever the model's name.

3. **Business errors hide inside HTTP 200.** A login past its end is `code 41`,
   a refused one `600001`, a spent session `5` or `51` — all in the body of a
   `200`. Judging by status code alone makes a dead account look alive, so the
   stream is read to its `COMPLETED` / `INNER_EXCEPTION` sentinel and that is
   what decides.

## Signing in

ima has no authorization page to send a browser to and no token endpoint to
poll, so there is **no automatic sign-in** like WorkBuddy's. Two ways in:

### Account (cookie) — the reliable one

1. Sign in to <https://ima.qq.com> and send ima any message.
2. DevTools (F12) → **Network** → click the request to `/cgi-bin/assistant/qa`
   → **Request Headers**.
3. Copy the whole value of the **`x-ima-cookie`** header and paste it into
   magpie.

> **It must be that header's value, not the browser's cookie store.** ima's
> frontend puts fields in that header that never appear in the cookie store,
> and a store-only rebuild is answered with `600001 服务繁忙`. The plugin tells
> you this, because the failure otherwise looks like ima being busy.

### ima desktop's sign-in — removed

There used to be a second sign-in that read the account the ima desktop app
was signed in to, out of the app's own Chromium cookie store (decrypted under
the logged-in user's key — DPAPI on Windows). **It does not work, and it was
removed rather than shipped as a choice that fails.** What was measured:

- The store is found and the tokens decrypt. That part was fine.
- **ima never writes a signed-in session to disk.** The Extension Cookies
  store holds five of the eleven fields ima's client assembles into an
  `x-ima-cookie`, and a search of every file under the profile for the token
  value — plain and base64 — finds nothing. The session lives in the running
  process's memory.
- The five fields it does hold are the ones from *before* the last
  sign-out. Signing in again rewrites `IMA-GUID` and leaves both tokens
  byte-for-byte the same length, and ima answers them `code 41` / `110031
  token session expired`. The refresh endpoint rejects them too.
- Getting the full eleven fields needs the running client's cookies, which
  means a debugging port. ima ignores `--remote-debugging-port` — the flag
  reaches the main process's command line and nothing ever listens.

So the option could only ever fail, and a user picking it would have no way
to tell why. The pasted cookie is the whole of what works.

The store is still worth writing down for whoever looks next: ima's login
lives in `Extension Cookies` and not in `Default/Network/Cookies`, which
holds a few hundred advertising cookies and none of ima's.

```
%LOCALAPPDATA%\ima.copilot\User Data\Default\Extension Cookies    ← the login
%LOCALAPPDATA%\ima.copilot\User Data\Default\Network\Cookies      ← ad cookies, none of ima's
```

While ima is running, neither store can be read — Chromium holds them with a
lock that `copyFileSync`, `readFileSync`, a hand-rolled `openSync`/`readSync`
loop, `[System.IO.File]::Open` with `FileShare.ReadWrite`, `esentutl /y` and
`sqlite3` with `immutable=1` were all measured against, and none of them got
past it.

## Where the sign-in is kept

As an OpenCode `oauth` auth: the `IMA-TOKEN` as `access`, the
`IMA-REFRESH-TOKEN` as `refresh`, the token's end, the account, and the whole
cookie under `cookie` (ima needs several of its fields at once, and OpenCode's
auth shape has no way to name them). OpenCode keeps it in `auth.json`; magpie
in `plugin-auth.json`.


## Tokens

ima's token lives about two hours and is renewed at `POST /auth_login/refresh`
with `{refresh_token, user_id, registration_id}`.

**ima rotates the refresh token** — a renewal spends the old one. Two
concurrent renewals of one account leave the second holding a dead token, and
every request after it fails `600001` until the account is signed in again.
Renewals are therefore single-flighted, keyed by account and refresh token.
This is a correctness requirement, not an optimisation.

magpie (with `refreshLead`) renews ahead of time, once per account, before its
requests and model list. The check inside the loader stays for OpenCode, which
doesn't call `auth.refresh`. A renewal that fails leaves the current token in
use while it lasts, and says so once per account rather than on every request.

## Requests

One agent conversation = one ima session, kept 30 minutes and identified by
the session magpie names (its `chat.headers` hook), else the chat's first user
message.

- The chat's instructions (system and developer messages) ride on the
  **first** question of a session: ima has no system role, and repeating an
  agent's whole system prompt on every turn of a long session would spend most
  of the window on it. Verified: an instruction to answer in under 15
  characters is obeyed.
- Text events are **deltas**, not the answer so far, and are concatenated.
  Verified over a 29-event answer.
- A thinking model sends its reasoning as its own block —
  `{"Type":"blockThinking","Data":{"thinking_message":{"Message":…}}}` — also a
  delta stream, but under `Message` where the answer uses `Text`. It goes to
  `reasoning_content`, never into `content`.
- `SUGGEST_QUESTION`, which ima sends after every answer, is a **list** of
  suggestions whose items each carry a `Text`. It is not the answer, and must
  not be read as one.
- ima states a 20-message session limit (`msgs_limit: 20` is what the frontend
  sends) but **does not enforce it**: a session accepted 13 turns, 26 messages,
  without complaint. So this plugin does not rotate at that limit — rotating
  there would throw away live context for nothing. The code 5 / 51 recovery is
  what handles a session ima really has finished, and a far-backstop rotation
  at 60 messages is all that runs unasked.
- Images and other non-text parts become `[an image, which this model can't
  see]` rather than vanishing — a message that silently loses its figure reads
  to the model as a question about nothing.

## Two chats, one endpoint

ima has two different conversations on the same account, and they share an
endpoint but nothing else. Which one a turn belongs to is decided by three
request fields, all measured against a real account:

| | knowledge base Q&A | **copilot** |
|---|---|---|
| endpoint | `/cgi-bin/assistant/qa` | `/cgi-bin/assistant/qa` |
| `robot_type` | `10000` | **`15`** |
| `command_info` | `{question_info:{}}` | **`{type:2000, copilot_qa_info:{}}`** |
| `model_type` | 3 / 0 / 1001 / 3000 | **`110000`** (`OfficialPaid`) |
| `Content-Type` | `application/json` | **`text/plain;charset=UTF-8`** |
| charged at | free Q&A | **算力**, at a per-model rate |

Neither is encrypted. The `/cgi-bin/s/` secure channel — with its
`x-ima-cm` / `x-ima-ckey` / `x-ima-ctk` headers and a native `EncryptData` that
only the desktop client can run — applies to some *other* endpoints, not to
either chat.

Model ids are namespaced `copilot/…` versus bare, because the same model is a
different ima model on each robot: Hy3 is `official_0` in the knowledge base
(free) and `official_paid_hy3` in copilot (charged at ×0.2). A custom model —
one the user added with their own API key — is the same on both, so it is
listed once, bare.

## Models

### copilot — charged at 算力

Read from `/cgi-bin/model_manage/get_models` with **`{"scene":1}`**. The ids
are per-account (`official_paid_ep-i2azx8ko` is *this* account's
DeepSeek-V4.1-Flash), so this table cannot be static — it is asked for after
signing in. The multiplier comes back in `model_token_copywriting`.

| Model id | Name | 算力 |
|---|---|---|
| `copilot/auto` | 自动选择最优模型 | ×1.0 |
| `copilot/hy3` | Hy3 | ×0.2 |
| `copilot/hy4-preview` | Hy4 preview | ×0.9 |
| `copilot/deepseek-v4.1-flash` | DeepSeek-V4.1-Flash | ×0.2 闲时 |
| `copilot/mimo-v2.6-flash` | MiMo-V2.6-Flash | ×0.2 |
| `copilot/mimo-v2.6-pro` | MiMo-V2.6-Pro | ×0.6 |
| `copilot/minimax-m3` | MiniMax-M3 | ×0.6 |
| `copilot/glm-5.3-flash` | GLM-5.3-Flash | ×0.2 |
| `copilot/glm-5.3` | GLM-5.3 | ×2.2 |
| `copilot/kimi-k2.7-code` | Kimi-K2.7-Code | ×1.9 |
| `copilot/kimi-k2.8-preview` | Kimi-K2.8-Preview | ×1.9 |
| `copilot/kimi-k3` | Kimi-K3 | ×4.5 |

The spread is 22×, which makes the rate the most consequential thing about
choosing one. Kimi-K3 at ×4.5 costs as much as twenty-three Hy3 turns.

Note that `DeepSeek-V4.1-Flash` (copilot) and `DeepSeek-V4-Flash` (knowledge
base, `official_3`) are different models.

### knowledge base — free

Read from the same endpoint with `{}`. Thinking variants come off
`sub_model_infos`, keyed `"1"` — **the key is not the model_type** (DeepSeek's
plain is type 3 and its thinking type 1), so the pair is read out of the
sub-model. `enable_thinking` is `false` on every one ima returns, including
ones that demonstrably think, so it is not read.

| Model id | Name | ima's `(type, id)` |
|---|---|---|
| `deepseek-v4-flash` | DeepSeek-V4-Flash | `3`, `official_3` |
| `deepseek-v4-flash-think` | DeepSeek-V4-Flash (think) | `1`, `official_1` |
| `hy4-preview` | Hy4 preview | `1001`, `official_1001` |
| `hy4-preview-think` | Hy4 preview (think) | `1002`, `official_1002` |
| `hy3` | Hy3 | `0`, `official_0` |
| `hy3-think` | Hy3 (think) | `2`, `official_2` |
| `glm-5.3-flash` | GLM-5.3-Flash | `3000`, `official_3000` |
| `glm-5.3-flash-think` | GLM-5.3-Flash (think) | `3001`, `official_3001` |

### custom — the account's own

`model_type: 1000000`, a UUID for an id, `describe: "自定义模型"`. These are
models the user connected with their own API key; ima charges no 算力 for
them, so they carry no rate. Their names are already ids
(`deepseek-v4.1-flash`, `kimi-k2.6`), and they answer on either robot.

**The cookie is sent exactly as signed in.** An earlier version stripped
`CLIENT-TYPE` from the catalogue request, on a misread ablation, and it made
things strictly worse: with the field, `{}` answers with four official models
plus all five customs and `{"scene":1}` with the twelve copilot models plus the
same five; without it, `{}` answers with four and no customs, and `{"scene":1}`
with six — losing every `official_paid_*` and leaving `official_100000` named
"默认模型" instead of "自动选择最优模型".

ima reports no context window in either catalogue, so the numbers in the table
are this package's own and should be believed least.

## Not supported

**Tools.** ima's Q&A endpoint takes one question string. The knowledge base's
chat has no tool channel at all, and while copilot's *client* sends a
`client_tools` list, the endpoint behind it still takes a single question —
there is no tool-call turn to send a result back on. The plugin sends an empty
list and declares every model as taking no tools, rather than pretending
otherwise. (Trae's package emulates tools by writing the schema into a prompt
and parsing tagged blocks back out; that was left out here on purpose — it is a
large parser resting on models that were never trained to emit the tags.)

Also missing, and not guessed at:

- **Knowledge-base targeting.** ima's Q&A runs against whatever the session
  was opened with; this plugin opens plain sessions, not ones scoped to a
  knowledge base id.

## 算力 and the daily login

Both are magpie's own hooks, which OpenCode ignores. Their shapes are not this
package's invention — magpie ships its contract as a comment on each hook in
its source (`auth.usage` and `auth.checkin`, read out of
`magpie-windows-amd64.exe`), and this package answers in exactly those terms:

```js
auth.usage(getAuth, provider) → {
  plan?, user?, until?, renew?: "auto" | "off", balance?, error?,
  resets?: { count, until?, byWindow?, fiveHour?, weekly? },
  windows?: [{ name, used /*percent*/, display?, amount?, limit?, unit?, … }],
  signIn?: "expired" | "kept" | "renewed",
}

auth.checkin(getAuth, provider) → {
  outcome: "claimed" | "done" | "ineligible" | "inactive" | "captcha" | "failed",
  credit?, streak?, message?,
}
```

`balance` is a **string**, not a number — magpie renders it verbatim under
"What is left on the account besides its windows", which is exactly what 算力
is:

```js
{ balance: "279.4 算力", user: "<uid>", windows: [] }
```

ima publishes no rate-limit window, so `windows` stays empty rather than
carrying an invented one. `signIn` is only ever set when the sign-in really is
gone: a transport failure must not mark the account expired.

The daily login reads as:

```js
{ outcome: "done", credit: "50算力", streak: 4 }
```

The claim is `POST /cgi-bin/daily_login_activity/check_in`. Three things about
it are worth knowing, because two of them cost most of the time to find:

- **The status is read first, and the claim is only sent on a day that is not
  already paid out.** `get_activity_info` lists the last seven days with a
  status each — `1` expired, `2` already claimed, `4` not reached yet — and
  `满签奖励` is a bonus row, not a day, so it must not be read as one. On an
  already-claimed day this answers `"done"` without sending anything, which is
  the only guarantee that a wrong constant cannot pay out twice.
- **It is plain, not behind the crypto channel.** A refusal comes back as HTTP
  403 with an *empty body* and `trpc-func-ret: 20002` — not one of the
  channel's own rejections (20004/20005/20006), and the same request under
  `/cgi-bin/s/` is a 404. Unlike both chats, it needs no bridge.
- **A refusal answers `"failed"`, not `"ineligible"`.** magpie retries a failure
  later the same day and stops asking about an ineligible account; a 403 on a
  day that was not already paid out is worth another try. The same goes for an
  empty day list — that is ima's shape changing, not an account without a daily
  login, so it is `"failed"` rather than `"inactive"`.
- **`reward_type` is a guess.** It is a protobuf enum whose names never reach
  the client; omitting it gets `invalid reward type: TYPE_UNSPECIFIED`, and
  every value tried answered identically. `1` is wired in and pinned by a test,
  but it has never been seen to succeed: on every day measured so far the day
  was already claimed, so the 403/20002 cannot be told apart from a wrong
  constant. Run `node scripts/verify-quota-live.mjs` on a morning before
  claiming in the app to settle it — the balance in that run's last line is the
  proof.

`POST /cgi-bin/token_manager/get_history` reads the 算力 ledger with
`{ page_size, tab }`; without a `tab` ima answers `invalid history tab`.

## Use

In magpie, from **设置 → 插件** (Plugins): paste any one of these into the box
marked *"已有想装的？"* and press 安装 —

```
github:dongsujiang0205-coder/magpie-ima-auth    from GitHub
D:\path\to\magpie-ima-auth                      a folder on this machine
magpie-ima-auth                                 from npm, once published
```

— or from a terminal, if magpie is on your PATH:

```sh
magpie plugin add github:dongsujiang0205-coder/magpie-ima-auth
magpie plugin login ima
```

`plugin login ima` prints the cookie instructions below and waits for the value
to be pasted.

OpenCode, in `opencode.json`:

```json
{ "plugin": ["magpie-ima-auth"] }
```

then `opencode auth login`.

## Checking it

```sh
npm test             # 46 tests, including an end-to-end turn against a fake ima
node smoke.mjs       # 10 checks: every hook magpie calls, in magpie's own shapes

$env:IMA_COOKIE = "..."        # the x-ima-cookie header's own value, from a real ima
npm run verify:live            # the plugin's own code, against real ima
npm run verify:quota           # 算力 balance, and the daily check-in claim
npm run scan                   # nothing identifying in what this repository ships
```

Run `verify:quota` on a morning **before** signing in through the app. It
reads the day list, sends the claim only when the day has not been paid out,
and prints whether the balance moved — which is the only thing that settles
the `reward_type` constant, for the reason given above.

The tests run a real HTTP server that speaks ima's session + SSE shape
(`IMA_HOST` points the plugin at it), so the bridge is exercised for what it
is — translating between two wire formats — rather than mocked at the seams.

`verify-live.mjs` re-runs the whole thing against a real account: the model
catalogue, a non-streaming turn with instructions, a streaming turn on a
thinking model, three turns of one conversation (asking it to recall a number
and then do arithmetic on it, which only works if the session is real), and an
unknown model id. It asks real questions and leaves them in the account's ima
history, and it never calls `/auth_login/refresh`.

`read-magpie-binary.mjs` is how magpie's plugin contract was read rather than
guessed: it pulls the readable text around a needle out of magpie's Bun
single-file executable, and the comments on `auth.usage` / `auth.checkin` there
are what this plugin answers in. Pass it the path to your magpie binary:

```sh
node scripts/read-magpie-binary.mjs "<path to magpie>" auth.checkin
```

`scan-personal.mjs` is what you run before publishing a fork: it checks every
file the repository ships for a credential, a device fingerprint, a Windows
profile name or an opaque secret.

## Where the protocol comes from

Everything above marked "measured" was run against a real account with the
tools in `scripts/`. The rest was cross-checked against two independent
implementations that agree on it:

- [`chipchipss/buddyhub`](https://github.com/chipchipss/buddyhub) — Go, a
  running gateway (`internal/extprovider/ima/`), whose notes say it was
  ported from `ima2api`.
- [`whynpc9/opencli-plugin-ima`](https://github.com/whynpc9/opencli-plugin-ima)
  — Node, documents the same headers, and records the `600001` that a
  store-rebuilt cookie gets. That was confirmed by accident here: a
  hand-pasted browser cookie jar carries **no** `IMA-*` field at all.

Where those two disagreed with a real account, the account won, and it won
often:

- `official_3000` is GLM-5.3-Flash, not the GLM-5.2 both tables call it.
- `models` is at the top level of the catalogue answer, not in a `data`
  envelope.
- The 20-message session limit is not enforced.
- **The copilot models are not in either implementation**, because both target
  the knowledge base's Q&A. copilot is `robot_type: 15` on the same endpoint
  with a different `command_info`, and it has twelve models those tables never
  mention, including one account has no name for: the ids are per-account.
- `/cgi-bin/s/` and its `EncryptData` turn out to have nothing to do with
  either chat. The reverse-engineering of them was a wrong turn taken because
  the two implementations' notes were followed instead of asking ima.

## License

MIT