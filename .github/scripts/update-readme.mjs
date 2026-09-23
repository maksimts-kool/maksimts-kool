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

// Repos pinned on the GitHub profile already appear below the README, so they can be left out of the tables.
async function githubPins() {
  if (!config.skipGitHubPins) return [];
  try {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "readme-projects" },
      body: JSON.stringify({
        query: `query($login: String!) { user(login: $login) { pinnedItems(first: 6, types: REPOSITORY) { nodes { ... on Repository { name } } } } }`,
        variables: { login: config.user },
      }),
    });
    const { data, errors } = await res.json();
    if (errors || !data) throw new Error(JSON.stringify(errors ?? res.status));
    return data.user.pinnedItems.nodes.map((n) => n.name);
  } catch (err) {
    console.warn(`Could not read GitHub profile pins, so pinned repos stay in the tables: ${err.message}`);
    return [];
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

async function generateDescription(repo, language, examples) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return "";
  const readme = await readmeExcerpt(repo);
  const languages = Object.keys(await api(`/repos/${repo.full_name}/languages`)).join(", ");
  const prompt = [
    `Write a one-line description of this GitHub repository for a profile README, in ${language}.`,
    "At most 12 words. No trailing period, no quotes, no emoji, no markdown. Reply with the description only.",
    "Match the style of these existing descriptions:",
    ...examples.map((e) => `- ${e}`),
    "",
    `Name: ${repo.name}`,
    `Languages: ${languages || "unknown"}`,
    `README:\n${readme || "(none)"}`,
  ].join("\n");
  // Free models are often rate-limited or reply with nothing, so try each one in turn.
  for (const model of config.aiModels ?? ["openrouter/free"]) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      const text = (await res.json()).choices?.[0]?.message?.content ?? "";
      const line = text.trim().split("\n")[0].replace(/^["'`*]+|["'`*.]+$/g, "").trim();
      if (line.split(/\s+/).length < 3) throw new Error(`unusable reply ${JSON.stringify(line)}`);
      console.log(`Generated description for ${repo.name} with ${model}: ${line}`);
      return (cache[repo.name] = line.slice(0, 120));
    } catch (err) {
      console.warn(`${model} could not describe ${repo.name}: ${err.message}`);
    }
  }
  return "";
}

async function describe(repo, language, examples) {
  return repo.description || config.about?.[repo.name]?.description || cache[repo.name] || generateDescription(repo, language, examples);
}

const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");

async function row(repo, bold, language, examples) {
  const about = config.about?.[repo.name] ?? {};
  const title = about.title ?? repo.name;
  const name = bold ? `**${title}**` : title;
  const stars = repo.stargazers_count > 0 ? ` ⭐ ${repo.stargazers_count}` : "";
  const description = await describe(repo, language, examples);
  return `| [${name}](${repo.html_url})${stars} | ${cell(description)} | ${cell(await stackOf(repo))} |`;
}

async function table(repos, all, headers, boldTop, language) {
  // Hand-written descriptions from the same section show the model the expected tone and language.
  const examples = all.map((r) => config.about?.[r.name]?.description).filter(Boolean).slice(0, 6);
  const rows = [];
  for (const [i, repo] of repos.entries()) rows.push(await row(repo, i < boldTop, language, examples));
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows].join("\n");
}

function replaceSection(readme, marker, content) {
  const start = `<!-- ${marker}:START -->`, end = `<!-- ${marker}:END -->`;
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!pattern.test(readme)) throw new Error(`README.md is missing the ${marker} markers`);
  return readme.replace(pattern, `${start}\n${content}\n${end}`);
}

const pins = await githubPins();
if (pins.length) console.log(`Skipping repos pinned on GitHub: ${pins.join(", ")}`);
const hidden = new Set([...(config.hidden ?? []), ...pins]);
const school = new Set(config.school ?? []);
const visible = (await listRepos()).filter((r) => !r.fork && !r.archived && !r.private && !hidden.has(r.name));
const isSchool = (r) => school.has(r.name) || r.topics?.includes("kool") || r.topics?.includes("school");

const allPersonal = rank(visible.filter((r) => !isSchool(r)));
const allSchool = rank(visible.filter(isSchool));
const personal = allPersonal.slice(0, config.personalCount ?? 5);
const coursework = allSchool.slice(0, config.schoolCount ?? 6);

let readme = await readFile("README.md", "utf8");
readme = replaceSection(readme, "PROJECTS", await table(personal, allPersonal, ["Project", "What it does", "Stack"], 3, "English"));
readme = replaceSection(readme, "SCHOOL", await table(coursework, allSchool, ["Hoidla", "Sisu", "Keel"], 0, "Estonian"));
await writeFile("README.md", readme);
await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");

console.log(`Personal: ${personal.map((r) => r.name).join(", ")}`);
console.log(`School: ${coursework.map((r) => r.name).join(", ")}`);
