import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const port = Number(process.env.PORT || 8080);
const publicRoot = resolve("public");
const dataRoot = resolve(process.env.PLAYGROUND_DATA_DIR || ".data");
const maxBodySize = 512 * 1024;

const defaultFiles = {
  html: `<main>
  <p class="kicker">hello from the playground</p>
  <h1>Build something small and strange.</h1>
  <p>Change the code, save it, then share the live URL with another Recurser.</p>
  <button id="spark">Make it sparkle</button>
</main>`,
  css: `body {
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
  js: `document.querySelector("#spark")?.addEventListener("click", () => {
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
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
]);

function isSlug(value) {
  return /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(value);
}

function appFilePath(slug) {
  return join(dataRoot, `${slug}.json`);
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, status, html) {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

function escapeScript(value) {
  return value.replaceAll("</script", "<\\/script");
}

function renderApp(files) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>${files.css}</style>
  </head>
  <body>
    ${files.html}
    <script>${escapeScript(files.js)}</script>
  </body>
</html>`;
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
    return {
      html: typeof saved.html === "string" ? saved.html : defaultFiles.html,
      css: typeof saved.css === "string" ? saved.css : defaultFiles.css,
      js: typeof saved.js === "string" ? saved.js : defaultFiles.js,
      updatedAt: saved.updatedAt || null,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { ...defaultFiles, updatedAt: null };
    }
    throw error;
  }
}

async function saveApp(slug, files) {
  await mkdir(dataRoot, { recursive: true });
  const payload = {
    html: String(files.html || ""),
    css: String(files.css || ""),
    js: String(files.js || ""),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(appFilePath(slug), JSON.stringify(payload, null, 2));
  return payload;
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
    const appMatch = url.pathname.match(/^\/p\/([a-z0-9-]+)\/?$/);

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
      const files = await readApp(appMatch[1]);
      if (!files) {
        sendHtml(response, 404, "Not found");
        return;
      }
      sendHtml(response, 200, renderApp(files));
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
