#!/usr/bin/env node
/**
 * Install this repo's opencode plugins and commands into the global opencode
 * config directory. Copies (not symlinks) so the installed files survive the
 * repo moving, at the cost of needing a re-run after every merge.
 *
 *   npm run install:opencode
 */
const { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync } = require("node:fs")
const { homedir } = require("node:os")
const { join } = require("node:path")

const REPO = join(__dirname, "..")
const TARGET_ROOT = join(homedir(), ".config", "opencode")

const GROUPS = [
  { from: join(REPO, "opencode", "plugins"), to: join(TARGET_ROOT, "plugins"), ext: ".ts" },
  { from: join(REPO, "opencode", "commands"), to: join(TARGET_ROOT, "commands"), ext: ".md" },
]

let copied = 0
for (const group of GROUPS) {
  if (!existsSync(group.from)) {
    console.log(`skip ${group.from} (missing)`)
    continue
  }
  const files = readdirSync(group.from).filter(
    (f) => f.endsWith(group.ext) && statSync(join(group.from, f)).isFile(),
  )
  if (files.length === 0) continue
  mkdirSync(group.to, { recursive: true })
  for (const file of files) {
    const src = join(group.from, file)
    const dest = join(group.to, file)
    // An older install may have symlinked this file back into the repo; copying
    // onto it would truncate the source.
    if (existsSync(dest) && realpathSync(dest) === realpathSync(src)) {
      console.log(`  ${file} -> already linked to the repo, left alone`)
      continue
    }
    copyFileSync(src, dest)
    console.log(`  ${file} -> ${dest}`)
    copied++
  }
}

console.log(
  copied === 0
    ? "Nothing to install."
    : `Installed ${copied} file(s). Restart running opencode instances to pick up the new code.`,
)
