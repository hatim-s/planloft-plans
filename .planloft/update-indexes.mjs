import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const README_START = "<!-- planloft:active-plans:start -->";
const README_END = "<!-- planloft:active-plans:end -->";
const README_HEADING = "## Active plans";
const MANAGED_README_HEADING = "## Planloft active plans";
const DEFAULT_README = "# planloft-plans\n\nPlanloft plan and document deploys.";

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

function invalidManifest(reason) {
  return new Error(`manifest.json is invalid: ${reason}.`);
}

export function readManifest(root) {
  const contents = readOutputFile(path.join(root, "manifest.json"), "manifest.json");
  if (contents === undefined) throw invalidManifest("it must contain readable JSON");
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    throw invalidManifest("it must contain readable JSON");
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.deploys)) {
    throw invalidManifest("version 1 and a deploys array are required");
  }
  const ids = new Set();
  for (const [index, entry] of value.deploys.entries()) {
    if (!isRecord(entry)) throw invalidManifest(`deploys[${index}] must be an object`);
    if (!isNonemptyString(entry.id) || !/^[a-zA-Z0-9_-]+$/.test(entry.id)) {
      throw invalidManifest(`deploys[${index}].id must be a safe path segment`);
    }
    if (ids.has(entry.id)) throw invalidManifest(`deploys[${index}].id is duplicated`);
    ids.add(entry.id);
    for (const field of ["project", "slug", "title", "kind"]) {
      if (!isNonemptyString(entry[field])) {
        throw invalidManifest(`deploys[${index}].${field} must be a nonempty string`);
      }
    }
    if (!isCanonicalIsoTimestamp(entry.createdAt)) {
      throw invalidManifest(`deploys[${index}].createdAt must be a canonical ISO timestamp`);
    }
    if (entry.expiresAt !== null && !isCanonicalIsoTimestamp(entry.expiresAt)) {
      throw invalidManifest(
        `deploys[${index}].expiresAt must be a canonical ISO timestamp or null`,
      );
    }
  }
  return value;
}

function livePlans(manifest, now) {
  const nowMs = now.getTime();
  return manifest.deploys
    .filter((entry) => entry.expiresAt === null || Date.parse(entry.expiresAt) > nowMs)
    .sort(
      (left, right) =>
        compareText(left.project, right.project) ||
        compareText(left.title, right.title) ||
        compareText(left.id, right.id),
    );
}

function escapeHtml(value) {
  const entities = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (character) => entities[character]);
}

function escapeMarkdown(value) {
  return value
    .replace(/\r\n?|\n/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_~])/g, "\\$1")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\|/g, "\\|");
}

function displayDate(value) {
  if (!value) return "No expiry";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "Unknown";
  return new Date(timestamp).toISOString().slice(0, 10);
}

function normalizePagesBaseUrl(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TypeError("pagesBaseUrl must be a string.");
  return value.trim().replace(/\/+$/, "") || undefined;
}

function resolvePagesBaseUrl(root) {
  try {
    const remote = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = remote.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    if (!match) return undefined;
    return `https://${match[1]}.github.io/${match[2]}`;
  } catch {
    return undefined;
  }
}

function readmeHref(plan, pagesBaseUrl) {
  const prefix = pagesBaseUrl ? `${pagesBaseUrl}/` : "";
  return `${prefix}p/${encodeURIComponent(plan.id)}/`;
}

function renderReadmeBlock(plans, pagesBaseUrl) {
  if (plans.length === 0) return "_No active plans._";
  const rows = plans.map((plan) => {
    const title = escapeMarkdown(plan.title);
    const project = escapeMarkdown(plan.project || "Unnamed project");
    const kind = escapeMarkdown(plan.kind);
    const expires = displayDate(plan.expiresAt);
    return `| [${title}](${readmeHref(plan, pagesBaseUrl)}) | ${project} | ${kind} | ${expires} |`;
  });
  return [
    "| Plan | Project | Kind | Expires |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function chooseManagedHeading(lines) {
  const headings = new Set(lines.map((line) => line.trim().toLowerCase()));
  if (!headings.has(README_HEADING.toLowerCase())) return README_HEADING;
  let candidate = MANAGED_README_HEADING;
  let suffix = 2;
  while (headings.has(candidate.toLowerCase())) candidate = `${MANAGED_README_HEADING} ${suffix++}`;
  return candidate;
}

function replaceReadmeSection(readme, block) {
  const lineEnding = readme.includes("\r\n") ? "\r\n" : "\n";
  const normalized = readme.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const starts = lines.flatMap((line, index) => line === README_START ? [index] : []);
  const ends = lines.flatMap((line, index) => line === README_END ? [index] : []);
  if (starts.length > 1 || ends.length > 1) {
    throw new Error("README.md has duplicate Planloft index markers.");
  }
  if (starts.length !== ends.length) {
    throw new Error("README.md has an incomplete Planloft index marker pair.");
  }
  if (starts.length === 1) {
    const [start] = starts;
    const [end] = ends;
    if (start === undefined || end === undefined || end <= start) {
      throw new Error("README.md has invalid Planloft index marker order.");
    }
    return [
      ...lines.slice(0, start + 1),
      ...block.split("\n"),
      ...lines.slice(end),
    ].join(lineEnding);
  }

  const heading = chooseManagedHeading(lines);
  const section = [
    heading,
    "",
    README_START,
    ...block.split("\n"),
    README_END,
  ].join(lineEnding);
  if (readme.length === 0) return `${section}${lineEnding}`;
  const hasLineBreak = normalized.endsWith("\n");
  const hasBlankLine = normalized.endsWith("\n\n");
  const prefix = hasLineBreak ? readme : `${readme}${lineEnding}`;
  return `${prefix}${hasBlankLine ? "" : lineEnding}${section}${lineEnding}`;
}

function timeMarkup(expiresAt) {
  const label = '<span class="sr-only">Expires: </span>';
  if (expiresAt === null) return `<span class="expiry">${label}No expiry</span>`;
  const timestamp = Date.parse(expiresAt);
  if (Number.isNaN(timestamp)) return `<span class="expiry">${label}Unknown expiry</span>`;
  return `<span class="expiry">${label}<time datetime="${escapeHtml(expiresAt)}">${displayDate(expiresAt)}</time></span>`;
}

function renderHtml(plans) {
  const items = plans.map((plan) => {
    const href = `./p/${encodeURIComponent(plan.id)}/`;
    return `<li class="plan"><a class="plan-link" href="${escapeHtml(href)}"><span class="id"><span class="sr-only">Plan ID: </span>${escapeHtml(plan.id)}</span><div class="plan-copy"><h2>${escapeHtml(plan.title)}</h2><span class="project"><span class="sr-only">Project: </span>${escapeHtml(plan.project || "Unnamed project")}</span><span class="open">Open plan</span></div><span class="meta"><span class="kind"><span class="sr-only">Kind: </span>${escapeHtml(plan.kind)}</span>${timeMarkup(plan.expiresAt)}</span></a></li>`;
  }).join("\n");
  const list = plans.length === 0 ? "" : `<ol class="index" role="list">\n${items}\n</ol>`;
  const emptyState = plans.length === 0
    ? `
<section class="empty" aria-labelledby="empty-heading">
<h2 id="empty-heading">No active plans</h2>
<p>Publish a plan with Planloft and it will appear here.</p>
</section>`
    : "";
  const count = `${plans.length} ${plans.length === 1 ? "active plan" : "active plans"}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>Planloft plans</title>
<style>
:root {
  color-scheme: light dark;
  --canvas: #f7f8fa;
  --ink: #101828;
  --muted: #667085;
  --rule: #d0d5dd;
  --accent: #175cd3;
}
@media (prefers-color-scheme: dark) {
  :root {
    --canvas: #0c111d;
    --ink: #f2f4f7;
    --muted: #98a2b3;
    --rule: #344054;
    --accent: #84adff;
  }
}
* { box-sizing: border-box; }
html { background: var(--canvas); }
body {
  min-height: 100vh;
  margin: 0;
  color: var(--ink);
  background: var(--canvas);
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  text-rendering: optimizeLegibility;
}
a { color: inherit; }
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.shell {
  width: min(calc(100% - 2rem), 72rem);
  margin-inline: auto;
  padding-block: clamp(2.5rem, 8vw, 7rem);
}
.masthead {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2rem;
  align-items: end;
  padding-bottom: clamp(2rem, 6vw, 5rem);
  border-bottom: 2px solid var(--ink);
}
.product {
  margin: 0 0 1.25rem;
  color: var(--accent);
  font: 650 0.8rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
}
h1 {
  max-width: 9ch;
  margin: 0;
  font-family: "Arial Narrow", "Aptos Display", ui-sans-serif, sans-serif;
  font-size: clamp(3.6rem, 12vw, 8rem);
  font-weight: 750;
  line-height: 0.82;
  letter-spacing: -0.075em;
}
.lede {
  max-width: 36rem;
  margin: 1.5rem 0 0;
  color: var(--muted);
  font-size: clamp(1rem, 2vw, 1.2rem);
  line-height: 1.55;
}
.count {
  margin: 0;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.count-visual,
.count-visual span {
  display: block;
}
.count strong {
  display: block;
  font-family: "Arial Narrow", "Aptos Display", ui-sans-serif, sans-serif;
  font-size: clamp(3.5rem, 9vw, 7rem);
  font-weight: 700;
  line-height: 0.8;
  letter-spacing: -0.06em;
}
.count-visual span {
  margin-top: 0.75rem;
  color: var(--muted);
  font: 600 0.85rem/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.index {
  margin: 0;
  padding: 0;
  list-style: none;
}
.plan { border-bottom: 1px solid var(--rule); }
.plan-link {
  display: grid;
  grid-template-columns: minmax(0, 0.35fr) minmax(0, 1fr) minmax(0, 0.45fr);
  gap: clamp(1rem, 3vw, 2.5rem);
  align-items: start;
  padding-block: 1.5rem;
  text-decoration: none;
}
.plan-link:hover h2,
.plan-link:focus-visible h2 {
  color: var(--accent);
  text-decoration: underline;
  text-decoration-thickness: 0.08em;
  text-underline-offset: 0.16em;
}
.id,
.project,
.kind,
.expiry,
.empty p,
footer {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.id,
.project,
.kind,
.expiry {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.id {
  color: var(--muted);
  font-size: 0.78rem;
  line-height: 1.5;
}
.plan-copy { min-width: 0; }
.plan-copy h2 {
  margin: 0;
  font-size: clamp(1.15rem, 2.5vw, 1.55rem);
  font-weight: 650;
  line-height: 1.2;
  letter-spacing: -0.025em;
  overflow-wrap: anywhere;
}
.project {
  display: block;
  margin-top: 0.45rem;
  color: var(--muted);
  font-size: 0.82rem;
  line-height: 1.45;
}
.open {
  display: inline-block;
  margin-top: 0.65rem;
  color: var(--accent);
  font-size: 0.72rem;
  font-weight: 700;
  line-height: 1.3;
}
.plan-link:hover .open,
.plan-link:focus-visible .open {
  text-decoration: underline;
  text-underline-offset: 0.2em;
}
.meta {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.45rem;
  color: var(--muted);
  font-size: 0.8rem;
  line-height: 1.4;
  text-align: right;
}
.kind { color: var(--accent); }
.empty {
  padding-block: clamp(3rem, 10vw, 7rem);
  border-bottom: 1px solid var(--rule);
}
.empty h2 {
  margin: 0;
  font-size: clamp(1.8rem, 5vw, 3rem);
  letter-spacing: -0.04em;
}
.empty p {
  margin: 0.75rem 0 0;
  color: var(--muted);
}
footer {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding-top: 1.5rem;
  color: var(--muted);
  font-size: 0.75rem;
  line-height: 1.5;
}
a:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 4px;
}
@media (max-width: 46rem) {
  .masthead { grid-template-columns: 1fr; }
  .count { text-align: left; }
  .plan-link { grid-template-columns: 1fr; }
  .meta {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    text-align: left;
  }
  footer { flex-direction: column; }
}
</style>
</head>
<body>
<main class="shell">
<header class="masthead">
<div>
<p class="product">Planloft / GitHub Pages</p>
<h1>Active plans</h1>
<p class="lede">Plans currently available on GitHub Pages.</p>
</div>
<p class="count"><span class="sr-only">${count}</span><span class="count-visual" aria-hidden="true"><strong>${plans.length}</strong><span>${plans.length === 1 ? "active plan" : "active plans"}</span></span></p>
</header>
${list}${emptyState}
<footer><span>Live deployments from manifest.json</span><span>Expired plans leave this list automatically.</span></footer>
</main>
</body>
</html>
`;
}

function filesystemCode(error) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function inspectOutput(file, name) {
  let stats;
  try {
    stats = fs.lstatSync(file);
  } catch (error) {
    if (filesystemCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`${name} must not be a symbolic link.`);
  }
  if (!stats.isFile()) {
    throw new Error(`${name} must be a regular file.`);
  }
  return stats;
}

function readOutputFile(file, name) {
  if (!inspectOutput(file, name)) return undefined;
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (filesystemCode(error) === "ELOOP") {
      throw new Error(`${name} must not be a symbolic link.`);
    }
    throw error;
  }
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error(`${name} must be a regular file.`);
    }
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeOutputIfChanged(file, name, contents) {
  if (inspectOutput(file, name)) {
    if (readOutputFile(file, name) === contents) return false;
  }
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollow;
  let descriptor;
  try {
    descriptor = fs.openSync(file, flags);
  } catch (error) {
    if (filesystemCode(error) === "ELOOP") {
      throw new Error(`${name} must not be a symbolic link.`);
    }
    throw error;
  }
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error(`${name} must be a regular file.`);
    }
    fs.writeFileSync(descriptor, contents, { encoding: "utf8" });
  } finally {
    fs.closeSync(descriptor);
  }
  return true;
}

function parseNow(value) {
  let now;
  if (value === undefined) now = new Date();
  else if (value instanceof Date) now = new Date(value.getTime());
  else if (typeof value === "string") now = new Date(value);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("now must be a valid date or ISO timestamp.");
  }
  return now;
}

function assertPreparedIndexes(prepared) {
  if (
    !isRecord(prepared) ||
    typeof prepared.readme !== "string" ||
    typeof prepared.html !== "string" ||
    !Number.isSafeInteger(prepared.count) ||
    prepared.count < 0
  ) {
    throw new TypeError("prepared plan indexes are invalid.");
  }
}

export function preparePlanIndexes(root, options = {}) {
  const manifest = readManifest(root);
  const now = parseNow(options.now);
  const plans = livePlans(manifest, now);
  const pagesBaseUrl = normalizePagesBaseUrl(
    options.pagesBaseUrl ?? resolvePagesBaseUrl(root),
  );
  const readmePath = path.join(root, "README.md");
  const htmlPath = path.join(root, "index.html");
  inspectOutput(readmePath, "README.md");
  inspectOutput(htmlPath, "index.html");
  const readme = readOutputFile(readmePath, "README.md") ?? DEFAULT_README;
  return {
    readme: replaceReadmeSection(readme, renderReadmeBlock(plans, pagesBaseUrl)),
    html: renderHtml(plans),
    count: plans.length,
  };
}

export function writePlanIndexes(root, prepared) {
  assertPreparedIndexes(prepared);
  const readmePath = path.join(root, "README.md");
  const htmlPath = path.join(root, "index.html");
  inspectOutput(readmePath, "README.md");
  inspectOutput(htmlPath, "index.html");
  writeOutputIfChanged(readmePath, "README.md", prepared.readme);
  writeOutputIfChanged(htmlPath, "index.html", prepared.html);
  return { count: prepared.count };
}

export function updatePlanIndexes(root, options = {}) {
  const prepared = preparePlanIndexes(root, options);
  writePlanIndexes(root, prepared);
  return { count: prepared.count };
}

function parseCliArguments(args) {
  let pagesBaseUrl;
  let now;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--now" || argument?.startsWith("--now=")) {
      if (now !== undefined) throw new Error("--now may only be provided once.");
      now = argument === "--now" ? args[++index] : argument.slice("--now=".length);
      if (!now) throw new Error("--now requires an ISO timestamp.");
    } else if (argument === "--pages-base-url" || argument?.startsWith("--pages-base-url=")) {
      pagesBaseUrl = argument === "--pages-base-url"
        ? args[++index]
        : argument.slice("--pages-base-url=".length);
      if (!pagesBaseUrl) throw new Error("--pages-base-url requires a value.");
    } else if (argument?.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}.`);
    } else if (pagesBaseUrl === undefined) {
      pagesBaseUrl = argument;
    } else {
      throw new Error("Only one pages base URL may be provided.");
    }
  }
  return { pagesBaseUrl, now };
}

const invokedPath = process.argv[1];
if (invokedPath && fs.realpathSync(invokedPath) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const options = parseCliArguments(process.argv.slice(2));
  updatePlanIndexes(process.cwd(), options);
}
