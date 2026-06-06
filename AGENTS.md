# a2meter-crash-proxy

**Parent**: [../AGENTS.md](../AGENTS.md)

Cloudflare Worker that receives masked crash reports from A2Meter clients and transforms them into GitHub issues. Acts as a secure intermediary, holding the GitHub PAT token while keeping credentials away from distributed binaries.

## Key Files

| File | Purpose |
|------|---------|
| `worker.js` | Cloudflare Worker entry point; handles `/report` and `/health` endpoints |
| `wrangler.toml` | Worker configuration: environment vars, KV namespace bindings |
| `package.json` | Dependencies: wrangler CLI |
| `README.md` | Korean deployment and operation docs |

## Subdirectories

| Directory | Contents |
|-----------|----------|
| `.wrangler/` | Wrangler cache and build artifacts |
| `node_modules/` | Dependencies (wrangler only) |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/report` | Submit a masked crash report; returns issue URL or 429/400/413 |
| `GET` | `/health` | Liveness check; returns `{"ok":true}` |

## Request Payload Schema

```json
{
  "hash": "4f8b...{64 hex chars}",
  "source": "UnhandledException",
  "timestamp": "2026-05-15T14:23:01.123+09:00",
  "app_version": "1.2.3",
  "os": "Microsoft Windows NT 10.0.26100.0",
  "dotnet": "8.0.10",
  "body": "{masked stack trace, max 32KB}"
}
```

- **hash**: SHA-256 of the body (lowercase hex, 64 chars); deduplication key
- **body**: Masked stack trace. Client masks: file paths, player names, IP addresses

## Processing Flow

1. **Validate**: Check required fields, hash format, body size (≤32KB)
2. **Rate limit** (if KV enabled): 1 report per IP per 60 seconds
3. **Deduplicate**: Search GitHub for existing issue with same hash
   - Found → Add "+1 occurrence" comment with timestamp/version/OS/.NET
   - Not found → Create new issue with title and body
4. **Return**: JSON with action (`"create"` or `"comment"`) and issue URL

## GitHub Integration

- **Search**: Uses GitHub Search API with hash in HTML comment `<!--hash:...-->`
- **Create**: Posts new issue with labels (`crash`, `auto-reported`)
- **Comment**: Adds occurrence record to existing issue
- **PAT scope**: Fine-grained, "Issues: read and write" only; no code/secrets access

## Configuration

### Environment Secrets (wrangler secret put)

- `GITHUB_TOKEN`: GitHub Personal Access Token (fine-grained, Issues scope)

### Environment Variables (wrangler.toml [vars])

| Var | Default | Purpose |
|-----|---------|---------|
| `REPO_OWNER` | `a2meter` | GitHub org/user |
| `REPO_NAME` | `A2Meter-Crashes` | Target repository name |
| `CRASH_LABEL` | `Crash` | Label applied to auto-created issues |

### Optional: KV Rate Limiting

Uncomment `[[kv_namespaces]]` in `wrangler.toml` and set the binding ID:

```toml
[[kv_namespaces]]
binding = "RATE_KV"
id      = "your-kv-namespace-id"
```

Create the namespace: `wrangler kv:namespace create RATE_KV`

## Deployment

```bash
npm install
wrangler login
wrangler secret put GITHUB_TOKEN
wrangler deploy
```

Default URL: `https://a2meter-crash-proxy.<subdomain>.workers.dev`

## Scripts

```bash
npm run dev        # Local development on port 8787
npm run deploy     # Deploy to Cloudflare Workers
```

## Client Integration

A2Meter client sends masked reports to the worker endpoint:

```csharp
// In A2Meter CrashReporter.cs
const string ProxyEndpoint = "https://a2meter-crash-proxy.workers.dev/report";
```

Masking applied by client before transmission:
- File paths: `C:\Users\<user>\...`
- Player names: `<player>[<server>]`
- IP addresses: `<ip>`

## Security Considerations

- **Token protection**: PAT stored as Cloudflare secret; never in source or build output
- **Rate limiting**: Per-IP limit (60s cooldown) prevents spam; Cloudflare WAF provides DDoS protection
- **PAT scope**: Fine-grained token with Issues-only access; safe if leaked
- **Data masking**: Client-side masking reduces data exposure

## Error Responses

| Status | Error | Meaning |
|--------|-------|---------|
| 400 | `missing field: X` | Required field missing or empty |
| 400 | `invalid json` | Malformed JSON body |
| 400 | `hash must be 64-char lowercase hex` | Invalid hash format |
| 413 | `body too large` | Body exceeds 32KB |
| 429 | `rate limited` | Same IP, within 60s (if KV enabled) |
| 200 | Success | Returns `{"ok":true,"action":"create"/"comment","issue":"<url>"}` |

## Costs (Cloudflare Free Tier)

- Workers: 100,000 requests/day
- KV (if enabled): 100,000 read + 1,000 write per day

Typical A2Meter usage stays well within limits.

## AI Agent Instructions

When working with this codebase:

1. **Worker is stateless**: All state is in GitHub issues. Deduplication happens via GitHub Search API.
2. **Payload validation**: Check required fields and sizes before GitHub operations to fail fast.
3. **Error handling**: Return JSON with error messages; avoid stack traces in responses.
4. **Rate limiting**: KV rate limit is optional; if enabled, it tracks per-IP in a key like `rl:<ip>`.
5. **GitHub API calls**: Always include proper headers (Authorization, Accept, User-Agent); use `fetch` with retry-friendly error handling.
6. **Title generation**: Extract exception type from stack trace body; truncate to 120 chars.
7. **Body formatting**: Use HTML comments for metadata (hash, auto-report marker); wrap stack trace in details/summary for readability.

## Related Projects

- **a2meter-crash-mcp**: Node.js MCP server that reads and analyzes GitHub crash issues
- **A2Meter**: Main application that generates and sends masked crash reports
- **A2Meter-Crashes**: GitHub repository receiving crash issues
