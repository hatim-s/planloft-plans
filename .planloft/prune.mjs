// Installed into <user>/planloft-plans by the github-pages adapter (ADR-0001 §D15, §D20).
// Runs daily in CI: delete /p/<id>/ folders past expiresAt, rewrite manifest, commit.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const manifestPath = path.join(root, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const now = Date.now();

const kept = [];
let removed = 0;
for (const entry of manifest.deploys ?? []) {
  const expired = entry.expiresAt && Date.parse(entry.expiresAt) <= now;
  if (expired) {
    fs.rmSync(path.join(root, "p", entry.id), { recursive: true, force: true });
    removed++;
  } else {
    kept.push(entry);
  }
}
manifest.deploys = kept;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

if (removed > 0) {
  execFileSync("git", ["config", "user.name", "planloft-bot"]);
  execFileSync("git", ["config", "user.email", "bot@users.noreply.github.com"]);
  execFileSync("git", ["add", "-A"]);
  execFileSync("git", ["commit", "-m", `planloft: prune ${removed} expired plan(s)`]);
  execFileSync("git", ["push"]);
}
console.log(`planloft-prune: removed ${removed}, kept ${kept.length}.`);
