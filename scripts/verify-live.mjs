// The plugin, its real code, against the real ima. Everything the fake proved
// about the bridge's shape is re-run here against the thing the bridge is for.
//
//   $env:IMA_COOKIE = "..."
//   node verify-live.mjs
//
// This asks real questions and leaves them in the account's ima history. It
// never touches /auth_login/refresh, so the sign-in survives.

import { ImaAuthPlugin } from "../index.mjs"

const COOKIE = String(process.env.IMA_COOKIE ?? "").trim()
if (!COOKIE) {
  console.error("set IMA_COOKIE first")
  process.exit(2)
}
if (process.env.IMA_HOST) {
  console.error("IMA_HOST is set — this script is meant to hit the real ima. Unset it.")
  process.exit(2)
}

const auth = {
  type: "oauth",
  access: /IMA-TOKEN=([^;]*)/.exec(COOKIE)?.[1] ?? "",
  refresh: /IMA-REFRESH-TOKEN=([^;]*)/.exec(COOKIE)?.[1] ?? "",
  cookie: COOKIE,
  uid: /IMA-UID=([^;]*)/.exec(COOKIE)?.[1] ?? "",
  accountId: /IMA-UID=([^;]*)/.exec(COOKIE)?.[1] ?? "",
  expires: Date.now() + 7200_000,
}

const plugin = await ImaAuthPlugin({ client: { auth: { set: async (p) => console.log("  [auth saved]", Object.keys(p?.body ?? {}).join(",")) } } })
const { fetch: ask } = await plugin.auth.loader(async () => auth)

const send = (body, session) =>
  ask("https://ima.qq.com/cgi-bin/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-magpie-ima-session": session },
    body: JSON.stringify(body),
  })

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`  ${pass ? "ok  " : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`)
}

// ---- 1. the account's own models, read through the plugin's own path ---------
console.log("\n=== 1. model list, as the plugin reads it ===")
{
  const out = await plugin.provider.models({ id: "ima" }, { auth })
  const ids = Object.keys(out)
  console.log("  " + ids.map((i) => `${i} (${out[i].name})`).join("\n  "))
  check("the plugin's model list is not empty", ids.length > 0, `${ids.length} models`)
  check("every model has a context window", ids.every((i) => out[i].limit.context > 0))
  check("thinking variants are marked", ids.some((i) => Object.keys(out[i].variants ?? {}).length))
}

// ---- 2. one non-streaming turn, with instructions ---------------------------
console.log("\n=== 2. a non-streaming turn ===")
{
  const res = await send({ model: "deepseek-v4-flash", stream: false, messages: [{ role: "system", content: "只输出一句话，不要超过15个字。" }, { role: "user", content: "用一句话说明什么是隔夜收益率。" }] }, "live-1")
  const body = await res.json()
  console.log("  content:", JSON.stringify(body.choices?.[0]?.message?.content))
  check("answered with HTTP 200", res.status === 200)
  check("came back as a chat.completion", body.object === "chat.completion")
  check("has answer text", Boolean(body.choices?.[0]?.message?.content))
  check("is short, so the instructions were followed", (body.choices?.[0]?.message?.content ?? "").length < 60, `${(body.choices?.[0]?.message?.content ?? "").length} chars`)
}

// ---- 3. a streaming turn on a thinking model ---------------------------------
console.log("\n=== 3. a streaming turn, on a thinking model ===")
{
  const res = await send({ model: "deepseek-v4-flash-think", stream: true, messages: [{ role: "user", content: "17乘以23等于多少？" }] }, "live-2")
  const text = await res.text()
  const frames = text.split("\n\n").filter(Boolean)
  const chunks = frames.slice(0, -1).map((f) => f.replace(/^data: /, "")).filter((s) => s !== "[DONE]").map((s) => JSON.parse(s))
  const answer = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("")
  const reasoning = chunks.map((c) => c.choices?.[0]?.delta?.reasoning_content ?? "").join("")
  console.log("  answer:   ", JSON.stringify(answer))
  console.log("  reasoning:", JSON.stringify(reasoning.slice(0, 120)) + (reasoning.length > 120 ? "…" : ""))
  check("stream ended with [DONE]", frames.at(-1) === "data: [DONE]")
  check("every chunk is a chat.completion.chunk", chunks.every((c) => c.object === "chat.completion.chunk"))
  check("has answer text", answer.length > 0)
  check("the answer is the arithmetic right one", answer.includes("391"), `17*23=${17 * 23}`)
  check("reasoning came separately, not mixed into the answer", !answer.includes("计算") && reasoning.length > 0)
  check("the last chunk carries a finish_reason", chunks.at(-1)?.choices?.[0]?.finish_reason === "stop")
}

// ---- 4. a conversation, which is what the session design is for -------------
console.log("\n=== 4. three turns of one conversation ===")
{
  const session = "live-conv-" + Date.now()
  const q = ["请记住这个数：8642。只回复「好」。", "我让你记的那个数是多少？只回复数字。", "把它乘以2，等于多少？只回复数字。"]
  const answers = []
  for (const question of q) {
    const res = await send({ model: "deepseek-v4-flash", stream: false, messages: [{ role: "user", content: question }] }, session)
    const body = await res.json()
    answers.push(body.choices?.[0]?.message?.content ?? "")
  }
  answers.forEach((a, i) => console.log(`  turn ${i + 1}: ${JSON.stringify(a)}`))
  check("turn 2 recalls what turn 1 was told", answers[1]?.includes("8642"))
  check("turn 3 reasons over turn 1, not just turn 2", answers[2]?.includes("17284"), `8642*2=${8642 * 2}`)
}

// ---- 5. a model the plugin has never heard of -------------------------------
console.log("\n=== 5. an unknown model id ===")
{
  const res = await send({ model: "not-a-model-at-all", stream: false, messages: [{ role: "user", content: "只回复：好" }] }, "live-unknown-" + Date.now())
  const body = await res.json()
  console.log("  answered as:", body.model, "->", JSON.stringify(body.choices?.[0]?.message?.content))
  check("an unknown model still answers, on the account's own preference", res.status === 200 && Boolean(body.choices?.[0]?.message?.content))
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${failed.length ? failed.length + " of " + results.length + " FAILED" : "all " + results.length + " live checks passed"}`)
process.exit(failed.length ? 1 : 0)