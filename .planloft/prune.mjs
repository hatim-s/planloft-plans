// GITHUB_TOKEN pushes need explicit deployment triggers in the calling workflow.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const manifestPath = path.join(root, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const now = Date.now();
const slugs = new Set();

const kept = [];
let removed = 0;
if (manifest.version !== 1 || !Array.isArray(manifest.deploys)) throw new Error("Invalid hosting manifest");
for (const entry of manifest.deploys) {
  if (!entry || typeof entry.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(entry.id)) throw new Error("Unsafe plan id");
  if (typeof entry.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.slug) || entry.slug.length > 120 || ["p", "api", "assets", "gallery", "index", "public", "manifest", "favicon", "robots", "sitemap", "404"].includes(entry.slug) || slugs.has(entry.slug)) throw new Error("Unsafe or duplicate plan slug");
  slugs.add(entry.slug);
  if (entry.expiresAt !== null && (typeof entry.expiresAt !== "string" || !Number.isFinite(Date.parse(entry.expiresAt)))) throw new Error("Invalid plan expiry");
}
for (const directory of ["public", "public/p"]) {
  if (fs.existsSync(path.join(root, directory)) && fs.lstatSync(path.join(root, directory)).isSymbolicLink()) throw new Error("Unsafe public directory");
}
for (const entry of manifest.deploys) {
  const expired = entry.expiresAt && Date.parse(entry.expiresAt) <= now;
  if (expired) {
    fs.rmSync(path.join(root, "public", entry.slug), { recursive: true, force: true });
    fs.rmSync(path.join(root, "public", "p", entry.id), { recursive: true, force: true });
    removed++;
  } else {
    kept.push(entry);
  }
}
manifest.deploys = kept;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

if (removed > 0) {
  const generator = path.join(root, ".planloft", "update-indexes.mjs");
  const sitePath = path.join(root, ".planloft", "site.json");
  const site = fs.existsSync(sitePath) ? JSON.parse(fs.readFileSync(sitePath, "utf8")) : undefined;
  if (fs.existsSync(generator)) execFileSync(process.execPath, [generator, ...(site ? ["--pages-base-url", site.url] : [])]);
  execFileSync("git", ["config", "user.name", "planloft-bot"]);
  execFileSync("git", ["config", "user.email", "bot@users.noreply.github.com"]);
  execFileSync("git", ["add", "-A"]);
  execFileSync("git", ["commit", "-m", `planloft: prune ${removed} expired plan(s)`]);
  execFileSync("git", ["push"]);
}
console.log(`planloft-prune: removed ${removed}, kept ${kept.length}.`);

if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${removed > 0}\n`);
