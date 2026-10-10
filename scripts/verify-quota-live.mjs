// The account's 算力 balance, read through the plugin's own auth.usage — the
// same hook magpie's usage card calls, so this proves what the card shows.
//
//   $env:IMA_COOKIE = "IMA-TOKEN=...; IMA-REFRESH-TOKEN=...; IMA-UID=..."
//   node scripts/verify-quota-live.mjs
//
// Get the cookie in ima: send it a message, F12 → Network → click the request
// to /cgi-bin/assistant/qa → Request Headers → copy the whole x-ima-cookie
// value. It must be that header's value, not the browser's cookie jar — ima
// answers a rebuilt cookie with 600001.
//
// (The daily check-in this used to also try is gone from the plugin: ima's
// check_in refuses every request from outside its own client. See the README.)
import { readFileSync } from "node:fs"

const cookie = (process.env.IMA_COOKIE ?? "").trim()
if (!cookie) {
  console.error("IMA_COOKIE is not set.")
  console.error("")
  console.error('PowerShell:  $env:IMA_COOKIE = "IMA-TOKEN=...; IMA-REFRESH-TOKEN=...; IMA-UID=..."')
  console.error("")
  console.error("The value must be the x-ima-cookie header's own value, not the browser's")
  console.error("cookie jar — ima answers a rebuilt cookie with 600001.")
  process.exit(1)
}

// the same forgiving read the plugin's own sign-in does: the bare value, the
// whole header line, or a dump with the header somewhere in it
const named = cookie
  .split(/\r?\n/)
  .map((l) => /^x-ima-cookie\s*:\s*(.+)$/i.exec(l.trim()))
  .find(Boolean)
const clean = (named?.[1] ?? cookie).replace(/^x-ima-cookie\s*:\s*/i, "").trim()

const field = (key) => new RegExp(`${key}=([^;\\s]+)`).exec(clean)?.[1] ?? ""
const token = field("IMA-TOKEN")
const uid = field("IMA-UID")
if (!token || !uid) {
  const missing = [!token && "IMA-TOKEN", !uid && "IMA-UID"].filter(Boolean).join(" and ")
  console.error(`that cookie has no ${missing}. Copy the whole x-ima-cookie header.`)
  process.exit(1)
}
console.log(`cookie ${clean.length} 字符   uid ${uid.slice(0, 6)}...   IMA-TOKEN ${token.length} 字符`)
console.log(`字段: ${clean.split(/;\s*/).map((p) => p.split("=")[0]).join(", ")}`)

// magpie stores a finished sign-in with type "oauth"; the authorize() callback
// answers "success". This is what getAuth hands a hook in real use.
const stored = { type: "oauth", access: token, refresh: field("IMA-REFRESH-TOKEN"), cookie: clean, uid, accountId: uid, expires: Date.now() + 7200_000 }

const { ImaAuthPlugin } = await import("../index.mjs")
const plugin = await ImaAuthPlugin({ client: { auth: { set: async () => {} } } })

console.log("\n=== auth.usage (magpie 的形状) ===")
const u = await plugin.auth.usage(async () => stored)
console.log("  " + JSON.stringify(u))

if (u.error) {
  console.error(`\n余额读不到：${u.error}`)
  process.exit(1)
}

console.log("\n=== 读取两次，确认稳定 ===")
const again = await plugin.auth.usage(async () => stored)
console.log("  " + JSON.stringify(again))
console.log(`\n  balance 一致: ${u.balance === again.balance ? "是" : `否（${u.balance} -> ${again.balance}）`}`)
console.log("\n清掉环境变量：  Remove-Item Env:IMA_COOKIE   （PowerShell）")