// OpenCode provider plugin for ima (腾讯 ima.copilot), the AI knowledge
// workbench. magpie has no built-in for it, so the provider id is `ima` and
// an agent set to `ima/<model>` talks to the models on the signed-in ima
// account, against that account's own 算力.
//
// ima is not an OpenAI-compatible API and never will be one to this plugin —// three of its facts shape everything below:
//
//   1. **It is session-based and takes ONE question.** There is no messages
//      array to send. A chat is opened first:
//        POST /cgi-bin/session_logic/init_session
//        {"env_info":{"interact_type":2,"robot_type":10000},"name":"…","msgs_limit":20}
//        鈫?{"code":0,"session_id":…}   鈫?top level, NOT inside a data envelope
//      then each turn is asked on its own:
//        POST /cgi-bin/assistant/qa      (SSE)
//        {"session_id","robot_type":10000,"question","question_type":2,
//         "client_id":<uuid>,"model_info":{"model_type":N,"model_id":"official_N"}}
//      So this plugin is a bridge: it keeps one ima session per agent
//      conversation, flattens the client's messages into the one question ima
//      takes, and turns ima's SSE back into chat.completion chunks. That is
//      why tools are not supported —ima has no tool channel at all, and a
//      prompt asking it to fake one produces garbage, not tool calls.
//
//   2. **Models are a (type, id) pair, not a name.** "deepseek-v4-flash" is
//      model_type 3 and model_id "official_3"; nothing in the request is
//      ever the name. MODELS below is the static table; the account's own
//      list is read from /cgi-bin/model_manage/get_models when it answers.
//
//   3. **Business errors hide inside HTTP 200.** A failed sign-in is code 41,
//      a kicked one 600001, a spent/blank session 5 or 51 —all inside the
//      SSE body, with a 200 status. Only ever looking at the status code
//      makes a dead account look alive, so the stream is read to its
//      COMPLETED / INNER_EXCEPTION sentinel and that is what decides.
//
// Authentication is the browser's own cookie, sent as two headers —there is
// no OAuth endpoint to point a browser at and poll, so there is no automatic
// sign-in like WorkBuddy's:
//
//   x-ima-cookie: <the whole value, copied from the browser's own request>
//   x-ima-bkn:    <djb2(IMA-TOKEN) & 0x7fffffff>
//
// The cookie must be the **x-ima-cookie header's** value, not a cookie jar
// rebuilt from the browser's storage: ima's frontend puts fields in that
// header that never appear in the cookie store, and a store-only rebuild is
// answered with 600001 "服务繁忙". (whynpc9/opencli-plugin-ima documents
// exactly that failure, and reads the store.)
//
// A cookie carries IMA-REFRESH-TOKEN, which renews at /auth_login/refresh
// (7200s tokens). ima **rotates** it: a refresh spends the old one, so two
// concurrent refreshes of one account leave the second holding a dead token
// and every later request failing 600001. Hence the single-flight below.
//
// Protocol cross-checked against two independent implementations that agree:
// chipchipss/buddyhub (Go, a running gateway) and whynpc9/opencli-plugin-ima
// (Node). buddyhub's notes say its version was ported from ima2api.

import { randomBytes, randomUUID } from "node:crypto"

// HOST is ima's base. IMA_HOST overrides it, which is what the tests point at
// a fake ima with —the same trick trae's package uses for its own hosts.
const HOST = String(process.env.IMA_HOST ?? "https://ima.qq.com").replace(/\/+$/, "")
const API = HOST + "/cgi-bin"
const INIT_SESSION = HOST + "/cgi-bin/session_logic/init_session"
const QA = HOST + "/cgi-bin/assistant/qa"
const REFRESH = HOST + "/auth_login/refresh"
const MODELS_PATH = HOST + "/cgi-bin/model_manage/get_models"

const NPM = "@ai-sdk/openai-compatible"

// MSGS_LIMIT is what the frontend asks for, and what both third-party
// implementations treat as ima's cap. Measured against a real account it is
// not enforced: a session asked with msgs_limit 20 took 13 turns (26
// messages) without complaint. So this plugin does NOT rotate at it —an
// agent conversation is longer than that, and rotating early throws away
// real context. The code 5 / 51 recovery below is what handles a session
// ima does decide is finished; ROTATE_AT is only a backstop well past the
// documented cap, so a session that ages out is replaced before, not after,
// it is discovered dead.
const MSGS_LIMIT = 20
const ROTATE_AT = 60 // messages; far past the cap, and never reached in practice
// CARRY is how many earlier turns ride along in the first question of a
// replacement session, so a long conversation doesn't go blank at the cap.
const CARRY = 4
// TTL is how long a session is reused, in ms. Beyond it a new one is opened,
// as the frontend does; an idle session also expires server-side, and one
// that expired is answered with a code that only a fresh session fixes.
const TTL = 30 * 60 * 1000
// TOKEN_TTL is ima's token life in seconds, used only when a renewal doesn't
// say its own.
const TOKEN_TTL = 7200
// SKEW is how long before a token's end a renewal runs, in ms.
const SKEW = 10 * 60 * 1000

// ROBOT is which of ima's two chats a model belongs to. The two share the
// endpoint and differ in three request fields, all measured against a real
// account:
//
//                     knowledge base      copilot
//   robot_type         10000               15
//   command_info       {question_info:{}}  {type:2000, copilot_qa_info:{}}
//   model_info         official_3          official_paid_ep-i2azx8ko
//                      (type 3)            (type 110000 = OfficialPaid)
//
// and in the catalogue: model_manage/get_models answers with a different list
// entirely depending on `scene`. Sent {} it gives the knowledge base's four
// official models plus the account's custom ones; sent {"scene":1} it gives
// copilot's twelve, each carrying its 算力倍率. Neither is a superset of the
// other and the custom models appear in both, so the plugin asks for both.
const ROBOT = { KB: 10000, COPILOT: 15 }
const SCENE = { KB: {}, COPILOT: { scene: 1 } }
// COPILOT_PREFIX namespaces the two catalogues, because the same model is a
// different ima model in each: Hy3 is official_0 in the knowledge base (free
// Q&A) and official_paid_hy3 in copilot (charged at 算力 ×0.2). The custom
// models are listed once, bare, because they are the same model in both and
// answer on either robot.
const COPILOT_PREFIX = "copilot/"

// MODELS is the static list, [id, name, context, type, model_id, thinking].
// Every row here was read off a real account's /cgi-bin/model_manage/get_models
// and every (type, id) pair was called and answered —not copied from another
// implementation's table, which had two of them wrong.
//
// The account's own list replaces this once signed in, so a model ima adds
// later still appears; this is what an agent can be set to before that.
//
// Note GLM-5.3-Flash at type 3000. An earlier draft of this table called
// official_3000 "GLM-5.2", which is what the other implementations call it;
// ima itself says GLM-5.3-Flash, and the name is what the user sees.
const MODELS = [
  ["deepseek-v4-flash", "DeepSeek-V4-Flash", 1000000, 3, "official_3", false],
  ["deepseek-v4-flash-think", "DeepSeek-V4-Flash (think)", 1000000, 1, "official_1", true],
  ["hy4-preview", "Hy4 preview", 192000, 1001, "official_1001", false],
  ["hy4-preview-think", "Hy4 preview (think)", 192000, 1002, "official_1002", true],
  ["hy3", "Hy3", 192000, 0, "official_0", false],
  ["hy3-think", "Hy3 (think)", 192000, 2, "official_2", true],
  ["glm-5.3-flash", "GLM-5.3-Flash", 1000000, 3000, "official_3000", false],
  ["glm-5.3-flash-think", "GLM-5.3-Flash (think)", 1000000, 3001, "official_3001", true],
]

// DEFAULT is what a model this plugin doesn't know is answered with. ima has
// no "auto" in its API (the frontend's Auto is a client-side switch over the
// same six), so this is a real model: DeepSeek-V4-Flash.
const DEFAULT = MODELS[0]

// AUTH_CODES are the codes that say the sign-in itself is the problem, as
// opposed to the session. 41 is a login past its end, 600001 a session ima
// has refused (also its catch-all "服务繁忙"), 5 and 51 an invalid session.
const AUTH_CODES = new Set([41, 600001])
// SESSION_CODES say the session itself is spent or was never good: rebuild it
// and ask again on the new one. Separate from AUTH_CODES because the fix is a
// new session, not a new sign-in.
const SESSION_CODES = new Set([5, 51])

// CONTROL_EVENTS end an ima stream. ERROR among them means it ended in
// failure, which the caller retries against a new session.
const CONTROL_EVENTS = new Set(["COMPLETED", "CLOSE", "INNER_EXCEPTION", "ERROR", "FAILED"])

// TEXT_KEYS are the fields a text event's text has been spelled, across the
// versions this has met. ima's body text is not at the event's top level: a
// STRUCTURED_BLOCK carries {"Type":"blockMessage","Data":{"text_message":{"Text":…}}}.
// Reading only the top level finds nothing, which looks like "ima answered
// with an empty string" rather than the field being nested.
const TEXT_KEYS = ["Text", "text", "Content", "content", "Delta", "delta", "Msg", "msg", "reply", "Reply", "answer", "Answer"]

// ---- ima's little pieces -------------------------------------------------------

// bkn is x-ima-bkn: the djb2 variant ima's own clients send, which is not
// the token in any readable form but is derived from it, so it has to be
// computed per request and can never be copied from a browser as a constant.
function bkn(token) {
  let h = 5381
  const t = String(token ?? "")
  for (let i = 0; i < t.length; i++) h += (h << 5) + t.charCodeAt(i)
  return String(h & 0x7fffffff)
}

// cookieField is one field of the x-ima-cookie header.
function cookieField(cookie, key) {
  for (const part of String(cookie ?? "").split(";")) {
    const i = part.indexOf("=")
    if (i > 0 && part.slice(0, i).trim() === key) return part.slice(i + 1).trim()
  }
  return ""
}

// withToken is the cookie with its IMA-TOKEN replaced (a renewal's), which is
// the only field a renewal changes.
function withToken(cookie, token) {
  const c = String(cookie ?? "")
  if (/IMA-TOKEN=/.test(c)) return c.replace(/IMA-TOKEN=[^;]*/, "IMA-TOKEN=" + token)
  return c + "; IMA-TOKEN=" + token
}

// headers are the ones ima's own client sends. User-Agent is ima's Android
// client's (okhttp), which is what the accepted value on this endpoint is;
// there is no browser UA that is accepted.
function headers(a, extra = {}) {
  const cookie = a.cookie ?? ""
  return {
    "Content-Type": "application/json; charset=utf-8",
    "from_browser_ima": "1",
    "x-ima-cookie": cookie,
    "x-ima-bkn": bkn(cookieField(cookie, "IMA-TOKEN")),
    Referer: HOST,
    Origin: HOST,
    "User-Agent": "okhttp/4.12.0",
    ...extra,
  }
}

// post is one JSON POST to ima. ima answers HTTP 200 with {code, msg, data}
// even for a failure, so the envelope is checked here and the code kept on
// the error for the caller's decisions.
async function post(url, body, a, { timeout = 30_000, accept = "application/json" } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: headers(a, { Accept: accept }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  let env
  try {
    env = JSON.parse(text)
  } catch {
    env = null
  }
  if (!res.ok) {
    // a refused sign-in is an HTTP 401 *and* a code in the envelope; which of
    // the two to judge it by decides whether the caller renews and retries or
    // just reports, so both are carried
    const code = Number(env?.code ?? env?.Code ?? 0) || res.status
    throw new IMAError(code, `ima: HTTP ${res.status} ${env?.msg || env?.Msg || truncate(text)}`, res.status)
  }
  if (!env || typeof env !== "object") throw new IMAError(0, `ima: ${truncate(text) || "an answer that isn't JSON"}`, res.status)
  const code = Number(env.code ?? env.Code ?? 0)
  if (code !== 0) throw new IMAError(code, `ima: ${env.msg || env.Msg || "code " + code} (${code})`, res.status)
  return env
}

class IMAError extends Error {
  constructor(code, message, status) {
    super(message)
    this.code = code
    this.status = status
    this.auth = AUTH_CODES.has(Number(code)) || status === 401 || status === 403
    this.session = SESSION_CODES.has(Number(code)) || this.auth
  }
}

const truncate = (s) => String(s ?? "").replace(/\s+/g, " ").slice(0, 200)

// ---- the sign-in as kept -------------------------------------------------------

// toAuth is a cookie sign-in as OpenCode keeps an OAuth one: the token as
// access, the renewal as refresh, the account. The whole cookie rides along
// in `cookie`, because ima needs several of its fields at once and there is
// no way to name them in OpenCode's auth shape.
function toAuth(cookie, extra = {}) {
  const token = cookieField(cookie, "IMA-TOKEN")
  const uid = cookieField(cookie, "IMA-UID")
  return {
    type: "oauth",
    access: token,
    refresh: cookieField(cookie, "IMA-REFRESH-TOKEN"),
    cookie,
    uid,
    accountId: extra.name || uid,
    expires: Date.now() + TOKEN_TTL * 1000,
    ...extra,
  }
}

// fromAuth is a stored sign-in as the requests below use it. `source` is not
// carried on: a sign-in saved by an earlier version of this plugin, through the
// ima-desktop method, is an ordinary cookie sign-in now and is read as one.
function fromAuth(auth) {
  if (auth?.type !== "oauth") return null
  const cookie = auth.cookie || `IMA-TOKEN=${auth.access}; IMA-REFRESH-TOKEN=${auth.refresh}; IMA-UID=${auth.uid}`
  if (!cookieField(cookie, "IMA-TOKEN")) return null
  return { cookie, uid: auth.uid || cookieField(cookie, "IMA-UID"), refresh: auth.refresh || cookieField(cookie, "IMA-REFRESH-TOKEN") }
}

// stale is a sign-in whose token is within SKEW of its end.
function stale(a) {
  return !!a.expires && Date.now() >= a.expires - SKEW
}

// renewing is each renewal in flight, by account and refresh token, so two
// requests never spend the same one. ima rotates refresh tokens: the second
// refresh of a pair is answered with a dead token, and every request after
// it fails 600001 until the account is pasted again. This is not an
// optimisation, it is a correctness requirement.
const renewing = new Map()

// renew spends a's refresh token, once, and answers the account it made:
// the same shape account() answers, so whoever renews can go straight on to
// asking without translating it back.
async function renew(a, save) {
  if (!a.refresh) throw new Error("this ima account has no refresh token; sign in again")
  const key = a.uid + "\n" + a.refresh
  let r = renewing.get(key)
  if (!r) {
    r = (async () => {
      const env = await post(REFRESH, { refresh_token: a.refresh, user_id: a.uid, registration_id: "" }, a)
      const token = env.token || env.Token
      if (!token) throw new IMAError(0, "ima: renewal gave no token", 200)
      const valid = Number(env.token_valid_time ?? env.TokenValidTime ?? 0) || TOKEN_TTL
      const next = {
        access: token,
        cookie: withToken(a.cookie, token),
        uid: a.uid,
        refresh: a.refresh,
        expires: Date.now() + valid * 1000,
      }
      await save?.(next)
      return next
    })().finally(() => renewing.delete(key))
    renewing.set(key, r)
  }
  return r
}

// fresh is an account whose token isn't about to end: renewed (and saved)
// when it is. A renewal that fails leaves the existing token in use while it
// lasts rather than breaking a working session, and says so once per account
// rather than on every request for the rest of the hour.
const warned = new Set()

async function fresh(a, save) {
  if (!stale(a)) return a
  try {
    return await renew(a, save)
  } catch (e) {
    const id = a.uid || "?"
    if (Date.now() >= a.expires) {
      warned.add(id)
      throw new Error(`ima's sign-in has ended and could not be renewed (${e?.message ?? e}); sign in again`)
    }
    if (!warned.has(id)) {
      warned.add(id)
      console.warn(`[ima] token renewal failed (${e?.message ?? e}); using the current token until it ends`)
    }
    return a
  }
}

// refreshed is what magpie's auth.refresh hook renews ahead of time. It
// returns only the fields that changed, which is what magpie saves back.
async function refreshed(auth) {
  const a = fromAuth(auth)
  if (!a || !stale({ expires: auth.expires })) return undefined
  const next = await renew(a)
  const out = {}
  for (const k of ["access", "refresh", "cookie", "expires"]) if (next[k] !== auth[k]) out[k] = next[k]
  return Object.keys(out).length ? out : undefined
}

// ---- 算力 balance and the daily login reward ----------------------------------

// 算力 is ima's unit of compute, and get_balance is plain (no crypto, no
// encryption channel — unlike the two chats). Its numbers sit at the top level
// of the envelope rather than under `data`:
//
//   balance "279"  display_amount "279.4"  display_activity_amount "279.4"
//   display_paid_amount "0"  real_balance "0"  balance_infos []
//
// display_amount is the one to show; balance is the same figure truncated, kept
// alongside for a consumer that wants a bare integer.
async function readBalance(a) {
  const env = await post(API + "/token_manager/get_balance", {}, a)
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const display = num(env.display_amount)
  const truncated = num(env.balance)
  if (display === undefined && truncated === undefined) {
    throw new Error("ima: the balance answer carried no number")
  }
  return {
    unit: "算力",
    balance: display ?? truncated,
    truncated,
    activity: num(env.display_activity_amount),
    paid: num(env.display_paid_amount),
    cash: num(env.real_balance),
  }
}

// ---- sessions ------------------------------------------------------------------

// sessions is the open ima sessions, by account and conversation. An agent's
// one conversation is ima's one session; without this every turn would be a
// new session and ima would see a user who asks each question as if for the
// first time.
const sessions = new Map()

// sessionKey includes the robot: a session opened by the knowledge base robot
// is not a session the copilot robot will answer on (and the reverse), so
// sharing one cache key between them makes a conversation that changes model
// mid-way fail with a session error that looks like a dead account.
const sessionKey = (a, conv, robot) => (a.uid || "anonymous") + "\n" + robot + "\n" + conv

function getSession(a, conv, robot = ROBOT.KB) {
  const k = sessionKey(a, conv, robot)
  const e = sessions.get(k)
  if (!e) return null
  if (Date.now() - e.at > TTL) {
    sessions.delete(k)
    return null
  }
  e.at = Date.now()
  return e
}

function putSession(a, conv, entry, robot = ROBOT.KB) {
  const k = sessionKey(a, conv, robot)
  sessions.set(k, { ...entry, at: Date.now() })
  // a bounded cache: a plugin process outlives many conversations, and each
  // entry is small but not nothing
  if (sessions.size > 256) {
    const oldest = [...sessions.entries()].sort((x, y) => x[1].at - y[1].at)[0]
    if (oldest) sessions.delete(oldest[0])
  }
}

function dropSession(a, conv, robot = ROBOT.KB) {
  sessions.delete(sessionKey(a, conv, robot))
}

// initSession opens an ima session. The session_id is at the TOP level of the
// answer, not inside a data envelope as every other ima endpoint wraps its
// own — reading it out of `data` loses it, and the failure is the maddening
// "ima returned code 0 but no session_id" with a perfectly good sign-in.
//
// robot_type is the chat's, not a constant: 10000 is the knowledge base's Q&A
// robot and 15 is copilot's. A session opened by one is not a session the
// other will answer on, so the model carries it and the session cache is keyed
// by it (see sessionKey).
async function initSession(a, name, robot = ROBOT.KB) {
  const env = await post(INIT_SESSION, { env_info: { interact_type: 2, robot_type: robot }, name: title(name), msgs_limit: MSGS_LIMIT }, a)
  const id = env.session_id || env.sessionId || env.data?.session_id
  if (!id) throw new IMAError(0, "ima: init_session returned no session_id", 200)
  return id
}

const title = (s) => {
  const t = String(s ?? "").trim()
  if (!t) return "新对话"
  // ima cuts a session's name at 50 characters, and does it on the string the
  // frontend sends rather than on a rune count
  return [...t].slice(0, 50).join("")
}

// ---- the client's chat, as ima takes it ----------------------------------------

// partText is a message's text: the string itself, or its parts joined. An
// image or an audio part becomes a marker rather than nothing —ima takes no
// images, and a message whose text silently loses its figure reads to the
// model as a question about nothing.
function partText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content == null ? "" : String(content)
  return content
    .map((p) => {
      if (typeof p === "string") return p
      if (p?.type === "text" || p?.type === "input_text") return p.text ?? ""
      if (p?.type === "image_url" || p?.type === "image") return "[an image, which this model can't see]"
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

// systemText is everything in the chat that is an instruction rather than a
// turn: system and developer messages. ima has no system role, so this
// becomes part of the question.
function systemText(chat) {
  return (Array.isArray(chat?.messages) ? chat.messages : [])
    .filter((m) => m?.role === "system" || m?.role === "developer")
    .map((m) => partText(m?.content))
    .filter(Boolean)
    .join("\n\n")
}

// lastUserText is the question: the chat's final user message. A message that
// only carries a tool result is not one —a client replaying a conversation
// puts the result after the assistant's call, and treating it as the new
// question asks ima to act on it.
function lastUserText(chat) {
  const msgs = Array.isArray(chat?.messages) ? chat.messages : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m?.role !== "user") continue
    const text = partText(m?.content).trim()
    if (text) return text
  }
  return ""
}

// transcript is the earlier turns a replacement session is opened with, so a
// conversation that has outgrown MSGS_LIMIT keeps what it said.
function transcript(entry) {
  const turns = (entry?.turns ?? []).slice(-CARRY)
  if (!turns.length) return ""
  return (
    "Here is the earlier part of this conversation, for context:\n\n" +
    turns.map((t) => `User: ${t.q}\nima: ${t.a || "(no answer recorded)"}`).join("\n\n") +
    "\n\nNow the new question."
  )
}

// ---- ima's stream ---------------------------------------------------------------

// readSSE walks an ima SSE stream, handing each event to onEvent. ima's
// data: lines are not guaranteed to be valid JSON (a chunk can arrive cut),
// so a parse failure is passed on as-is and eventText does what it can.
async function readSSE(res, onEvent) {
  const reader = res.body?.getReader()
  if (!reader) throw new IMAError(0, "ima: the answer has no body", 200)
  const dec = new TextDecoder()
  let buf = ""
  let event = ""
  let data = []
  const flush = () => {
    if (!event && !data.length) return
    const raw = data.join("\n")
    const name = event
    event = ""
    data = []
    onEvent(name, raw)
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "")
        buf = buf.slice(i + 1)
        if (!line) flush()
        else if (line.startsWith(":")) continue
        else if (line.startsWith("event:")) {
          flush()
          event = line.slice(6).trim()
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
      }
    }
    buf += dec.decode()
    if (buf.startsWith("data:")) data.push(buf.slice(5).replace(/^ /, ""))
    flush()
  } finally {
    // the client hanging up (a tool call made elsewhere, a cancelled turn)
    // closes this mid-read: let ima's connection go, or the next ask reuses a
    // socket the server has already dropped
    reader.cancel().catch(() => {})
  }
}

// eventText is an event's answer text, or "" for one that carries none. The
// body text lives two levels down, inside Data and Data.text_message, and the
// field name has moved between versions; each candidate object is searched in
// turn.
//
// An array is never one of these: SUGGEST_QUESTION's data is a list of
// suggestions whose objects each have a Text, and looking for Text on the
// array itself finds nothing —which is the right answer, but by accident
// rather than by decision, so it is decided here.
function eventText(name, raw) {
  const doc = eventObject(raw)
  if (!doc) return ""
  const candidates = [doc]
  const data = doc.Data ?? doc.data
  if (isObject(data)) {
    candidates.push(data)
    const tm = data.text_message ?? data.textMessage
    if (isObject(tm)) candidates.push(tm)
  }
  return firstText(candidates)
}

// eventThinking is an event's reasoning, or "". ima sends it as its own block:
// {"Type":"blockThinking","Data":{"thinking_message":{"Message":"—}}}, also a
// delta stream, but under Message where the answer uses Text. It goes to
// reasoning_content rather than into the answer: an agent that shows thinking
// shows it, and one that doesn't is unaffected.
//
// The last thinking event of a block carries Status 2 with a Tips string and
// no Message —a marker, not text, so it reads as empty.
function eventThinking(name, raw) {
  const doc = eventObject(raw)
  if (!doc) return ""
  const data = doc.Data ?? doc.data
  if (!isObject(data)) return ""
  const tm = data.thinking_message ?? data.thinkingMessage
  if (!isObject(tm)) return ""
  return typeof tm.Message === "string" ? tm.Message : ""
}

// eventObject is an event's data, parsed, with a truncated line repaired.
function eventObject(raw) {
  if (!raw) return null
  let doc
  try {
    doc = JSON.parse(raw)
  } catch {
    doc = repair(raw)
  }
  return isObject(doc) ? doc : null
}

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v)

function firstText(candidates) {
  for (const cand of candidates) {
    for (const key of TEXT_KEYS) {
      const v = cand[key]
      if (typeof v === "string" && v) return v
    }
  }
  return ""
}

// repair is one attempt at a JSON line cut mid-write: drop the trailing
// incomplete `,"key"` fragment and close the object again. Enough for a
// truncated text event, which is the common case.
function repair(raw) {
  const i = raw.lastIndexOf(',"')
  if (i <= 0) return null
  try {
    return JSON.parse(raw.slice(0, i) + "}")
  } catch {
    return null
  }
}

// errorIn is the failure an ima stream ended in, or null. COMPLETED carries a
// code the same way a JSON endpoint does; INNER_EXCEPTION / ERROR / FAILED
// carry the reason in their own data.
//
// Code 3 with no message at all is what ima answers when it is throttling the
// account, and it says nothing to say about it: a burst of questions is the
// usual cause. It is recognised here so the user is told that, rather than
// shown a bare "code 3" to look up.
function errorIn(name, raw) {
  if (name === "INNER_EXCEPTION" || name === "ERROR" || name === "FAILED") {
    const doc = tryParse(raw)
    const code = Number(doc?.Code ?? doc?.code ?? 0) || 0
    const msg = doc?.Msg || doc?.msg || (raw ? "" : name)
    return new IMAError(code, described(code, msg, name), 200)
  }
  if (name === "COMPLETED") {
    const doc = tryParse(raw)
    const code = Number(doc?.Code ?? doc?.code ?? 0) || 0
    if (code !== 0) return new IMAError(code, described(code, doc?.Msg || doc?.msg || "", "COMPLETED"), 200)
  }
  return null
}

// BUSY is ima's throttling code. 1411 is the one both this package's notes and
// its first draft ran into: a model the account may not use, answered as
// expired ("模型失效") rather than as not allowed.
const BUSY = 3
const NOT_ALLOWED = 1411

function described(code, msg, where) {
  if (msg) return `${msg} (${code})`
  if (code === BUSY) return `ima is not answering at the moment (code ${code}, no message —it throttles an account that asks in a burst); wait a moment and ask again`
  if (code === NOT_ALLOWED) return `this account may not use that model (code ${code})`
  return `code ${code}${where ? " at " + where : ""}, with no message`
}

function tryParse(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// drain reads a whole answer, which is what a non-streaming client wants. The
// reasoning goes separately, so it lands in reasoning_content and not in the
// answer —ima's thinking and its answer are two blocks, and conflating them
// puts a monologue in front of every reply.
async function drain(res) {
  let text = ""
  let thinking = ""
  let failed = null
  await readSSE(res, (name, raw) => {
    if (failed) return
    const err = errorIn(name, raw)
    if (err) {
      failed = err
      return
    }
    thinking += eventThinking(name, raw)
    text += eventText(name, raw)
  })
  return { text, thinking, failed }
}

// ---- the model list ------------------------------------------------------------

const byId = new Map(MODELS.map((m) => [m[0], m]))

// modelOf is a table row as the shape everything downstream wants: the pair
// ima takes, named. The static table and the account's own list both come
// through here, so a request built from either has {type, modelId} —a raw
// table row (an array) would send model_info with no type in it at all.
function normalized(m) {
  return Array.isArray(m)
    ? { id: m[0], name: m[1], context: m[2], type: m[3], modelId: m[4], robot: ROBOT.KB, command: undefined, rate: "", rateValue: null, thinking: m[5], custom: false, copilot: false }
    : m
}

// modelFor is the model a request is sent to.
//
// The account's catalogue and the static table are both consulted, and in this
// order, because either can know something the other doesn't:
//
//   - the catalogue, for what the account actually has, including a model this
//     table predates;
//   - the static table, for anything the catalogue doesn't list. A catalogue
//     that names only the four plain models would otherwise make every
//     thinking variant unreachable, even though each of them was verified to
//     answer;
//   - the account's own preference, for an id neither knows —what the user
//     last chose in ima's own UI, which may be a model this plugin has never
//     heard of;
//   - the default, which is a real model, because ima has no "auto" in its API
//     (the frontend's Auto is a client-side switch over the same set).
function modelFor(a, id) {
  const live = liveModels.get(a.uid)
  if (id) {
    const named = live?.find((m) => m.id === id)
    if (named) return named
    const known = byId.get(id)
    if (known) return normalized(known)
  }
  if (live?.length) {
    // the copilot list is the one ima actually tells us this account prefers
    // (preferred_model_id comes back with scene 1 and names a copilot model),
    // so an id nothing recognises is answered on copilot's preferred model
    const prefs = preferredModels.get(a.uid) ?? {}
    const pref = live.find((m) => m.modelId === (prefs.COPILOT ?? prefs.KB)) ?? live.find((m) => m.copilot && !m.custom)
    return pref ?? live.find((m) => !m.custom) ?? live[0]
  }
  return normalized(DEFAULT)
}

// liveModels is each account's own model list, read once at sign-in.
const liveModels = new Map()

// The catalogue request carries the cookie exactly as signed in. An earlier
// version stripped CLIENT-TYPE from it, on the belief that the field decided
// which models the catalogue lists; it does not, and stripping it is strictly
// worse. Measured, with the account's own sign-in:
//
//   cookie as-is,       scene {}        → 4 official + 5 custom
//   cookie as-is,       scene {"scene:1} → 12 copilot  + 5 custom
//   CLIENT-TYPE gone,   scene {}        → 4 official, no custom
//   CLIENT-TYPE gone,   scene {"scene:1} → 1 copilot (official_100000, named
//                                               "默认模型"), no official_paid_*, 5 custom
//
// The 9-versus-4 that first suggested the field mattered was scene {} against
// {"scene":1}, not the cookie's contents.

// readModels is the account's catalogues as the plugin's rows: the knowledge
// base's, then copilot's, merged and namespaced.
//
// The shape was read off real answers, which differ from a guess in three
// ways worth keeping:
//
//   - `models` is at the TOP LEVEL. Almost every ima endpoint wraps its payload
//     in a `data` envelope; this one does not, and looking only under `data`
//     finds nothing.
//   - `scene` selects the catalogue. `{"scene":1}` is copilot's twelve; `{}` is
//     the knowledge base's four. Asking for one and calling it "the models" is
//     how a plugin ends up offering a fifth of what the account can actually
//     run.
//   - There is no context window anywhere in it — no max_input_tokens, no limit
//     field — so the static table's numbers are the only ones there are, and
//     the copilot rows fall back to a guess that should be believed least.
//
// The copilot models carry their 算力倍率 in `model_token_copywriting` ("×0.2",
// "×4.5 闲时"), which is kept: it spans 22× across the twelve and is the single
// most useful thing to know when choosing one, since it is what a turn costs.
//
// Their model ids are per-account (`official_paid_ep-i2azx8ko`), so this table
// cannot be static: it has to be asked for after signing in, which is why the
// knowledge base's names are kept as a fallback for an account that has not
// answered yet.
async function readModels(a) {
  const out = []
  const seen = new Set()
  const preferred = {}
  // preferred_model_id comes back with the catalogue, and which one it names
  // depends on the catalogue: scene 1's names a copilot model, the knowledge
  // base's names a knowledge-base one. Both are kept, since they are what the
  // account itself last chose on that robot.
  let lastEnv = null

  for (const [kind, scene] of Object.entries(SCENE)) {
    let env
    try {
      env = await post(MODELS_PATH, scene, a, { timeout: 15_000 })
    } catch {
      continue
    }
    lastEnv = env
    const rows = Array.isArray(env.models) ? env.models : []
    for (const row of rows) {
      const type = Number(row?.model_type ?? row?.type)
      const modelId = row?.model_id ?? row?.id
      const name = String(row?.model_name ?? row?.name ?? modelId ?? "")
      if (!Number.isFinite(type) || !modelId || !name) continue
      // a model ima's own catalogue calls 自定义模型 is one the user added
      // themselves, with a UUID rather than an official name. It answers on
      // both robots and is charged at no 算力, so it is listed once.
      const custom = row?.describe === "自定义模型" || type === 1000000
      const copilot = kind === "COPILOT" && !custom
      // model_type 100000 is CopilotDefault — "自动选择最优模型", whose name is
      // Chinese and slugifies to nothing, so it is named for what it is
      const id = copilot ? COPILOT_PREFIX + (type === 100000 ? "auto" : slug(name)) : custom ? slug(name) : knownKbId(type, modelId)
      if (seen.has(id)) continue
      seen.add(id)
      const known = copilot ? null : MODELS.find((m) => Number(m[3]) === type && m[4] === String(modelId))
      out.push({
        id,
        name,
        context: known?.[2] || 128000,
        type,
        modelId: String(modelId),
        robot: copilot ? ROBOT.COPILOT : ROBOT.KB,
        // copilot's command_info carries a type; the knowledge base's does not
        command: copilot ? 2000 : undefined,
        rate: copilot ? rateOf(row) : "",
        rateValue: copilot ? rateValueOf(row) : null,
        thinking: false,
        custom,
        copilot,
      })
      if (row?.is_default === true) preferred[kind] = String(modelId)
      const pref = String(env?.preferred_model_id ?? "")
      if (pref) preferred[kind] = pref

      // A knowledge-base model hangs its thinking sibling off itself under
      // sub_model_infos, keyed "1". The key is NOT the model_type — DeepSeek's
      // plain is type 3 and its thinking type 1 — so the pair is read out of the
      // sub-model rather than computed. enable_thinking is false on every one
      // ima returns, including ones that demonstrably think, so it is not read.
      if (kind !== "COPILOT") {
        const subs = row?.sub_model_infos ?? {}
        const thinking = Object.values(subs).find((s) => s?.model_id && String(s.model_id) !== String(modelId))
        const tType = Number(thinking?.model_type)
        const tKnown = Number.isFinite(tType) && MODELS.find((m) => Number(m[3]) === tType && m[4] === String(thinking.model_id))
        if (tKnown) {
          const tid = tKnown[0]
          if (!seen.has(tid)) {
            seen.add(tid)
            out.push({
              id: tid,
              name: tKnown[1],
              context: tKnown[2] || known?.[2] || 128000,
              type: tType,
              modelId: String(thinking.model_id),
              robot: ROBOT.KB,
              command: undefined,
              rate: "",
              rateValue: null,
              thinking: true,
              custom: false,
              copilot: false,
            })
          }
        }
      }
    }
  }
  if (Object.keys(preferred).length) preferredModels.set(a.uid, preferred)

  if (out.length) liveModels.set(a.uid, out)
  return out
}

// slug is a model name as an id: lower, ASCII-ish, with runs collapsed. The
// custom models' names are already ids (deepseek-v4.1-flash), so this leaves
// them alone; the official ones become readable (DeepSeek-V4.1-Flash →
// deepseek-v4.1-flash).
const slug = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "") || "model"

// knownKbId keeps the knowledge base's ids stable across versions, so an agent
// set to `deepseek-v4-flash` keeps working; a model the table has never heard
// of falls back to its ima id, which is always usable.
function knownKbId(type, modelId) {
  const known = MODELS.find((m) => Number(m[3]) === type && m[4] === String(modelId))
  return known?.[0] ?? String(modelId)
}

// rateOf is the 算力 multiplier as ima words it — "×0.2", "×4.5 闲时".
function rateOf(row) {
  return String(row?.model_token_copywriting ?? "").trim()
}

// rateValueOf is the same number, for choosing between models. "×4.5 闲时" is
// 4.5 and means the same; anything unparsable is unknown (null) rather than 0,
// which would make an unpriced model look free.
function rateValueOf(row) {
  const n = Number.parseFloat(String(row?.model_token_copywriting ?? "").replace(/[^\d.]/g, ""))
  return Number.isFinite(n) && n > 0 ? n : null
}

// preferredModels is each account's own choice, per catalogue.
const preferredModels = new Map()

// ensureModels reads the account's catalogue once, before the first question,
// and leaves it alone after. Without this the provider's `models` hook would
// be the only thing that ever populated it, and an agent that never lists the
// models —which is most of them —would ask with the static table while a
// model ima has since added went unseen.
const modelsRead = new Map()

async function ensureModels(a) {
  const at = modelsRead.get(a.uid) ?? 0
  if (Date.now() - at < 30 * 60 * 1000) return
  modelsRead.set(a.uid, Date.now())
  await readModels(a)
}

// ---- the bridge ----------------------------------------------------------------

// SESSION carries the conversation magpie (or OpenCode) names a request by,
// from the chat.headers hook to the fetch below. It goes no further.
const SESSION = "x-magpie-ima-session"

// sessionOf takes the conversation id off the header and deletes it: it is
// this plugin's own bookkeeping and ima has no such header.
function sessionOf(headers) {
  const s = String(headers.get(SESSION) ?? "").trim()
  headers.delete(SESSION)
  return s.slice(0, 128)
}

// conversationOf names the conversation a request belongs to: the session
// magpie named it, else the first user message of the chat, which every later
// turn repeats. "" when neither names one —then every request opens its own
// session, which is the old behaviour and loses continuity, but a made-up id
// from the request alone would be worse (it would split one conversation
// across sessions).
function conversationOf(chat, session) {
  if (session) return "session:" + session
  const msgs = Array.isArray(chat?.messages) ? chat.messages : []
  for (const m of msgs) {
    if (m?.role !== "user") continue
    const text = partText(m.content).trim()
    if (text) return "first:" + text.slice(0, 500)
  }
  return ""
}

// opening asks the first question of a session: the earlier turns a
// replacement session carries, the chat's instructions (ima has no system
// role, so they are part of the question), and the question itself.
const opening = (carried, instructions, question) => [carried, instructions, question].filter(Boolean).join("\n\n")

async function qa(a, sessionId, question, model) {
  const res = await fetch(QA, {
    method: "POST",
    headers: headers(a, {
      Accept: "text/event-stream",
      // the desktop client sends text/plain for a chat, and copilot's chat is
      // only answered when it does
      ...(model.copilot ? { "Content-Type": "text/plain;charset=UTF-8" } : {}),
    }),
    body: JSON.stringify({
      session_id: sessionId,
      robot_type: model.robot ?? ROBOT.KB,
      question,
      question_type: 2,
      command_info: model.copilot ? { type: model.command ?? 2000, copilot_qa_info: {} } : { question_info: {} },
      client_id: randomUUID(),
      model_info: { model_type: model.type, model_id: model.modelId, enable_enhancement: false },
      // copilot carries a tool list; this sends none, because nothing here
      // will execute a call ima's copilot makes
      ...(model.copilot ? { history_info: {}, client_tools: [] } : {}),
    }),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new IMAError(0, `ima: HTTP ${res.status} ${truncate(text)}`, res.status)
  }
  return res
}

// completion is an aggregated answer as chat.completion. ima reports no token
// counts, so usage is zeros rather than a number invented from a character
// count —a client that shows cost would otherwise show a wrong one.
function completion(model, text, thinking) {
  return {
    id: "chatcmpl-" + randomBytes(12).toString("hex"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text, ...(thinking ? { reasoning_content: thinking } : {}) },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

// errorResponse is an OpenAI error the agent reads, carrying magpie's
// "signIn: kept" so a business rejection (a session that was spent, a turn
// ima refused) isn't taken for a dead account.
function errorResponse(status, message, signIn) {
  const headers = { "content-type": "application/json" }
  if (signIn) headers["X-Magpie-Sign-In"] = signIn
  return new Response(JSON.stringify({ error: { message, type: "api_error", code: null } }), { status, headers })
}

// ---- the plugin -----------------------------------------------------------------

export const ImaAuthPlugin = async ({ client, $ }) => {
  // the instruction text each open session was started with, so a replacement
  // session for the same conversation still has it
  const systems = new Map()

  const account = async (auth, { save = true } = {}) => {
    const a = fromAuth(auth)
    if (!a) throw new Error("this ima account isn't signed in")
    a.systems = systems
    return await fresh(
      { ...a, expires: auth.expires },
      save
        ? async (next) => {
            try {
              await client?.auth?.set?.({ path: { id: "ima" }, body: { ...auth, access: next.access, refresh: next.refresh, cookie: next.cookie, expires: next.expires } })
            } catch {}
          }
        : undefined,
    )
  }

  // send is one turn: find or open the session, then ask. Returns the entry
  // the answer belongs to and the ima response still unread, or a finished
  // error response —the answer has to be read by the caller, in the shape
  // the client asked for.
  const send = async (a, chat, session) => {
    await ensureModels(a)
    const model = modelFor(a, String(chat.model ?? DEFAULT[0]))
    const question = lastUserText(chat)
    const conv = conversationOf(chat, session)
    // the instructions ride on the session's first question: ima has no system
    // role, and repeating an agent's whole system prompt on every turn of a
    // 20-message session would spend most of the window on it
    const instructions = systemText(chat)
    if (instructions) systems.set(conv, instructions)

    const robot = model.robot ?? ROBOT.KB
    let entry = getSession(a, conv, robot)
    // only a session far past the documented cap is replaced unasked. ima
    // accepted 26 messages against a stated limit of 20 on a real account,
    // so rotating at the cap would throw away live context for nothing; a
    // session ima really has finished is caught by the code 5 / 51 path
    // below instead, which rebuilds it and asks again
    const carried = entry ? transcript(entry) : ""
    if (entry && entry.turns.length * 2 + 2 > ROTATE_AT) entry = null
    if (!entry) {
      const id = await initSession(a, question, robot)
      entry = { id, turns: [] }
      putSession(a, conv, entry, robot)
      return { entry, res: await qa(a, id, opening(carried, systems.get(conv), question), model) }
    }
    try {
      return { entry, res: await qa(a, entry.id, question, model) }
    } catch (e) {
      // the session died (a spent one, or one ima has expired server-side):
      // a new one, carrying the earlier turns, and the same question again
      if (!e?.session) throw e
      const before = transcript(entry)
      dropSession(a, conv, robot)
      const id = await initSession(a, question, robot)
      const next = { id, turns: [] }
      putSession(a, conv, next, robot)
      return { entry: next, res: await qa(a, id, opening(before, systems.get(conv), question), model) }
    }
  }

  // turn is one chat end to end, on a sign-in that's already been made fresh.
  const turn = async (auth, a, chat, session) => {
    const model = modelFor(a, String(chat.model ?? DEFAULT[0]))
    const question = lastUserText(chat)
    const conv = conversationOf(chat, session)
    // a chat with nothing to ask is the client's mistake, not ima's, and is
    // answered before any session is opened
    if (!question) return errorResponse(400, "ima: the chat has no user turn to ask", "kept")

    let entry = null
    let res = null
    try {
      ;({ entry, res } = await send(a, chat, session))
    } catch (e) {
      if (!e?.auth) return errorResponse(502, `ima: ${e?.message ?? e}`, "kept")
      // a refused token: renew once and take the turn again from a new
      // session —the old one belonged to the token that was refused
      let saved = null
      try {
        saved = await renew(a, async (next) => {
          try {
            await client?.auth?.set?.({ path: { id: "ima" }, body: { ...auth, access: next.access, refresh: next.refresh, cookie: next.cookie, expires: next.expires } })
          } catch {}
        })
      } catch (e2) {
        return errorResponse(401, `ima: the sign-in was refused and could not be renewed —${e2?.message ?? e2}. Sign in again.`, "expired")
      }
      warned.delete(a.uid)
      dropSession(a, conv)
      try {
        ;({ entry, res } = await send(saved, chat, session))
      } catch (e3) {
        if (e3?.auth) return errorResponse(401, `ima: the sign-in was refused again after renewal —${e3.message}. Sign in again.`, "expired")
        return errorResponse(502, `ima: ${e3?.message ?? e3}`, "kept")
      }
    }

    if (!chat.stream) {
      const { text, thinking, failed } = await drain(res)
      entry.turns.push({ q: question, a: text })
      if (failed && (failed.auth || failed.session)) {
        // the session failed mid-answer: same handling as one that failed
        // before any text, with what was answered so far still carried
        dropSession(a, conv)
        try {
          ;({ entry, res } = await send(a, chat, session))
          return await turnAgain(auth, a, chat, session, entry, res, question, model)
        } catch (e) {
          return errorResponse(502, `ima: ${e?.message ?? e}`, "kept")
        }
      }
      if (failed) return errorResponse(502, `ima: ${failed.message}`, "kept")
      return new Response(JSON.stringify(completion(model.id, text, thinking)), { headers: { "content-type": "application/json" } })
    }

    // streaming. ima's events go out as OpenAI chunks. A failure inside the
    // stream can't be a status code any more —the 200 is already out —so it
    // goes out as an error frame, which is the last thing a client can read.
    const id = "chatcmpl-" + randomBytes(12).toString("hex")
    const created = Math.floor(Date.now() / 1000)
    const enc = new TextEncoder()
    const stream = new ReadableStream({
      start(ctl) {
        let answer = ""
        let closed = false
        const frame = (o) => ctl.enqueue(enc.encode("data: " + JSON.stringify(o) + "\n\n"))
        const finish = () => {
          if (closed) return
          closed = true
          frame({ id, object: "chat.completion.chunk", created, model: model.id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
          ctl.enqueue(enc.encode("data: [DONE]\n\n"))
          ctl.close()
        }
        const fail = (message) => {
          if (closed) return
          closed = true
          frame({ error: { message, type: "api_error", code: null } })
          ctl.close()
        }
        const onEvent = (name, raw) => {
          if (closed) return
          const err = errorIn(name, raw)
          if (err) return fail(`ima: ${err.message}`)
          // ima sends the reasoning and the answer as two blocks in the same
          // stream; they go to different fields of the same delta, so a client
          // that shows thinking shows it and one that doesn't sees the answer
          // alone
          const reasoning = eventThinking(name, raw)
          const text = eventText(name, raw)
          if (reasoning || text) {
            answer += text
            frame({
              id,
              object: "chat.completion.chunk",
              created,
              model: model.id,
              choices: [{ index: 0, delta: { ...(reasoning ? { reasoning_content: reasoning } : {}), ...(text ? { content: text } : {}) }, finish_reason: null }],
            })
          }
          if (CONTROL_EVENTS.has(name)) {
            entry.turns.push({ q: question, a: answer })
            finish()
          }
        }
        readSSE(res, onEvent).then(() => finish(), (e) => fail(`ima: ${e?.message ?? e}`))
      },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  }

  // turnAgain answers a non-streaming chat whose first session failed
  // mid-answer: the session has already been replaced and asked again, so
  // this is the same shaping turn does, on the new response.
  const turnAgain = async (auth, a, chat, session, entry, res, question, model) => {
    const { text, thinking, failed } = await drain(res)
    entry.turns.push({ q: question, a: text })
    if (failed) return errorResponse(502, `ima: ${failed.message}`, "kept")
    return new Response(JSON.stringify(completion(model.id, text, thinking)), { headers: { "content-type": "application/json" } })
  }

  return {
    config: async (config) => {
      config.provider ??= {}
      config.provider.ima ??= {}
      const p = config.provider.ima
      p.name ??= "ima"
      p.npm ??= NPM
      p.api ??= API
      p.models = { ...configModels(), ...(p.models ?? {}) }
    },

    // the conversation's id, which the fetch below carries over to the ima
    // session it opens
    "chat.headers": async (input, output) => {
      const id = input?.model?.providerID ?? input?.provider?.info?.id
      if (id !== "ima" || !input?.sessionID) return
      output.headers[SESSION] = String(input.sessionID).slice(0, 128)
    },

    provider: {
      id: "ima",
      // the account's own model list once signed in; the static table until
      // then, or if ima doesn't answer
      async models(provider, { auth }) {
        if (auth?.type !== "oauth" || !auth.access) return provider.models
        try {
          const a = await account(auth, { save: false })
          const ms = await readModels(a)
          if (!ms.length) return provider.models
          return Object.fromEntries(ms.map((m) => [m.id, modelOf(provider, m)]))
        } catch {
          return provider.models
        }
      },
    },

    auth: {
      provider: "ima",
      // magpie renews ahead of time, once per account, before its requests,
      // models and usage ask. The check inside the loader stays for OpenCode,
      // which doesn't call this.
      refreshLead: SKEW + 60 * 1000,
      refresh: (auth) => refreshed(auth),

      // magpie's own hook, which OpenCode ignores. Its shape is fixed by
      // magpie's source:
      //
      //   auth.usage(getAuth, provider) → {
      //     plan?, user?, until?, renew?: "auto"|"off", balance?, error?,
      //     resets?: { count, until?, byWindow?, fiveHour?, weekly? },
      //     windows?: [{ name, used /*percent*/, display?, amount?, limit?,
      //                   unit?, span?, model?, models?, notModels?, aside? }],
      //     signIn?: "expired" | "kept" | "renewed"
      //   }
      //
      // balance is a STRING, not a number — magpie renders it verbatim as
      // "what is left on the account besides its windows", which is exactly
      // what 算力 is. ima publishes no rate-limit window, so windows stays
      // empty and the allowance is the balance.
      usage: async (getAuth) => {
        try {
          const a = fromAuth(typeof getAuth === "function" ? await getAuth() : getAuth)
          if (!a) return { error: "ima: that sign-in carries no cookie", signIn: "expired" }
          const b = await readBalance(a)
          return { balance: `${b.balance} ${b.unit}`, user: a.uid || "", windows: [] }
        } catch (e) {
          // no signIn key: this is a read that failed, not one that proves the
          // account is signed out, and marking it expired would be wrong
          return { error: `ima: ${e?.message ?? e}` }
        }
      },

      async loader(getAuth) {
        return {
          baseURL: API,
          apiKey: "",
          async fetch(input, init) {
            const auth = await getAuth()
            if (auth?.type !== "oauth") throw new Error("ima isn't signed in")
            const req = input instanceof Request ? input : null
            const headers = new Headers(init?.headers ?? req?.headers)
            headers.delete("authorization")
            headers.delete("x-api-key")
            const session = sessionOf(headers)
            let body = init?.body
            if (body === undefined && req) body = await req.clone().text()
            const chat = parseJSON(body)
            if (!chat) return errorResponse(400, "ima: the request isn't a chat this plugin can ask", "kept")
            return await turn(auth, await account(auth), chat, session)
          },
        }
      },

      methods: [
        {
          type: "oauth",
          label: "ima account (cookie)",
          // ima has no authorization page of its own to send a browser to and
          // no token endpoint to poll, so this one is a paste: the user copies
          // the header their own request already carries
          authorize: () => ({
            url: HOST,
            instructions: [
              "Sign in to ima at https://ima.qq.com and send it any message.",
              "Open DevTools (F12) → Network → click the request to /cgi-bin/assistant/qa → Request Headers.",
              "Copy the whole value of the x-ima-cookie header and paste it below.",
              "It must be that header's value, not the cookie store: ima answers a rebuilt cookie with 600001.",
            ].join("\n"),
            method: "code",
            async callback(input) {
              // the user may paste the bare header value, or the whole line
              // with its name on it, or a dump with the header somewhere in
              // it: all three are the same cookie, and taking whichever was
              // pasted is kinder than insisting on one
              const text = String(input?.code ?? input ?? "")
              const named = text
                .split(/\r?\n/)
                .map((l) => /^x-ima-cookie\s*:\s*(.+)$/i.exec(l.trim()))
                .find(Boolean)
              const cookie = (named?.[1] ?? text).replace(/^x-ima-cookie\s*:\s*/i, "").trim()
              const token = cookieField(cookie, "IMA-TOKEN")
              const uid = cookieField(cookie, "IMA-UID")
              if (!token) return { type: "failed", error: "that value has no IMA-TOKEN; copy the whole x-ima-cookie header" }
              if (!uid) return { type: "failed", error: "that value has no IMA-UID; copy the whole x-ima-cookie header" }
              try {
                await readModels({ cookie, uid, systems: new Map() })
              } catch (e) {
                return { type: "failed", error: `ima didn't take that sign-in: ${e?.message ?? e}` }
              }
              const auth = toAuth(cookie, { uid, accountId: uid })
              // type last: toAuth's own spread would otherwise set it to
              // "oauth", which is what the *stored* sign-in is, not what a
              // finished authorize() answers
              return { ...auth, type: "success" }
            },
          }),
        },
      ],
    },
  }
}

// ---- the static model table -------------------------------------------------------

function configModels() {
  return Object.fromEntries(MODELS.map((m) => [m[0], { name: m[1], limit: { context: m[2], output: 0 }, tool_call: false }]))
}

function modelOf(provider, m) {
  return {
    id: m.id,
    providerID: provider.id,
    name: m.name,
    api: { id: m.id, url: API, npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 0, output: 0 },
    capabilities: {
      temperature: false,
      reasoning: !!m.thinking,
      attachment: false,
      // ima has no tool channel at all: a tool_call here would be a promise
      // the API can't keep, so the model is declared as taking none and an
      // agent picks a different provider for tool work
      toolcall: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: m.thinking ? { on: { reasoningEffort: "high" }, off: { reasoningEffort: "none" } } : {},
  }
}

function parseJSON(s) {
  if (s && typeof s === "object") return s
  try {
    const v = JSON.parse(String(s ?? ""))
    return v && typeof v === "object" ? v : null
  } catch {
    return null
  }
}

// for tests
export const _internal = { bkn, cookieField, withToken, title, partText, systemText, lastUserText, eventText, eventThinking, errorIn, conversationOf, modelFor, readModels, MODELS, AUTH_CODES, CONTROL_EVENTS, QA, INIT_SESSION, REFRESH, MODELS_PATH, HOST, MSGS_LIMIT, ROTATE_AT }