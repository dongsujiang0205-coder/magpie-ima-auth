// The daily check-in against a real account, with the one thing this settles
// written out loud: does the balance move?
//
//   set IMA_COOKIE="IMA-TOKEN=...; IMA-REFRESH-TOKEN=...; IMA-UID=..."
//   node scripts/verify-quota-live.mjs
//
// Get the cookie in ima: send it a message, F12 → Network → click the request
// to /cgi-bin/assistant/qa → Request Headers → copy the whole x-ima-cookie
// value. Do NOT claim in the app first: this reads the day list and only sends
// the claim when the day has not been paid out, but the whole point is to watch
// a claim actually happen.
//
// Run it on a morning before signing in through the UI. Every day measured so
// far was already claimed, which is why `reward_type: 1` has never been seen to
// succeed — a 403 there cannot be told apart from a wrong constant. The last
// line of this script's output is the answer.
const cookie = (process.env.IMA_COOKIE ?? "").trim()
if (!cookie) {
  console.error("IMA_COOKIE is not set.")
  console.error("")
  console.error('PowerShell:  $env:IMA_COOKIE = "IMA-TOKEN=...; IMA-REFRESH-TOKEN=...; IMA-UID=..."')
  console.error("cmd.exe:      set IMA_COOKIE=IMA-TOKEN=...; IMA-REFRESH-TOKEN=...; IMA-UID=...")
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
const show = (o) => console.log("  " + JSON.stringify(o))

console.log("\n=== 1. 领取前的余额 ===")
const before = await plugin.auth.usage(async () => stored)
show(before)
if (before.error) {
  console.log("\n余额读不到，领取的结果无从判断，先修登录态再说。")
  process.exit(1)
}

console.log("\n=== 2. 签到 ===")
const c = await plugin.auth.checkin(async () => stored)
show(c)

console.log("\n=== 3. 领取后的余额 ===")
const after = await plugin.auth.usage(async () => stored)
show(after)

const moved = before.balance !== after.balance
console.log(`\n=== 结论 ===`)
console.log(`  balance ${before.balance} -> ${after.balance}`)
console.log(`  outcome ${c.outcome}`)
if (c.outcome === "claimed") {
  console.log(moved
    ? "  领取成功，reward_type: 1 是对的。"
    : "  ima 说领取成功但余额没动 —— 常量可能对也可能不对，看不出差别。")
} else if (c.outcome === "done") {
  console.log("  今天已经领过了，所以这次没发领取请求，什么也证明不了。")
  console.log("  要验证 reward_type，必须在 app 里点签到之前跑。")
} else {
  console.log(`  领取没成功：${c.message ?? "(没有说明)"}`)
  console.log("  这仍不能证明常量是错的 —— 也可能是今天已领或还没到点。")
}
console.log("\n清掉环境变量：  Remove-Item Env:IMA_COOKIE   （PowerShell）")