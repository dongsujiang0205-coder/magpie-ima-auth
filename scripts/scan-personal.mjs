// Before this repository is published: does anything in the files that ship
// identify the person who made it?
//
// The patterns are deliberately generic — a Windows profile name, a captured
// cookie, a long opaque token. They do not carry any one account's actual ids,
// so this file is safe to publish and useful to anyone who forks the project.
//
//   node scripts/scan-personal.mjs
import { readFileSync, readdirSync, statSync } from "node:fs"

const PATTERNS = [
  // a cookie with a real-looking value, of any field
  ["ima credential", /IMA-(?:TOKEN|REFRESH-TOKEN)=[A-Za-z0-9_\-./+=]{16,}/g],
  // the device fingerprints ima's client sends
  ["device fingerprint", /\b(?:IMA-Q36|IMA-IUA|IMA-GUID)=[A-Za-z0-9_\-]{16,}/g],
  // a Windows profile name in a path
  ["windows profile", /C:\\Users\\[A-Za-z0-9._-]+/g],
  // a drive-letter absolute path
  ["absolute path", /[A-Za-z]:\\(?:Users|Documents and Settings|Program Files)[\\/]/g],
  ["email", /[\w.+-]+@[\w-]+\.[\w.]{2,}/g],
  // a long opaque run that looks like a base64 secret
  ["opaque secret", /["'][A-Za-z0-9+/]{40,}={0,2}["']/g],
]

// what the package actually ships, plus the repository's own sources
const SHIPPING = ["index.mjs", "README.md", "package.json", "ima.test.mjs", "smoke.mjs"]

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "_local") continue
    const p = dir + "/" + e.name
    if (e.isDirectory()) walk(p, out)
    else if (/\.(?:mjs|js|json|md|txt)$/i.test(e.name)) out.push(p)
  }
  return out
}

const targets = [...SHIPPING.filter((f) => {
  try {
    return statSync(f).isFile()
  } catch {
    return false
  }
}), ...walk("scripts")]

let found = 0
for (const file of targets) {
  let text
  try {
    text = readFileSync(file, "utf8")
  } catch {
    continue
  }
  for (const [label, re] of PATTERNS) {
    const hits = [...new Set((text.match(re) ?? []).map((s) => s.trim()))]
    if (!hits.length) continue
    found += hits.length
    for (const h of hits) {
      const shown = h.length > 60 ? h.slice(0, 60) + "..." : h
      console.log(`  ${file}  ${label}  ${shown}`)
    }
  }
}

console.log(found ? `\n${found} to look at` : `\nclean: ${targets.length} files, nothing identifying`)
console.log("(paths like D:\\project are fine; only a real profile name is a leak)")