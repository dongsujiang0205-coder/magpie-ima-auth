// Two questions, one call each:
//   1. is the refresh token magpie holds still good? (if not, the user has to
//      paste once before automatic renewal can ever work)
//   2. does /auth_login/refresh actually answer for it?
//
// The credential is read from magpie's own store and spent against ima; nothing
// is printed back.
//
//   node scripts/diag-refresh-works.mjs
import { readFileSync, writeFileSync } from "node:fs"

const j = JSON.parse(readFileSync("C:/Users/26223/.config/magpie/plugin-auth.json", "utf8"))
const ima = j.ima
const out = []

const cookie = String(ima.cookie ?? "")
const token = /IMA-TOKEN=([^;]+)/.exec(cookie)?.[1] ?? ""
const refresh = /IMA-REFRESH-TOKEN=([^;]+)/.exec(cookie)?.[1] ?? ""
const uid = /IMA-UID=([^;]+)/.exec(cookie)?.[1] ?? ima.uid ?? ""

out.push(`uid      : ${uid}`)
out.push(`access   : ${token.length} chars`)
out.push(`refresh  : ${refresh.length} chars`)
out.push(`expires  : ${new Date(Number(ima.expires)).toISOString()}`)
out.push("")

const bkn = (t) => {
  let h = 5381
  for (let i = 0; i < t.length; i++) h += (h << 5) + t.charCodeAt(i)
  return String(h & 0x7fffffff)
}
const post = async (url, body, withToken) => {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      from_browser_ima: "1",
      ...(withToken ? { "x-ima-cookie": withToken(cookie, token), "x-ima-bkn": bkn(token) } : {}),
      Referer: "https://ima.qq.com",
      Origin: "https://ima.qq.com",
      "User-Agent": "okhttp/4.12.0",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  return { status: r.status, text: await r.text() }
}

// 1. does the access token still work?
out.push("=== the stored access token, on get_balance ===")
{
  const r = await post("https://ima.qq.com/cgi-bin/token_manager/get_balance", {}, (c) => c)
  out.push(`  HTTP ${r.status}  ${r.text.slice(0, 180)}`)
  const code = Number(JSON.parse(r.text).code)
  out.push(`  -> ${code === 0 ? "access token 仍然有效" : "access token 已失效（code " + code + "）"}`)
}
out.push("")

// 2. does the refresh token renew it?
out.push("=== /auth_login/refresh with the stored refresh token ===")
{
  const r = await post("https://ima.qq.com/auth_login/refresh", { refresh_token: refresh, user_id: uid, registration_id: "" }, null)
  out.push(`  HTTP ${r.status}  ${r.text.slice(0, 220)}`)
  let newTok = null
  try {
    const j2 = JSON.parse(r.text)
    newTok = j2.token ?? j2.Token ?? null
    out.push(`  code=${j2.code}  msg=${j2.msg ?? ""}`)
    if (j2.token_valid_time ?? j2.TokenValidTime) {
      out.push(`  token_valid_time=${j2.token_valid_time ?? j2.TokenValidTime}s`)
    }
  } catch {}
  out.push(`  -> ${newTok ? "续期成功，自动续期可行" : "续期失败，必须重新粘贴一次 cookie"}`)

  if (newTok) {
    out.push("")
    out.push("=== the renewed token, on get_balance ===")
    const replaced = cookie.replace(/IMA-TOKEN=[^;]*/, "IMA-TOKEN=" + newTok)
    const r2 = await post("https://ima.qq.com/cgi-bin/token_manager/get_balance", {}, () => replaced)
    out.push(`  HTTP ${r2.status}  ${r2.text.slice(0, 180)}`)
  }
}

writeFileSync("_local/refresh-works.txt", out.join("\n"), "utf8")
console.log("wrote _local/refresh-works.txt")