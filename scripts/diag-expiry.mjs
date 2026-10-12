// Does magpie still hold a live ima sign-in, and does it carry the fields a
// plugin needs to renew that sign-in on its own? Values are never printed.
//
//   node scripts/diag-expiry.mjs
import { readFileSync, writeFileSync } from "node:fs"

const j = JSON.parse(readFileSync("C:/Users/26223/.config/magpie/plugin-auth.json", "utf8"))
const now = Date.now()
const lines = []

lines.push(`now: ${new Date(now).toISOString()}`)
lines.push("")

for (const prov of ["ima", "workbuddy", "workbuddy-ai", "kiro", "cline", "qoder"]) {
  const v = j[prov]
  if (!v) {
    lines.push(`${prov}: (absent)`)
    lines.push("")
    continue
  }
  const exp = Number(v.expires)
  lines.push(`${prov}:`)
  lines.push(`  type      : ${JSON.stringify(v.type)}`)
  lines.push(`  accountId : ${JSON.stringify(v.accountId)}`)
  lines.push(`  access    : ${v.access ? `yes (${String(v.access).length} chars)` : "NO"}`)
  lines.push(`  refresh   : ${v.refresh ? `yes (${String(v.refresh).length} chars)` : "NO"}`)
  lines.push(`  cookie    : ${v.cookie ? `yes (${String(v.cookie).length} chars)` : "NO"}`)
  if (typeof v.cookie === "string") {
    lines.push(`    fields   : ${v.cookie.split(/;\s*/).map((p) => p.split("=")[0]).join(",")}`)
  }
  lines.push(`  expires   : ${exp ? `${new Date(exp).toISOString()}  ${exp > now ? `VALID, ${Math.round((exp - now) / 60000)} min left` : `EXPIRED ${Math.round((now - exp) / 60000)} min ago`}` : "(none)"}`)
  lines.push("")
}

writeFileSync("_local/expiry.txt", lines.join("\n"), "utf8")
console.log("wrote _local/expiry.txt")