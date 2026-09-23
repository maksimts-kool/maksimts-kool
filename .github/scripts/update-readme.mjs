// Regenerates the project tables in README.md from the GitHub API.
// Repos are ranked by stars, then by most recent push. Settings live in .github/readme-projects.json.
// Repos without a description get one from a free OpenRouter model when OPENROUTER_API_KEY is set.
import { readFile, writeFile } from "node:fs/promises";

const config = JSON.parse(await readFile(".github/readme-projects.json", "utf8"));
const token = process.env.GITHUB_TOKEN;

// Languages that describe tooling rather than what a project is written in.
const IGNORED_LANGUAGES = new Set(["Dockerfile", "Shell", "PowerShell", "Batchfile", "Makefile", "Procfile", "Hack", "Nix"]);

async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "readme-projects",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function listRepos() {
  const repos = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/users/${config.user}/repos?type=owner&per_page=100&page=${page}`);
    repos.push(...batch);
    if (batch.length < 100) return repos;
  }
}

function rank(repos) {
  const pinned = config.pinned ?? [];
  return repos.sort((a, b) => {
    const pa = pinned.indexOf(a.name), pb = pinned.indexOf(b.name);
    if (pa !== pb) return (pa === -1 ? Infinity : pa) - (pb === -1 ? Infinity : pb);
    return b.stargazers_count - a.stargazers_count || Date.parse(b.pushed_at) - Date.parse(a.pushed_at);
  });
}

async function stackOf(repo) {
  const override = config.about?.[repo.name]?.stack;
  if (override) return override;
  const languages = await api(`/repos/${repo.full_name}/languages`);
  const names = Object.keys(languages).filter((l) => !IGNORED_LANGUAGES.has(l)).slice(0, 3);
  return names.join(" · ") || "—";
}

// Descriptions written by the AI are cached so each repo is only summarised once.
const CACHE_PATH = ".github/readme-descriptions.json";
const cache = JSON.parse(await readFile(CACHE_PATH, "utf8").catch(() => "{}"));

async function readmeExcerpt(repo) {
  try {
    const { content } = await api(`/repos/${repo.full_name}/readme`);
    return Buffer.from(content, "base64").toString("utf8").slice(0, 4000);
  } catch {
    return "";
  }
}

async function generateDescription(repo, language) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return "";
  const readme = await readmeExcerpt(repo);
  const languages = Object.keys(await api(`/repos/${repo.full_name}/languages`)).join(", ");
  const prompt = [
    `Write a one-line description of this GitHub repository for a profile README, in ${language}.`,
    "At most 12 words. No trailing period, no quotes, no emoji, no markdown. Reply with the description only.",
    "",
    `Name: ${repo.name}`,
    `Languages: ${languages || "unknown"}`,
    `README:\n${readme || "(none)"}`,
  ].join("\n");
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ models: config.aiModels ?? ["openrouter/free"], messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const text = (await res.json()).choices?.[0]?.message?.content ?? "";
    const line = text.trim().split("\n")[0].replace(/^["'`*]+|["'`*.]+$/g, "").trim();
    if (!line) return "";
    console.log(`Generated description for ${repo.name}: ${line}`);
    return (cache[repo.name] = line.slice(0, 120));
  } catch (err) {
    console.warn(`Could not generate a description for ${repo.name}: ${err.message}`);
    return "";
  }
}

async function describe(repo, language) {
  return repo.description || config.about?.[repo.name]?.description || cache[repo.name] || generateDescription(repo, language);
}

const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");

async function row(repo, bold, language) {
  const about = config.about?.[repo.name] ?? {};
  const title = about.title ?? repo.name;
  const name = bold ? `**${title}**` : title;
  const stars = repo.stargazers_count > 0 ? ` ⭐ ${repo.stargazers_count}` : "";
  const description = await describe(repo, language);
  return `| [${name}](${repo.html_url})${stars} | ${cell(description)} | ${cell(await stackOf(repo))} |`;
}

async function table(repos, headers, boldTop, language) {
  const rows = [];
  for (const [i, repo] of repos.entries()) rows.push(await row(repo, i < boldTop, language));
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows].join("\n");
}

function replaceSection(readme, marker, content) {
  const start = `<!-- ${marker}:START -->`, end = `<!-- ${marker}:END -->`;
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!pattern.test(readme)) throw new Error(`README.md is missing the ${marker} markers`);
  return readme.replace(pattern, `${start}\n${content}\n${end}`);
}

const hidden = new Set(config.hidden ?? []);
const school = new Set(config.school ?? []);
const visible = (await listRepos()).filter((r) => !r.fork && !r.archived && !r.private && !hidden.has(r.name));
const isSchool = (r) => school.has(r.name) || r.topics?.includes("kool") || r.topics?.includes("school");

const personal = rank(visible.filter((r) => !isSchool(r))).slice(0, config.personalCount ?? 5);
const coursework = rank(visible.filter(isSchool)).slice(0, config.schoolCount ?? 6);

let readme = await readFile("README.md", "utf8");
readme = replaceSection(readme, "PROJECTS", await table(personal, ["Project", "What it does", "Stack"], 3, "English"));
readme = replaceSection(readme, "SCHOOL", await table(coursework, ["Hoidla", "Sisu", "Keel"], 0, "Estonian"));
await writeFile("README.md", readme);
await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");

console.log(`Personal: ${personal.map((r) => r.name).join(", ")}`);
console.log(`School: ${coursework.map((r) => r.name).join(", ")}`);
