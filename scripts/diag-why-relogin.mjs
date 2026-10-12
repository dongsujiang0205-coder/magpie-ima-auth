// The first pass read j.ima as an object when it is an array, so it printed the
// array's indices as field names. Read it properly: the record is the element,
// and the question is whether that record carries the fields the plugin needs
// to renew itself without the user pasting again.
//
//   node scripts/diag-why-relogin.mjs
import { readFileSync, writeFileSync } from "node:fs"

const j = JSON.parse(readFileSync("C:/Users/26223/.config/magpie/plugin-auth.json", "utf8"))
const out = []

const recordsOf = (v) => (Array.isArray(v) ? v : Object.values(v)).filter((r) => r && typeof r === "object")

out.push("=== every provider: shape and count ===")
for (const [prov, v] of Object.entries(j)) {
  const recs = recordsOf(v)
  out.push(`  ${prov.padEnd(22)} ${Array.isArray(v) ? "array" : "object"}  ${recs.length} record(s)  keys: ${Object.keys(v).slice(0, 4).join(", ")}`)
}
out.push("")

out.push("=== each provider's record: which fields, and does it expire ===")
for (const [prov, v] of Object.entries(j)) {
  for (const [i, rec] of recordsOf(v).entries()) {
    const keys = Object.keys(rec)
    const exp = Number(rec.expires)
    const line = [`    [${i}] fields: ${keys.join(", ")}`]
    if (exp) {
      const when = new Date(exp).toISOString()
      line.push(`         expires ${when}  ${exp > Date.now() ? "valid" : "EXPIRED"}`)
    } else {
      line.push(`         expires: none`)
    }
    if (typeof rec.cookie === "string") {
      line.push(`         cookie ${rec.cookie.length} chars: ${rec.cookie.split(/;\s*/).map((p) => p.split("=")[0]).join(",")}`)
    }
    out.push(`  ${prov}`)
    for (const l of line) out.push(l)
  }
}
out.push("")

// the one thing that decides whether re-login is ever needed
out.push("=== what makes this plugin need the user again ===")
out.push("  auth.refresh -> refreshed(auth) renews only when stale({expires: auth.expires})")
out.push("  stale() is: !!a.expires && Date.now() >= a.expires - SKEW   (SKEW = 10 min)")
out.push("")
out.push("  So: if the stored record has no `expires`, stale() is false forever,")
out.push("  refresh is never called, and the access token dies ~2h later with")
out.push("  nobody renewing it — the user is asked to paste the cookie again.")

writeFileSync("_local/why-relogin.txt", out.join("\n"), "utf8")
console.log("wrote _local/why-relogin.txt")