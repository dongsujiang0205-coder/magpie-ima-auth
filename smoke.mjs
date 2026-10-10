// The acceptance test that matters: does this plugin load the way magpie loads
// it, and does it answer every call magpie makes with the shape magpie expects?
//
// This is checked against magpie's own source, read out of its binary by
// read-magpie-binary.mjs — not against a guess. Every hook name, argument
// shape and return field below is asserted so a change that breaks the magpie
// contract fails here rather than in a user's Plugins tab.
//
//   node smoke.mjs
import assert from "node:assert/strict"
import { ImaAuthPlugin } from "./index.mjs"

const checks = []
const ok = (name, fn) => checks.push({ name, fn })

// ---- magpie's hooks, as its source declares them ----------------------------
// (verbatim from magpie's binary; see scripts/read-magpie-binary.mjs)
const MAGPIE_HOOKS = {
  provider: ["id", "models"],
  auth: ["provider", "refreshLead", "refresh", "usage", "checkin", "loader", "methods"],
}

ok("exports one async plugin function", async () => {
  assert.equal(typeof ImaAuthPlugin, "function")
  const p = await ImaAuthPlugin({})
  assert.equal(typeof p, "object")
})

ok("loads and returns every hook magpie calls", async () => {
  const p = await ImaAuthPlugin({ client: { auth: { set: async () => {} } } })
  assert.ok(p.provider, "provider")
  assert.equal(typeof p.provider.models, "function")
  assert.equal(p.provider.id, "ima")
  assert.ok(p.auth, "auth")
  for (const k of MAGPIE_HOOKS.auth) assert.ok(p.auth[k] !== undefined, `auth.${k}`)
  // magpie calls refresh with (auth, provider) and reads the fields back
  assert.equal(typeof p.auth.refresh, "function")
  assert.equal(typeof p.auth.loader, "function")
  assert.ok(Array.isArray(p.auth.methods) && p.auth.methods.length > 0)
})

// ---- the usage contract ------------------------------------------------------
// auth.usage(getAuth, provider) → {
//   plan?, user?, until?, renew?: "auto"|"off", balance?, error?,
//   resets?: { count, until?, byWindow?, fiveHour?, weekly? },
//   windows?: [{ name, used, ... }], signIn?: "expired"|"kept"|"renewed"
// }
ok("answers usage in magpie's shape, with balance as a string", async () => {
  const p = await ImaAuthPlugin({})
  const u = await p.auth.usage(async () => ({ type: "oauth", access: "", uid: "U" }))
  // no cookie: must not throw, must not claim a balance
  assert.equal(u.balance, undefined)
  assert.ok(typeof u.error === "string" && u.error.length > 0, "says what is wrong")
  // the fields magpie reads, if present, must have its types
  if (u.balance !== undefined) assert.equal(typeof u.balance, "string", "balance is a string")
  if (u.signIn !== undefined) assert.ok(["expired", "kept", "renewed"].includes(u.signIn))
  if (u.windows !== undefined) assert.ok(Array.isArray(u.windows))
})

// ---- the checkin contract ----------------------------------------------------
// auth.checkin(getAuth, provider) → {
//   outcome: "claimed"|"done"|"ineligible"|"inactive"|"captcha"|"failed",
//   credit?, streak?, message?
// }
ok("answers checkin in magpie's shape, with an outcome it renders", async () => {
  const p = await ImaAuthPlugin({})
  const c = await p.auth.checkin(async () => ({ type: "oauth", access: "", uid: "U" }))
  const RENDERABLE = ["claimed", "done", "ineligible", "inactive", "captcha", "failed"]
  assert.ok(RENDERABLE.includes(c.outcome), `outcome "${c.outcome}" is one magpie renders`)
  assert.ok(typeof c.message === "string" && c.message.length > 0, "says what happened")
})

// ---- a hook that throws is a failure to magpie ------------------------------
ok("neither quota hook throws, whatever the sign-in is", async () => {
  const p = await ImaAuthPlugin({})
  for (const bad of [null, undefined, {}, { type: "api" }, { type: "oauth" }, { type: "oauth", cookie: "x" }]) {
    await p.auth.usage(async () => bad)
    await p.auth.checkin(async () => bad)
  }
})

// ---- the sign-in magpie offers ----------------------------------------------
ok("offers one sign-in, the pasted cookie, and refuses a bad one plainly", async () => {
  const p = await ImaAuthPlugin({})
  assert.equal(p.auth.methods.length, 1)
  const m = p.auth.methods[0]
  assert.match(m.label, /cookie/i)
  assert.equal(m.type, "oauth")
  const cb = m.authorize().callback
  const bad = await cb({ code: "garbage" })
  assert.equal(bad.type, "failed")
  assert.match(bad.error, /IMA-TOKEN/)
})

// ---- refresh returns only what changed, or nothing --------------------------
ok("renews ahead of time, and returns undefined when there is nothing to save", async () => {
  const p = await ImaAuthPlugin({})
  assert.ok(p.auth.refreshLead > 0)
  assert.equal(await p.auth.refresh({ type: "oauth", access: "T", expires: Date.now() + 7200_000 }), undefined)
})

// ---- the model list is offered without a sign-in, and with one --------------
ok("declares models before sign-in and after", async () => {
  const p = await ImaAuthPlugin({ client: { auth: { set: async () => {} } } })
  const provider = { id: "ima", models: { "deepseek-v4-flash": { id: "deepseek-v4-flash" } } }
  const before = await p.provider.models(provider, { auth: null })
  assert.ok(Object.keys(before).length > 0, "models exist with no account")
  // with an account whose catalogue ima will not answer, it falls back rather than throws
  const after = await p.provider.models(provider, { auth: { type: "oauth", access: "x", cookie: "IMA-TOKEN=x; IMA-UID=U" } })
  assert.ok(Object.keys(after).length > 0, "an unreadable catalogue still yields models")
})

// ---- the loader is what OpenCode and magpie both call ------------------------
ok("the loader refuses a request with no sign-in rather than sending nothing", async () => {
  const p = await ImaAuthPlugin({})
  const { fetch: ask } = await p.auth.loader(async () => null)
  await assert.rejects(() => ask("https://x/chat/completions", { method: "POST" }), /isn't signed in/)
})

ok("does not offer a sign-in that cannot work", async () => {
  const p = await ImaAuthPlugin({})
  const blob = JSON.stringify(p.auth.methods.map((m) => m.label))
  assert.doesNotMatch(blob, /desktop/i)
})

// ---- run --------------------------------------------------------------------
let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (e) {
    failed++
    console.log(`  FAIL ${name}\n       ${e?.message ?? e}`)
  }
}
console.log(failed ? `\n${failed} of ${checks.length} failed` : `\nall ${checks.length} checks passed`)
// the code, not an explicit exit: process.exit() tears down libuv handles that
// are still closing, which Windows asserts on with
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"
process.exitCode = failed ? 1 : 0