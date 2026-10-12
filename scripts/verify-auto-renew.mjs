// Does the renewal actually work against ima, end to end? The unit tests prove
// the plugin calls /auth_login/refresh and uses what comes back; this proves ima
// answers and that the new token reads the balance.
//
//   $env:IMA_COOKIE = "..."
//   node scripts/verify-auto-renew.mjs
//
// It renews once, reads the balance on the old token, renews, reads again on the
// new one, and then simulates a dead token to show usage recovering by itself —
// which is the state the user's card was stuck in.
import { readFileSync } from "node:fs"

const cookie = (process.env.IMA_COOKIE ?? "").trim()
if (!cookie) {
  console.error("IMA_COOKIE is not set.")
  console.error('$env:IMA_COOKIE = "IMA-TOKEN=...; IMA-REFRESH-TOKEN=...; IMA-UID=..."')
  process.exit(1)
}

const { ImaAuthPlugin, _internal } = await import("../index.mjs")
const plugin = await ImaAuthPlugin({ client: { auth: { set: async () => {} } } })

const field = (k, c = cookie) => new RegExp(`${k}=([^;\\s]+)`).exec(c)?.[1] ?? ""
const uid = field("IMA-UID")

const line = (s = "") => console.log(s)

line("=== 1. 读取余额（当前 token）===")
const auth = { type: "oauth", access: field("IMA-TOKEN"), refresh: field("IMA-REFRESH-TOKEN"), cookie, uid, accountId: uid, expires: Date.now() + 7200_000 }
let u = await plugin.auth.usage(async () => auth)
line(`  ${JSON.stringify(u)}`)

line("")
line("=== 2. auth.refresh 续期 ===")
const renewed = await plugin.auth.refresh(auth)
if (!renewed) {
  line("  没有返回任何字段 —— cookie 已失效，需要重新粘贴一次")
  line("")
  line("这是预期结果：你退出登录时整条会话被吊销了，access 和 refresh 一起失效。")
  line("重新粘贴一次之后，下面第 3、4 步就会自动工作，不再需要重复登录。")
  process.exit(0)
}
line(`  access   : ${renewed.access ? renewed.access.slice(0, 12) + "…" : "(unchanged)"}`)
line(`  expires  : ${renewed.expires ? new Date(renewed.expires).toISOString() : "(unchanged)"}`)
line(`  cookie   : ${renewed.cookie ? "已更新" : "(unchanged)"}`)
line(`  变更字段  : ${Object.keys(renewed).join(", ")}`)

const auth2 = { ...auth, ...renewed }
line("")
line("=== 3. 用新 token 读余额 ===")
u = await plugin.auth.usage(async () => auth2)
line(`  ${JSON.stringify(u)}`)

line("")
line("=== 4. 模拟 token 已死，usage 能否自己恢复 ===")
// a sign-in whose end has passed: this is what the user's card was in
const auth3 = { ...auth2, expires: Date.now() - 1000, cookie: auth.cookie, access: auth.access }
u = await plugin.auth.usage(async () => auth3)
line(`  ${JSON.stringify(u)}`)
line("")
line(u.balance ? "  -> 自动续期成功，余额读回来了。" : "  -> 未能恢复，需要看上面的错误。")

console.log("\n清掉环境变量：  Remove-Item Env:IMA_COOKIE   （PowerShell）")