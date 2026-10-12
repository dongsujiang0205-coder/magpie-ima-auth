// What magpie stores for ima, and why `plugin list` calls it not-signed-in.
// Only shapes and lengths — no credential values.
//
//   node scripts/diag-magpie-auth.mjs
import { readFileSync, writeFileSync } from "node:fs"

const FILE = "C:/Users/26223/.config/magpie/plugin-auth.json"
const j = JSON.parse(readFileSync(FILE, "utf8"))

const out = []
out.push(`top-level keys: ${Object.keys(j).join(", ")}`)
out.push("")

const ima = j.ima
out.push("=== j.ima ===")
out.push(`  typeof: ${Array.isArray(ima) ? "array" : typeof ima}`)
out.push(`  keys: ${Object.keys(ima).join(", ")}`)
out.push("")

// how each provider's accounts are keyed, for comparison — this is what
// accountKey() has to produce for `readAuth()[key]` to find anything
out.push("=== every provider: shape and key format ===")
for (const [prov, v] of Object.entries(j)) {
  const isArray = Array.isArray(v)
  const keys = isArray ? v.map((a, i) => String(a.accountId ?? a.email ?? a.uid ?? i)) : Object.keys(v)
  out.push(`  ${prov.padEnd(22)} ${isArray ? "array[" + v.length + "]" : "object{" + Object.keys(v).length + "}"}  keys: ${keys.slice(0, 3).join(", ")}`)
}
out.push("")

// the ima record in detail
out.push("=== j.ima detail ===")
for (const [k, v] of Object.entries(ima)) {
  const t = typeof v
  let note = ""
  if (t === "string") note = `${v.length} chars`
  else if (t === "number") note = `expires: ${new Date(v).toISOString()}  (${v < Date.now() ? "EXPIRED" : "valid"})`
  else if (t === "object" && v) note = `${Array.isArray(v) ? "array" : "object"}[${Object.keys(v).length}]`
  out.push(`  ${k.padEnd(12)} ${t.padEnd(8)} ${note}`)
}
out.push("")

// does the stored cookie still hold a token magpie would accept?
const cookie = typeof ima.cookie === "string" ? ima.cookie : ""
out.push("=== cookie fields ===")
out.push(`  ${cookie.split(/;\s*/).map((p) => p.split("=")[0]).join(", ")}`)
out.push(`  length: ${cookie.length}`)

writeFileSync("_local/magpie-auth.txt", out.join("\n"), "utf8")
console.log("wrote _local/magpie-auth.txt")