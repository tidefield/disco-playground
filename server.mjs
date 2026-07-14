import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const port = Number(process.env.PORT || 8080);
const publicRoot = resolve("public");
const dataRoot = resolve(process.env.PLAYGROUND_DATA_DIR || ".data");
const maxBodySize = 512 * 1024;

const defaultFiles = {
  "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Hello RC</title>
    <link rel="stylesheet" href="style.css">
  </head>
  <body>
    <main>
  <p class="kicker">hello from the playground</p>
  <h1>Build something small and strange.</h1>
  <p>Change the code, save it, then share the live URL with another Recurser.</p>
  <button id="spark">Make it sparkle</button>
    </main>
    <script src="script.js"></script>
  </body>
</html>`,
  "style.css": `body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f7f2e8;
  color: #1d1a16;
}

main {
  width: min(720px, calc(100vw - 32px));
}

.kicker {
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 12px;
}

h1 {
  font-size: clamp(40px, 9vw, 88px);
  line-height: 0.95;
  margin: 0 0 20px;
}

button {
  border: 1px solid #1d1a16;
  border-radius: 6px;
  padding: 10px 14px;
  background: #ffffff;
  color: inherit;
  cursor: pointer;
}`,
  "script.js": `document.querySelector("#spark")?.addEventListener("click", () => {
  document.body.style.background = \`hsl(\${Math.random() * 360} 70% 88%)\`;
});`,
};

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
]);

function isSlug(value) {
  return /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(value);
}

function appFilePath(slug) {
  return join(dataRoot, `${slug}.json`);
}

function normalizeAppPath(value) {
  const decoded = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  const normalized = normalize(decoded).replaceAll("\\", "/");

  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.length > 160
  ) {
    return null;
  }

  return normalized;
}

function normalizeFiles(input) {
  const source = input && typeof input === "object" ? input : {};
  const rawFiles = source.files && typeof source.files === "object" ? source.files : source;
  const files = {};

  for (const [path, content] of Object.entries(rawFiles)) {
    const normalized = normalizeAppPath(path);
    if (!normalized || typeof content !== "string" || content.length > maxBodySize) {
      continue;
    }
    files[normalized] = content;
  }

  if (!Object.keys(files).length && "html" in source) {
    files["index.html"] = String(source.html || "");
    files["style.css"] = String(source.css || "");
    files["script.js"] = String(source.js || "");
  }

  return Object.keys(files).length ? files : { ...defaultFiles };
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, status, html) {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

function responseType(path) {
  return contentTypes.get(extname(path)) || "application/octet-stream";
}

function appRequestPath(pathname, slug) {
  const prefix = `/p/${slug}`;
  const relative = pathname.slice(prefix.length).replace(/^\/+/, "");
  const normalized = normalizeAppPath(relative || "index.html");
  if (!normalized) {
    return null;
  }
  return normalized.endsWith("/") ? `${normalized}index.html` : normalized;
}

function appCandidates(pathname, slug) {
  const requested = appRequestPath(pathname, slug);
  if (!requested) {
    return [];
  }
  return extname(requested) ? [requested] : [requested, `${requested}/index.html`];
}

async function readBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodySize) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function readApp(slug) {
  if (!isSlug(slug)) {
    return null;
  }

  try {
    const saved = JSON.parse(await readFile(appFilePath(slug), "utf8"));
    const files = saved.files ? normalizeFiles(saved.files) : normalizeFiles(saved);
    return {
      files,
      updatedAt: saved.updatedAt || null,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { files: { ...defaultFiles }, updatedAt: null };
    }
    throw error;
  }
}

async function saveApp(slug, payload) {
  await mkdir(dataRoot, { recursive: true });
  const saved = {
    files: normalizeFiles(payload),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(appFilePath(slug), JSON.stringify(saved, null, 2));
  return saved;
}

function publicPath(pathname) {
  const decoded = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const safePath = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  return join(publicRoot, safePath);
}

async function servePublic(pathname, response) {
  const requested = publicPath(pathname);
  const candidates = [requested, join(requested, "index.html"), join(publicRoot, "index.html")];

  for (const candidate of candidates) {
    if (!candidate.startsWith(publicRoot) || !existsSync(candidate)) {
      continue;
    }

    const details = await stat(candidate);
    if (!details.isFile()) {
      continue;
    }

    response.writeHead(200, {
      "Content-Type": contentTypes.get(extname(candidate)) || "application/octet-stream",
    });
    createReadStream(candidate).pipe(response);
    return;
  }

  response.writeHead(404).end("Not found");
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const apiMatch = url.pathname.match(/^\/api\/apps\/([a-z0-9-]+)$/);
    const appMatch = url.pathname.match(/^\/p\/([a-z0-9-]+)(?:\/.*)?$/);

    if (apiMatch) {
      const slug = apiMatch[1];
      if (!isSlug(slug)) {
        sendJson(response, 400, { error: "Use 3-40 lowercase letters, numbers, or hyphens." });
        return;
      }

      if (request.method === "GET") {
        sendJson(response, 200, await readApp(slug));
        return;
      }

      if (request.method === "PUT") {
        const files = JSON.parse(await readBody(request));
        const saved = await saveApp(slug, files);
        sendJson(response, 200, { ok: true, url: `/p/${slug}/`, updatedAt: saved.updatedAt });
        return;
      }

      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    if (appMatch && request.method === "GET") {
      const app = await readApp(appMatch[1]);
      if (!app) {
        sendHtml(response, 404, "Not found");
        return;
      }

      for (const candidate of appCandidates(url.pathname, appMatch[1])) {
        if (candidate in app.files) {
          response.writeHead(200, { "Content-Type": responseType(candidate) });
          response.end(app.files[candidate]);
          return;
        }
      }

      response.writeHead(404).end("Not found");
      return;
    }

    await servePublic(url.pathname, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "Internal server error" });
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`Disco Playground listening on http://localhost:${port}`);
});
