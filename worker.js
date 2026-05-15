// Cloudflare Worker that receives masked crash reports from A2Meter and turns
// them into GitHub issues. The Worker holds the GitHub PAT as a secret; the
// A2Meter client never sees a credential.
//
// Endpoints:
//   POST /report   — submit a crash report (JSON body, see schema below)
//   GET  /health   — liveness check
//
// Required secrets / vars (wrangler secret put / wrangler vars):
//   GITHUB_TOKEN  — fine-grained PAT with "Issues: Read and Write" on the repo
//   REPO_OWNER    — e.g. "a2meter"
//   REPO_NAME     — e.g. "Aion2Meter"
//   CRASH_LABEL   — label applied to crash issues (default "crash")
//
// Optional binding:
//   RATE_KV       — KV namespace for per-IP rate limiting (1 report / 60s / IP)

const SCHEMA_REQUIRED = ["hash", "source", "timestamp", "app_version", "os", "body"];
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_BODY_CHARS = 32_000;
const RATE_LIMIT_SECONDS = 60;

export default {
    /**
     * @param {Request} request
     * @param {{GITHUB_TOKEN:string, REPO_OWNER:string, REPO_NAME:string, CRASH_LABEL?:string, RATE_KV?:KVNamespace}} env
     */
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/health") {
            return json(200, { ok: true });
        }

        if (request.method !== "POST" || url.pathname !== "/report") {
            return json(404, { error: "not found" });
        }

        // ── parse / validate payload ────────────────────────────────────────
        let payload;
        try {
            payload = await request.json();
        } catch {
            return json(400, { error: "invalid json" });
        }

        for (const k of SCHEMA_REQUIRED) {
            if (typeof payload[k] !== "string" || payload[k].length === 0) {
                return json(400, { error: `missing field: ${k}` });
            }
        }
        if (!HASH_RE.test(payload.hash)) {
            return json(400, { error: "hash must be 64-char lowercase hex" });
        }
        if (payload.body.length > MAX_BODY_CHARS) {
            return json(413, { error: "body too large" });
        }

        // ── rate limit by IP (best-effort, only if KV binding exists) ───────
        if (env.RATE_KV) {
            const ip = request.headers.get("CF-Connecting-IP") || "unknown";
            const key = `rl:${ip}`;
            if (await env.RATE_KV.get(key)) {
                return json(429, { error: "rate limited" });
            }
            await env.RATE_KV.put(key, "1", { expirationTtl: RATE_LIMIT_SECONDS });
        }

        // ── route to existing issue or create a new one ─────────────────────
        const label = env.CRASH_LABEL || "crash";
        const existing = await findIssueByHash(env, payload.hash, label);

        if (existing) {
            const url = await addOccurrence(env, existing.number, payload);
            return json(200, { ok: true, action: "comment", issue: url });
        }
        const url2 = await createIssue(env, payload, label);
        return json(200, { ok: true, action: "create", issue: url2 });
    },
};

// ── GitHub helpers ──────────────────────────────────────────────────────────

async function findIssueByHash(env, hash, label) {
    // Public search API; works even on private repos for an authenticated PAT.
    const q = encodeURIComponent(
        `repo:${env.REPO_OWNER}/${env.REPO_NAME} is:issue label:${label} "<!--hash:${hash}-->"`
    );
    const resp = await gh(env, `https://api.github.com/search/issues?q=${q}&per_page=1`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data.items && data.items[0]) || null;
}

async function createIssue(env, p, label) {
    const title = buildTitle(p);
    const body  = buildIssueBody(p);
    const resp = await gh(env, `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/issues`, {
        method: "POST",
        body: JSON.stringify({ title, body, labels: [label, "auto-reported"] }),
    });
    if (!resp.ok) throw new Error(`github issue create failed: ${resp.status}`);
    const data = await resp.json();
    return data.html_url;
}

async function addOccurrence(env, issueNumber, p) {
    const body =
        `Another occurrence reported.\n\n` +
        `- timestamp: \`${p.timestamp}\`\n` +
        `- app: \`${p.app_version}\`\n` +
        `- os: \`${p.os}\`\n` +
        `- dotnet: \`${p.dotnet || "?"}\``;
    const resp = await gh(env, `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/issues/${issueNumber}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
    });
    if (!resp.ok) throw new Error(`github comment failed: ${resp.status}`);
    const data = await resp.json();
    return data.html_url;
}

function buildTitle(p) {
    // First non-blank stacktrace line after the header — usually "ExceptionType: msg".
    const lines = p.body.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
    let header = `${p.source}`;
    for (let i = 1; i < Math.min(lines.length, 8); i++) {
        if (!lines[i].startsWith("[") && !lines[i].startsWith("at ")) {
            header = lines[i];
            break;
        }
    }
    if (header.length > 120) header = header.slice(0, 117) + "...";
    return `[crash] ${header}`;
}

function buildIssueBody(p) {
    return (
        `<!--hash:${p.hash}-->\n` +
        `<!--auto-reported-by-a2meter-crash-proxy-->\n\n` +
        `**Source**: \`${p.source}\`  \n` +
        `**Timestamp**: \`${p.timestamp}\`  \n` +
        `**App version**: \`${p.app_version}\`  \n` +
        `**OS**: \`${p.os}\`  \n` +
        `**.NET**: \`${p.dotnet || "?"}\`\n\n` +
        `<details><summary>Stack trace (masked)</summary>\n\n` +
        "```\n" + p.body + "\n```\n" +
        `</details>\n\n` +
        `_This issue was created automatically. Paths, character names, and IP addresses are masked on the client before transmission._`
    );
}

async function gh(env, url, init = {}) {
    return fetch(url, {
        ...init,
        headers: {
            "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "a2meter-crash-proxy",
            "Content-Type": "application/json",
            ...(init.headers || {}),
        },
    });
}

function json(status, obj) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}
