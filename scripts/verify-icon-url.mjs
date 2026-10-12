// The package's icon is an absolute URL pointing at the v0.3.0 tag. If that URL
// does not return a PNG, the npm listing will carry a broken image and the whole
// point of this release is lost. Check the exact URL in package.json.
//
//   node scripts/verify-icon-url.mjs
import { readFileSync, writeFileSync } from "node:fs"

const pkg = JSON.parse(readFileSync("package.json", "utf8"))
const url = pkg.icon

const out = [`icon field: ${url}`, ""]
const say = (s = "") => {
  out.push(s)
  console.log(s)
}

const isPNG = (b) => b[0] === 0x89 && b.subarray(1, 4).toString() === "PNG"

// read the declared width/height out of the IHDR chunk, so the image is verified
// as the icon rather than as any old PNG
const pngSize = (b) => {
  if (!isPNG(b) || b.length < 24) return null
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

const check = async (label, u) => {
  try {
    const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(25_000) })
    const type = r.headers.get("content-type") ?? "(none)"
    const body = Buffer.from(await r.arrayBuffer())
    const size = pngSize(body)
    say(`=== ${label} ===`)
    say(`  HTTP ${r.status}  ${type}  ${body.length} bytes`)
    if (r.ok && size) say(`  PNG ${size.width}x${size.height}  the icon is there`)
    else say(`  NOT a usable PNG`)
    say(`  ${r.url !== u ? `redirected to ${r.url}` : "no redirect"}`)
    say("")
    return r.ok && !!size
  } catch (e) {
    say(`=== ${label} ===`)
    say(`  failed: ${e.message}`)
    say("")
    return false
  }
}

const a = await check("the URL in package.json", url)

// the same image at main, to show the difference a pinned tag makes
const mainUrl = url.replace("/v0.3.0/", "/main/")
await check("for contrast: same path on main", mainUrl)

// and confirm the tag really exists on the remote, since the URL depends on it
say("=== tag on the remote ===")
const { execFileSync } = await import("node:child_process")
try {
  const ls = execFileSync("git", ["ls-remote", "--tags", "origin", "v0.3.0"], { encoding: "utf8" })
  say(`  ${ls.trim() || "(no output)"}`)
  say(`  ${ls.includes("refs/tags/v0.3.0") ? "present, so the icon URL can resolve" : "MISSING"}`)
} catch (e) {
  say(`  failed: ${e.message}`)
}

writeFileSync("_local/icon-url.txt", out.join("\n"), "utf8")
say(a ? "\nicon URL is good, npm publish will carry a working image" : "\nicon URL is BROKEN, do not publish")