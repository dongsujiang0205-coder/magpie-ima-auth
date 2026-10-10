// magpie is a Bun single-file executable: its JavaScript is embedded as plain
// text, so the plugin contract can be read rather than guessed. This pulls the
// readable window around a needle and prints it, which is how auth.checkin and
// auth.usage get checked against what the plugin actually exports.
import { openSync, readSync, statSync, existsSync, closeSync } from "node:fs"

// The path comes from the caller or the environment, never from a hardcoded
// one — this file ships, and a contributor's magpie is somewhere else.
//
//   node scripts/read-magpie-binary.mjs "<path to magpie>" auth.checkin
const EXE = process.argv[2] ?? process.env.MAGPIE_EXE ?? ""
if (!EXE) {
  console.error("pass the path to the magpie executable, or set MAGPIE_EXE.")
  console.error('  node scripts/read-magpie-binary.mjs "C:\\path\\to\\magpie.exe" auth.checkin')
  process.exit(1)
}
if (!existsSync(EXE)) {
  console.error(`no such file: ${EXE}`)
  process.exit(1)
}
const NEEDLE = process.argv[3] ?? "auth.checkin"
const BEFORE = Number(process.argv[4] ?? 900)
const AFTER = Number(process.argv[5] ?? 900)

const size = statSync(EXE).size
const fd = openSync(EXE, "r")
const CHUNK = 8 * 1024 * 1024
const needle = Buffer.from(NEEDLE, "utf8")
const hits = []

let pos = 0
let carry = Buffer.alloc(0)
while (pos < size) {
  const buf = Buffer.alloc(CHUNK)
  const n = readSync(fd, buf, 0, CHUNK, pos)
  if (!n) break
  const hay = Buffer.concat([carry, buf.subarray(0, n)])
  const base = pos - carry.length
  let at = hay.indexOf(needle)
  while (at !== -1) {
    hits.push(base + at)
    at = hay.indexOf(needle, at + 1)
  }
  carry = hay.subarray(Math.max(0, hay.length - needle.length - 4))
  pos += n
}
closeSync(fd)

console.log(`${NEEDLE}: ${hits.length} occurrence(s) in ${EXE}\n`)

const SKIP = Number(process.argv[6] ?? 0)
for (const [i, hit] of hits.slice(SKIP, SKIP + 4).entries()) {
  const start = Math.max(0, hit - BEFORE)
  const len = BEFORE + NEEDLE.length + AFTER
  const buf = Buffer.alloc(len)
  const rfd = openSync(EXE, "r")
  readSync(rfd, buf, 0, len, start)
  closeSync(rfd)
  const text = buf.toString("utf8")
  // keep only what looks like source: printable runs, so the binary noise around
  // it does not bury the code
  const lines = text
    .replace(/[^\x09\x0a\x20-\x7e一-鿿 -￿]/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 1)
  console.log(`---------- occurrence ${i + 1} @ ${hit} ----------`)
  for (const l of lines) console.log(l)
  console.log()
}