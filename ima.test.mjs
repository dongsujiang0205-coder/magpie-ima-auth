// The plugin's own tests: the ima protocol facts, and one end-to-end turn
// through the bridge against a fake ima.
//
//   node ima.test.mjs
//
// The fake is the point of IMA_HOST: it is a real HTTP server that speaks
// ima's session + SSE shape, so the bridge is exercised for what it is —
// translating between two wire formats — rather than mocked at the seams.

import assert from "node:assert/strict"
import { createServer } from "node:http"
import { after, before, describe, it } from "node:test"

// the fake has to exist before the plugin is imported: the host is read once,
// at load
const fake = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost")
  const body = await new Promise((r) => {
    let s = ""
    req.on("data", (c) => (s += c))
    req.on("end", () => r(s))
  })

  if (!/^IMA-TOKEN=/.test(req.headers["x-ima-cookie"] ?? "")) {
    res.writeHead(401, { "content-type": "application/json" })
    return res.end(JSON.stringify({ code: 41, msg: "登录已过期" }))
  }
  if (req.headers["x-ima-bkn"] !== String(tokenBkn(req.headers["x-ima-cookie"]))) {
    res.writeHead(400, { "content-type": "application/json" })
    return res.end(JSON.stringify({ code: 9001, msg: "bad bkn" }))
  }

  const env = body ? JSON.parse(body) : {}

  // Fault injection. These tests used to swap globalThis.fetch, which is a race:
  // a concurrently-running test that reaches the fake server goes through the
  // mock instead of the server and asserts against a fabricated answer. Driving
  // the failure through the server itself keeps every test on the real path.
  if (fake.fail) {
    const mode = fake.fail.path ? url.pathname === fake.fail.path : true
    if (mode) {
      if (fake.fail.network) {
        req.destroy()
        return
      }
      if (fake.fail.status) {
        for (const [k, v] of Object.entries(fake.fail.headers ?? {})) res.setHeader(k, v)
        res.writeHead(fake.fail.status)
        return res.end(fake.fail.body ?? "")
      }
      if (fake.fail.body !== undefined) {
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(fake.fail.body)
      }
    }
  }

  if (url.pathname === "/auth_login/refresh") {
    // ima's renewal authenticates with the REFRESH token, not the access one,
    // and hands back a token the account can then use
    if (env.refresh_token !== "R1") {
      res.writeHead(401, { "content-type": "application/json" })
      return res.end(JSON.stringify({ code: 41, msg: "refresh token 已失效" }))
    }
    fake.refreshed.push(env)
    fake.issued.add("T2")
    return json(res, { code: 0, token: "T2", token_valid_time: 7200 })
  }

  // everything else needs a token the account actually holds
  if (!fake.issued.has(tokenOf(req.headers["x-ima-cookie"]))) {
    res.writeHead(401, { "content-type": "application/json" })
    return res.end(JSON.stringify({ code: 41, msg: "登录已过期" }))
  }

  if (url.pathname === "/cgi-bin/session_logic/init_session") {
    fake.sessions.push({ id: "sess-" + (++fake.n), name: env.name, limit: env.msgs_limit, robot: env.env_info?.robot_type })
    // session_id at the TOP level, not in a data envelope: reading it out of
    // `data` is the bug this shape exists to catch
    return json(res, { code: 0, session_id: fake.sessions.at(-1).id })
  }

if (url.pathname === "/cgi-bin/model_manage/get_models") {
  // scene picks the catalogue, exactly as ima does: {} is the knowledge base's
  // four official models plus the account's custom ones, {"scene":1} is
  // copilot's twelve, each carrying its 算力 multiplier, plus the same customs
  const body2 = JSON.parse(body || "{}")
  if (body2.scene === 1) {
    return json(res, {
      code: 0,
      preferred_model_id: "official_paid_ep-i2azx8ko",
      models: [
        { model_type: 100000, model_id: "official_100000", model_name: "自动选择最优模型", model_token_copywriting: "×1.0" },
        { model_type: 110000, model_id: "official_paid_hy3", model_name: "Hy3", model_token_copywriting: "×0.2" },
        { model_type: 110000, model_id: "official_paid_hy4-preview", model_name: "Hy4 preview", model_token_copywriting: "×0.9" },
        { model_type: 110000, model_id: "official_paid_ep-i2azx8ko", model_name: "DeepSeek-V4.1-Flash", model_token_copywriting: "×0.2 闲时" },
        { model_type: 110000, model_id: "official_paid_ep-4iwlzjkt", model_name: "Kimi-K3", model_token_copywriting: "×4.5" },
        { model_type: 1000000, model_id: "30ffaea1-7853-4a81-ad7c-919da6eeb486", model_name: "deepseek-flash", describe: "自定义模型" },
      ],
    })
  }
  // the real shape: models at the TOP LEVEL (not in a data envelope), each
  // carrying its thinking sibling under sub_model_infos, where the key is
  // NOT the model_type
  return json(res, {
    code: 0,
    preferred_model_id: "official_9",
    models: [
      { model_type: 3, model_id: "official_3", model_name: "DeepSeek-V4-Flash", is_default: true, sub_model_infos: { 0: { model_type: 3, model_id: "official_3" }, 1: { model_type: 1, model_id: "official_1" } } },
      { model_type: 9, model_id: "official_9", model_name: "Something New", sub_model_infos: {} },
      { model_type: 1000000, model_id: "30ffaea1-7853-4a81-ad7c-919da6eeb486", model_name: "deepseek-flash", describe: "自定义模型" },
    ],
  })
}

  if (url.pathname === "/cgi-bin/assistant/qa") {
    fake.asked.push({ ...env, contentType: req.headers["content-type"] })
    if (env.session_id === "dead") {
      res.writeHead(200, { "content-type": "text/event-stream" })
      return res.end("event: INNER_EXCEPTION\ndata: {\"Code\":51,\"Msg\":\"session gone\"}\n\n")
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    // the body text is nested: Data.text_message.Text. Reading only the top
    // level finds nothing and looks like an empty answer
    res.write("event: STRUCTURED_BLOCK\ndata: " + JSON.stringify({ Type: "loading" }) + "\n\n")
    // a thinking model says its reasoning first, in its own block, under
    // Message where the answer uses Text
    if (env.model_info?.model_type === 1) {
      for (const piece of ["27", "²", "=", " 729", "。"]) {
        res.write("event: STRUCTURED_BLOCK\ndata: " + JSON.stringify({ Type: "blockThinking", Data: { thinking_message: { Message: piece } }, Id: "t1" }) + "\n\n")
      }
      res.write("event: STRUCTURED_BLOCK\ndata: " + JSON.stringify({ Type: "blockThinking", Data: { thinking_message: { Status: 2, Tips: "思考完成" } }, Id: "t1" }) + "\n\n")
    }
    for (const piece of ["你", "好", "，", "世界"]) {
      res.write("event: STRUCTURED_BLOCK\ndata: " + JSON.stringify({ Type: "blockMessage", Data: { text_message: { Text: piece } } }) + "\n\n")
    }
    // a list, not an object, each item carrying a Text — which must NOT be
    // read as the answer
    res.write('event: SUGGEST_QUESTION\ndata: [{"Text":"你要不要看点别的"},{"Text":"再说点什么"}]\n\n')
    res.write("event: STRUCTURED_BLOCK\ndata: " + JSON.stringify({ Type: "loading", Data: {} }) + "\n\n")
    return res.end("event: COMPLETED\ndata: {\"Code\":0,\"Msg\":\"\"}\n\n")
  }

  // 算力 balance. The numbers sit at the top level of the envelope, not under
  // `data`, and display_amount is a string — both are load-bearing.
  if (url.pathname === "/cgi-bin/token_manager/get_balance") {
    return json(res, {
      code: 0,
      msg: "ok",
      balance: "279",
      display_amount: "279.4",
      display_activity_amount: "279.4",
      display_paid_amount: "0",
      real_balance: "0",
      balance_infos: [],
    })
  }

  res.writeHead(404).end("{}")
})

function json(res, o) {
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify(o))
}
fake.sessions = []
fake.asked = []
fake.refreshed = []
// set by a test to make the server answer wrongly; null means behave normally
fake.fail = null
fake.n = 0
fake.issued = new Set(["T1"])

const tokenOf = (cookie) => /IMA-TOKEN=([^;]*)/.exec(cookie ?? "")?.[1] ?? ""

// the same djb2 the plugin computes, written out again on purpose: a copy of
// the implementation would make the bkn test prove nothing
function tokenBkn(cookie) {
  const t = tokenOf(cookie)
  let h = 5381
  for (let i = 0; i < t.length; i++) h += (h << 5) + t.charCodeAt(i)
  return h & 0x7fffffff
}

before(async () => {
  await new Promise((r) => fake.listen(0, "127.0.0.1", r))
  fake.port = fake.address().port
  process.env.IMA_HOST = `http://127.0.0.1:${fake.port}`
  const { _internal } = await import("./index.mjs")
  fake.i = _internal
})

after(() => fake.close())

const COOKIE = "IMA-TOKEN=T1; IMA-REFRESH-TOKEN=R1; IMA-UID=U1; UID-TYPE=1"

describe("bkn", () => {
  it("is djb2 masked to a positive int, and the fake ima accepts what it computes", () => {
    assert.equal(fake.i.bkn(""), "5381")
    assert.equal(String(fake.i.bkn("abc")), String(tokenBkn("IMA-TOKEN=abc; IMA-UID=U1")))
    assert.match(fake.i.bkn("abc"), /^\d+$/)
    assert.ok(Number(fake.i.bkn("abc")) >= 0)
  })
})

describe("cookies", () => {
  it("reads a field out of the x-ima-cookie header", () => {
    assert.equal(fake.i.cookieField(COOKIE, "IMA-TOKEN"), "T1")
    assert.equal(fake.i.cookieField(COOKIE, "IMA-UID"), "U1")
    assert.equal(fake.i.cookieField(COOKIE, "NOPE"), "")
  })

  it("replaces only IMA-TOKEN, which is what a renewal changes", () => {
    const next = fake.i.withToken(COOKIE, "T2")
    assert.equal(fake.i.cookieField(next, "IMA-TOKEN"), "T2")
    assert.equal(fake.i.cookieField(next, "IMA-REFRESH-TOKEN"), "R1")
    assert.equal(fake.i.cookieField(next, "IMA-UID"), "U1")
  })

  it("appends when the cookie had no token", () => {
    assert.match(fake.i.withToken("IMA-UID=U1", "T9"), /IMA-TOKEN=T9/)
  })
})

describe("a session's name", () => {
  it("is the question, cut at 50 characters, never empty", () => {
    assert.equal(fake.i.title(""), "新对话")
    assert.equal(fake.i.title("   "), "新对话")
    assert.equal(fake.i.title("x".repeat(80)).length, 50)
    assert.equal(fake.i.title("你好"), "你好")
  })
})

describe("ima's SSE text", () => {
  it("reads the nested body text, which is where it actually is", () => {
    const raw = JSON.stringify({ Type: "blockMessage", Data: { text_message: { Text: "你好" } } })
    assert.equal(fake.i.eventText("STRUCTURED_BLOCK", raw), "你好")
  })

  it("returns nothing for an event that carries none", () => {
    assert.equal(fake.i.eventText("STRUCTURED_BLOCK", JSON.stringify({ Type: "loading" })), "")
    assert.equal(fake.i.eventText("SEARCH_MEDIAS", ""), "")
    assert.equal(fake.i.eventText("ANY", "not json at all"), "")
  })

  it("does not read a suggestion list as the answer", () => {
    // SUGGEST_QUESTION's data is an ARRAY whose items each carry a Text.
    // ima sends one after every answer; reading it would append two unrelated
    // questions to every reply.
    const raw = JSON.stringify([{ Text: "你要不要看点别的" }, { Text: "再说点什么" }])
    assert.equal(fake.i.eventText("SUGGEST_QUESTION", raw), "")
  })
})

describe("ima's reasoning", () => {
  const thinking = (piece) => JSON.stringify({ Type: "blockThinking", Data: { thinking_message: { Message: piece } }, Id: "t1" })
  const done = JSON.stringify({ Type: "blockThinking", Data: { thinking_message: { Status: 2, Tips: "思考完成" } }, Id: "t1" })

  it("is its own block, under Message, and is read separately from the answer", () => {
    assert.equal(fake.i.eventThinking("STRUCTURED_BLOCK", thinking("729")), "729")
    // the block's last event is a marker, not text
    assert.equal(fake.i.eventThinking("STRUCTURED_BLOCK", done), "")
    // and none of it leaks into the answer
    assert.equal(fake.i.eventText("STRUCTURED_BLOCK", thinking("729")), "")
  })

  it("is empty for a plain model's events", () => {
    assert.equal(fake.i.eventThinking("STRUCTURED_BLOCK", JSON.stringify({ Type: "blockMessage", Data: { text_message: { Text: "好" } } })), "")
  })
})

describe("errors inside a 200", () => {
  it("takes the code off a COMPLETED", () => {
    const e = fake.i.errorIn("COMPLETED", JSON.stringify({ Code: 14018, Msg: "额度已用尽" }))
    assert.equal(e.code, 14018)
    assert.match(e.message, /额度已用尽/)
  })

  it("passes a COMPLETED with code 0", () => {
    assert.equal(fake.i.errorIn("COMPLETED", JSON.stringify({ Code: 0, Msg: "" })), null)
  })

  it("treats INNER_EXCEPTION as a failure", () => {
    const e = fake.i.errorIn("INNER_EXCEPTION", JSON.stringify({ Code: 51, Msg: "gone" }))
    assert.equal(e.code, 51)
    assert.equal(e.session, true)
  })

  it("reads 41 as a dead sign-in", () => {
    assert.equal(fake.i.errorIn("ERROR", JSON.stringify({ Code: 41, Msg: "登录已过期" })).auth, true)
    assert.equal(fake.i.errorIn("ERROR", JSON.stringify({ Code: 600001, Msg: "服务繁忙" })).auth, true)
  })
})

describe("the client's chat, as ima takes it", () => {
  it("reads the text out of parts, marking what ima can't see", () => {
    assert.equal(fake.i.partText("hi"), "hi")
    assert.equal(fake.i.partText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb")
    assert.match(fake.i.partText([{ type: "image_url", image_url: { url: "http://x" } }]), /can't see/)
  })

  it("takes the question as the last user turn, and skips a tool result", () => {
    assert.equal(fake.i.lastUserText({ messages: [{ role: "user", content: "one" }, { role: "assistant", content: "two" }, { role: "user", content: "three" }] }), "three")
    assert.equal(fake.i.lastUserText({ messages: [{ role: "user", content: "" }] }), "")
    assert.equal(fake.i.lastUserText({}), "")
  })

  it("keeps the instructions out of the question", () => {
    const chat = { messages: [{ role: "system", content: "be brief" }, { role: "developer", content: "and kind" }, { role: "user", content: "hi" }] }
    assert.equal(fake.i.systemText(chat), "be brief\n\nand kind")
    assert.equal(fake.i.lastUserText(chat), "hi")
  })
})

describe("one conversation, one ima session", () => {
  it("prefers the session magpie named, else the first user message", () => {
    const chat = { messages: [{ role: "user", content: "first" }, { role: "user", content: "second" }] }
    assert.equal(fake.i.conversationOf(chat, "s1"), "session:s1")
    assert.equal(fake.i.conversationOf(chat, ""), "first:first")
    assert.equal(fake.i.conversationOf({}, ""), "")
  })
})

describe("models", () => {
  it("are a (type, id) pair, not a name", () => {
    const m = fake.i.modelFor({ uid: "U1" }, "deepseek-v4-flash")
    assert.equal(m.type, 3)
    assert.equal(m.modelId, "official_3")
  })

  it("fall back to a real model for one this plugin doesn't know", () => {
    const m = fake.i.modelFor({ uid: "U1" }, "some-model-nobody-declared")
    assert.ok(fake.i.MODELS.some((x) => x[0] === m.id))
  })
})

describe("end to end, against the fake", () => {
  it("carries the cookie and bkn, and asks on a session it opened", async () => {
    fake.asked.length = 0
    fake.sessions.length = 0
    const { ImaAuthPlugin } = await import("./index.mjs")
    const plugin = await ImaAuthPlugin({ client: { auth: { set: async () => {} } } })
    const auth = { type: "oauth", access: "T1", refresh: "R1", cookie: COOKIE, uid: "U1", accountId: "U1", expires: Date.now() + 7200_000 }
    const { fetch: ask } = await plugin.auth.loader(async () => auth)

    const res = await ask(`${process.env.IMA_HOST}/cgi-bin/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-ima-session": "conv-1" },
      body: JSON.stringify({ model: "deepseek-v4-flash", stream: false, messages: [{ role: "system", content: "be brief" }, { role: "user", content: "你好" }] }),
    })

    assert.equal(res.status, 200)
    const body = await res.json()
    // the whole point of the bridge: four nested events arrive as one answer
    assert.equal(body.choices[0].message.content, "你好，世界")
    assert.equal(body.object, "chat.completion")

    assert.equal(fake.sessions.length, 1)
    assert.equal(fake.sessions[0].limit, fake.i.MSGS_LIMIT)
    assert.equal(fake.asked.length, 1)
    // the instructions have no role of their own in ima, so they ride along
    assert.match(fake.asked[0].question, /be brief/)
    assert.match(fake.asked[0].question, /你好/)
    assert.deepEqual(fake.asked[0].model_info, { model_type: 3, model_id: "official_3", enable_enhancement: false })
    assert.equal(fake.asked[0].session_id, fake.sessions[0].id)
  })

  it("streams the same turn as chat.completion.chunk, ending at [DONE]", async () => {
    const { ImaAuthPlugin } = await import("./index.mjs")
    const plugin = await ImaAuthPlugin({ client: { auth: { set: async () => {} } } })
    const auth = { type: "oauth", access: "T1", refresh: "R1", cookie: COOKIE, uid: "U1", accountId: "U1", expires: Date.now() + 7200_000 }
    const { fetch: ask } = await plugin.auth.loader(async () => auth)

    const res = await ask(`${process.env.IMA_HOST}/cgi-bin/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-ima-session": "conv-2" },
      body: JSON.stringify({ model: "deepseek-v4-flash", stream: true, messages: [{ role: "user", content: "你好" }] }),
    })

    const text = await res.text()
    const frames = text.split("\n\n").filter(Boolean)
    assert.equal(frames.at(-1), "data: [DONE]")
    const chunks = frames.slice(0, -1).map((f) => JSON.parse(f.replace(/^data: /, "")))
    assert.ok(chunks.every((c) => c.object === "chat.completion.chunk"))
    assert.equal(chunks.map((c) => c.choices[0].delta.content ?? "").join(""), "你好，世界")
    assert.equal(chunks.at(-1).choices[0].finish_reason, "stop")
    // the "loading" event carries no text and must not become a chunk
    assert.equal(chunks.length, 5)
  })

  it("reuses one session for a second turn of the same conversation", async () => {
    fake.sessions.length = 0
    fake.asked.length = 0
    const { ImaAuthPlugin } = await import("./index.mjs")
    const plugin = await ImaAuthPlugin({ client: { auth: { set: async () => {} } } })
    const auth = { type: "oauth", access: "T1", refresh: "R1", cookie: COOKIE, uid: "U1", accountId: "U1", expires: Date.now() + 7200_000 }
    const { fetch: ask } = await plugin.auth.loader(async () => auth)
    const send = (q) =>
      ask(`${process.env.IMA_HOST}/cgi-bin/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-magpie-ima-session": "conv-3" },
        body: JSON.stringify({ model: "deepseek-v4-flash", stream: false, messages: [{ role: "user", content: q }] }),
      })

    await send("first")
    await send("second")

    assert.equal(fake.sessions.length, 1, "a second turn must not open a second session")
    assert.equal(fake.asked.length, 2)
    assert.equal(fake.asked[0].session_id, fake.asked[1].session_id)
    // only the first question carries the opening; the second is the question
    assert.equal(fake.asked[1].question, "second")
  })

  it("renews a refused sign-in once and asks again on the new token", async () => {
    fake.refreshed.length = 0
    const { ImaAuthPlugin } = await import("./index.mjs")
    const plugin = await ImaAuthPlugin({ client: { auth: { set: async () => {} } } })
    // a token the account never held: ima answers 41, which means renew, not
    // "your account is dead"
    const auth = { type: "oauth", access: "STALE", refresh: "R1", cookie: "IMA-TOKEN=STALE; IMA-UID=U1", uid: "U1", accountId: "U1", expires: Date.now() + 7200_000 }
    const { fetch: ask } = await plugin.auth.loader(async () => auth)
    const res = await ask(`${process.env.IMA_HOST}/cgi-bin/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-ima-session": "conv-renew" },
      body: JSON.stringify({ model: "deepseek-v4-flash", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(res.status, 200, "a refused token should be renewed and the turn retried, not reported")
    assert.equal(fake.refreshed.length, 1, "renewal happens once, not once per request")
    assert.equal((await res.json()).choices[0].message.content, "你好，世界")
  })

  it("says a sign-in that can't be renewed plainly", async () => {
    const { ImaAuthPlugin } = await import("./index.mjs")
    const plugin = await ImaAuthPlugin({ client: { auth: { set: async () => {} } } })
    const auth = { type: "oauth", access: "STALE", refresh: "WRONG-REFRESH", cookie: "IMA-TOKEN=STALE; IMA-UID=U1", uid: "U1", accountId: "U1", expires: Date.now() + 7200_000 }
    const { fetch: ask } = await plugin.auth.loader(async () => auth)
    const res = await ask(`${process.env.IMA_HOST}/cgi-bin/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get("x-magpie-sign-in"), "expired")
    assert.match((await res.json()).error.message, /Sign in again/)
  })

  it("refuses a chat with no user turn rather than asking nothing", async () => {
    const { ImaAuthPlugin } = await import("./index.mjs")
    const plugin = await ImaAuthPlugin({ client: { auth: { set: async () => {} } } })
    const auth = { type: "oauth", access: "T1", refresh: "R1", cookie: COOKIE, uid: "U1", accountId: "U1", expires: Date.now() + 7200_000 }
    const { fetch: ask } = await plugin.auth.loader(async () => auth)
    const res = await ask(`${process.env.IMA_HOST}/cgi-bin/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "system", content: "only instructions" }] }),
    })
    assert.equal(res.status, 400)
  })
it("keeps a thinking model's reasoning out of the answer", async () => {
    const { ImaAuthPlugin } = await import("./index.mjs")
    const plugin = await ImaAuthPlugin({ client: { auth: { set: async () => {} } } })
    const auth = { type: "oauth", access: "T1", refresh: "R1", cookie: COOKIE, uid: "U1", accountId: "U1", expires: Date.now() + 7200_000 }
    const { fetch: ask } = await plugin.auth.loader(async () => auth)

    const res = await ask(`${process.env.IMA_HOST}/cgi-bin/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-ima-session": "conv-think" },
      body: JSON.stringify({ model: "deepseek-v4-flash-think", stream: false, messages: [{ role: "user", content: "你好" }] }),
    })
    const body = await res.json()
    assert.equal(body.choices[0].message.content, "你好，世界", "the answer must be the answer alone")
    assert.equal(body.choices[0].message.reasoning_content, "27²= 729。")
  })

  it("streams reasoning as reasoning_content and the answer as content", async () => {
    const { ImaAuthPlugin } = await import("./index.mjs")
    const plugin = await ImaAuthPlugin({ client: { auth: { set: async () => {} } } })
    const auth = { type: "oauth", access: "T1", refresh: "R1", cookie: COOKIE, uid: "U1", accountId: "U1", expires: Date.now() + 7200_000 }
    const { fetch: ask } = await plugin.auth.loader(async () => auth)

    const res = await ask(`${process.env.IMA_HOST}/cgi-bin/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-ima-session": "conv-think2" },
      body: JSON.stringify({ model: "deepseek-v4-flash-think", stream: true, messages: [{ role: "user", content: "你好" }] }),
    })
    const frames = (await res.text()).split("\n\n").filter(Boolean)
    const chunks = frames.slice(0, -1).map((f) => JSON.parse(f.replace(/^data: /, ""))).filter((c) => c.choices?.[0]?.delta)
    const content = chunks.map((c) => c.choices[0].delta.content ?? "").join("")
    const reasoning = chunks.map((c) => c.choices[0].delta.reasoning_content ?? "").join("")
    assert.equal(content, "你好，世界")
    assert.equal(reasoning, "27²= 729。")
    // neither leaks into the other
    assert.ok(!content.includes("729"))
    assert.ok(!reasoning.includes("世界"))
  })
})

describe("the account's own model list", () => {
  it("reads models off the top level, with the thinking sibling from sub_model_infos", async () => {
    const { ImaAuthPlugin } = await import("./index.mjs")
    const plugin = await ImaAuthPlugin({ client: { auth: { set: async () => {} } } })
    const auth = { type: "oauth", access: "T1", refresh: "R1", cookie: COOKIE, uid: "U1", accountId: "U1", expires: Date.now() + 7200_000 }
    const out = await plugin.provider.models({ id: "ima" }, { auth })
    const ids = Object.keys(out)
    assert.ok(ids.includes("deepseek-v4-flash"), "the plain model is listed")
    assert.ok(ids.includes("deepseek-v4-flash-think"), "its thinking sibling is listed too, under the static table's id")
    assert.ok(ids.includes("official_9"), "a model the static table never heard of is still offered")
    assert.ok(out["deepseek-v4-flash-think"].variants, "the thinking model declares reasoning")
    assert.equal(fake.modelsReads, undefined) // nothing asserted here, see below
  })

  it("sends the pair the catalogue named, not the one the key suggests", async () => {
    // sub_model_infos is keyed "1" for the thinking sibling, but its
    // model_type is 1 here while DeepSeek's own plain is type 3 — computing the
    // pair from the key would ask for the wrong model
    const { ImaAuthPlugin } = await import("./index.mjs")
    const plugin = await ImaAuthPlugin({ client: { auth: { set: async () => {} } } })
    const auth = { type: "oauth", access: "T1", refresh: "R1", cookie: COOKIE, uid: "U2", accountId: "U2", expires: Date.now() + 7200_000 }
    fake.asked.length = 0
    const { fetch: ask } = await plugin.auth.loader(async () => auth)
    await ask(`${process.env.IMA_HOST}/cgi-bin/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-ima-session": "conv-cat" },
      body: JSON.stringify({ model: "deepseek-v4-flash-think", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    assert.deepEqual(fake.asked[0].model_info, { model_type: 1, model_id: "official_1", enable_enhancement: false })
  })

  it("falls back to the account's own preference for an id nothing knows", async () => {
    const { ImaAuthPlugin } = await import("./index.mjs")
    const plugin = await ImaAuthPlugin({ client: { auth: { set: async () => {} } } })
    const auth = { type: "oauth", access: "T1", refresh: "R1", cookie: COOKIE, uid: "U3", accountId: "U3", expires: Date.now() + 7200_000 }
    fake.asked.length = 0
    const { fetch: ask } = await plugin.auth.loader(async () => auth)
    await ask(`${process.env.IMA_HOST}/cgi-bin/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-ima-session": "conv-pref" },
      body: JSON.stringify({ model: "a-model-nobody-declared", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    // copilot's preferred, not the knowledge base's: scene 1's preferred_model_id
    // is a copilot model, and copilot is the larger of the two
    assert.deepEqual(fake.asked[0].model_info, { model_type: 110000, model_id: "official_paid_ep-i2azx8ko", enable_enhancement: false })
  })
})

describe("copilot", () => {
  it("asks on robot_type 15 with command_info.type 2000, not the knowledge base's", async () => {
    const { ImaAuthPlugin } = await import("./index.mjs")
    const plugin = await ImaAuthPlugin({ client: { auth: { set: async () => {} } } })
    const auth = { type: "oauth", access: "T1", refresh: "R1", cookie: COOKIE, uid: "U4", accountId: "U4", expires: Date.now() + 7200_000 }
    fake.asked.length = 0
    fake.sessions.length = 0
    const { fetch: ask } = await plugin.auth.loader(async () => auth)
    const res = await ask(`${process.env.IMA_HOST}/cgi-bin/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-ima-session": "conv-copilot" },
      body: JSON.stringify({ model: "copilot/hy3", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(res.status, 200)
    const q = fake.asked[0]
    assert.equal(q.robot_type, 15)
    assert.deepEqual(q.command_info, { type: 2000, copilot_qa_info: {} })
    assert.equal(q.model_info.model_id, "official_paid_hy3")
    assert.equal(q.model_info.model_type, 110000)
    // the desktop client sends a chat as text/plain, and copilot answers only when it does
    assert.match(String(q.contentType ?? "text/plain"), /text\/plain/)
    // and it carries a tool list, which this sends empty
    assert.deepEqual(q.client_tools, [])
    // the session was opened by the copilot robot
    assert.equal(fake.sessions[0].robot, 15)
  })

  it("keeps the knowledge base's robot for a knowledge-base model", async () => {
    const { ImaAuthPlugin } = await import("./index.mjs")
    const plugin = await ImaAuthPlugin({ client: { auth: { set: async () => {} } } })
    const auth = { type: "oauth", access: "T1", refresh: "R1", cookie: COOKIE, uid: "U5", accountId: "U5", expires: Date.now() + 7200_000 }
    fake.asked.length = 0
    fake.sessions.length = 0
    const { fetch: ask } = await plugin.auth.loader(async () => auth)
    await ask(`${process.env.IMA_HOST}/cgi-bin/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-ima-session": "conv-kb" },
      body: JSON.stringify({ model: "deepseek-v4-flash", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(fake.asked[0].robot_type, 10000)
    assert.deepEqual(fake.asked[0].command_info, { question_info: {} })
    assert.equal(fake.asked[0].client_tools, undefined)
    assert.equal(fake.sessions[0].robot, 10000)
  })

  it("gives a copilot conversation its own session, not the knowledge base's", async () => {
    // the two robots' sessions do not answer for each other, so a conversation
    // that switches model mid-way must not reuse the session it had
    const { ImaAuthPlugin } = await import("./index.mjs")
    const plugin = await ImaAuthPlugin({ client: { auth: { set: async () => {} } } })
    const auth = { type: "oauth", access: "T1", refresh: "R1", cookie: COOKIE, uid: "U6", accountId: "U6", expires: Date.now() + 7200_000 }
    fake.sessions.length = 0
    fake.asked.length = 0
    const { fetch: ask } = await plugin.auth.loader(async () => auth)
    const send = (model) =>
      ask(`${process.env.IMA_HOST}/cgi-bin/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-magpie-ima-session": "conv-switch" },
        body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "hi" }] }),
      })
    await send("deepseek-v4-flash")
    await send("copilot/hy3")
    assert.equal(fake.sessions.length, 2, "each robot needs its own session")
    assert.notEqual(fake.asked[0].session_id, fake.asked[1].session_id)
  })

  it("namespaces the two catalogues, and carries the 算力 rate", async () => {
    const { ImaAuthPlugin } = await import("./index.mjs")
    const plugin = await ImaAuthPlugin({ client: { auth: { set: async () => {} } } })
    const auth = { type: "oauth", access: "T1", refresh: "R1", cookie: COOKIE, uid: "U7", accountId: "U7", expires: Date.now() + 7200_000 }
    const out = await plugin.provider.models({ id: "ima" }, { auth })
    const ids = Object.keys(out)
    assert.ok(ids.includes("copilot/hy3"), "a copilot model is namespaced")
    assert.ok(ids.includes("copilot/auto"), "CopilotDefault is named for what it is, not slugified to nothing")
    assert.ok(ids.includes("deepseek-v4-flash"), "a knowledge-base model is not")
    assert.ok(ids.includes("deepseek-flash"), "a custom model is listed once, bare — it answers on both robots")
    // Hy3 is a different ima model on each robot: official_0 free in the
    // knowledge base, official_paid_hy3 at ×0.2 in copilot
    assert.equal(out["deepseek-v4-flash"].limit.context > 0, true)
  })
})

describe("算力 balance", () => {
  const authFor = () => ({ type: "oauth", access: "T1", refresh: "R1", cookie: COOKIE, uid: "U8", accountId: "U8", expires: Date.now() + 7200_000 })
  const pluginFor = async () => {
    const { ImaAuthPlugin } = await import("./index.mjs")
    return await ImaAuthPlugin({ client: { auth: { set: async () => {} } } })
  }

  it("reports the balance as a string, the unit included", async () => {
    const plugin = await pluginFor()
    const u = await plugin.auth.usage(async () => authFor())
    // magpie renders balance verbatim under "what is left on the account
    // besides its windows" — a bare number would drop the unit
    assert.equal(u.balance, "279.4 算力")
    assert.equal(u.error, undefined)
    // ima publishes no rate-limit window, so none is invented
    assert.deepEqual(u.windows, [])
  })

  it("takes getAuth as magpie passes it, a function, and a plain object too", async () => {
    const plugin = await pluginFor()
    const byFn = await plugin.auth.usage(async () => authFor())
    const byObj = await plugin.auth.usage(authFor())
    assert.equal(byFn.balance, "279.4 算力")
    assert.equal(byObj.balance, "279.4 算力")
  })

  it("names the account, so the card can tell two of them apart", async () => {
    const plugin = await pluginFor()
    assert.equal((await plugin.auth.usage(async () => authFor())).user, "U8")
  })

  it("reports a sign-in with no cookie, and marks it expired", async () => {
    const plugin = await pluginFor()
    const u = await plugin.auth.usage(async () => ({ type: "oauth", access: "", uid: "U9" }))
    assert.match(String(u.error), /no cookie/)
    assert.equal(u.signIn, "expired")
  })

  it("does not claim the sign-in is expired just because the read failed", async () => {
    // "expired" is what marks the account in magpie; a transport failure must
    // not look like one. The failure is driven through the fake server, not by
    // swapping globalThis.fetch, which other tests run against concurrently.
    const plugin = await pluginFor()
    fake.fail = { path: "/cgi-bin/token_manager/get_balance", network: true }
    try {
      const u = await plugin.auth.usage(async () => authFor())
      assert.ok(String(u.error), "says what went wrong")
      assert.equal(u.balance, undefined, "no balance claimed")
      assert.equal(u.signIn, undefined, "a transport failure is not an expired sign-in")
    } finally {
      fake.fail = null
    }
  })
})
