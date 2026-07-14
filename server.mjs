import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const port = Number(process.env.PORT || 8080);
const publicRoot = resolve("public");
const dataRoot = resolve(process.env.PLAYGROUND_DATA_DIR || ".data");
const maxBodySize = 20 * 1024 * 1024;
const maxFileSize = 5 * 1024 * 1024;
const textExtensions = new Set([".css", ".csv", ".html", ".js", ".json", ".md", ".mjs", ".svg", ".txt", ".xml"]);

const defaultProject = {
  files: {
  "index.html": `<!doctype html>
<h1>Hello, RC</h1>`,
  },
  updatedAt: null,
  updatedBy: null,
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

function currentFilePath() {
  return join(dataRoot, "current.json");
}

function historyRoot() {
  return join(dataRoot, "history");
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
    if (!normalized) {
      continue;
    }

    if (typeof content === "string" && content.length <= maxFileSize) {
      files[normalized] = content;
      continue;
    }

    if (
      content &&
      typeof content === "object" &&
      content.encoding === "base64" &&
      typeof content.content === "string" &&
      Buffer.byteLength(content.content, "base64") <= maxFileSize
    ) {
      files[normalized] = {
        encoding: "base64",
        content: content.content,
      };
    }
  }

  if (!Object.keys(files).length && "html" in source) {
    files["index.html"] = String(source.html || "");
    files["style.css"] = String(source.css || "");
    files["script.js"] = String(source.js || "");
  }

  return Object.keys(files).length ? files : { ...defaultProject.files };
}

function stripCommonRoot(paths) {
  if (!paths.length || paths.some((path) => !path.includes("/"))) {
    return paths;
  }

  const firstSegments = paths.map((path) => path.split("/")[0]);
  if (!firstSegments.every((segment) => segment === firstSegments[0])) {
    return paths;
  }

  return paths.map((path) => path.split("/").slice(1).join("/")).filter(Boolean);
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

function isTextPath(path) {
  return textExtensions.has(extname(path).toLowerCase());
}

function fileResponseBody(file) {
  if (typeof file === "string") {
    return file;
  }

  if (file && typeof file === "object" && file.encoding === "base64") {
    return Buffer.from(file.content, "base64");
  }

  return "";
}

function projectRequestPath(pathname) {
  const relative = pathname.replace(/^\/+/, "");
  const normalized = normalizeAppPath(relative || "index.html");
  if (!normalized) {
    return null;
  }
  return normalized.endsWith("/") ? `${normalized}index.html` : normalized;
}

function projectCandidates(pathname) {
  const requested = projectRequestPath(pathname);
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

async function importManifest(rawUrl) {
  const manifestUrl = new URL(rawUrl);
  if (manifestUrl.protocol !== "https:" || manifestUrl.hostname !== "raw.githubusercontent.com") {
    throw new Error("Use a raw.githubusercontent.com manifest URL.");
  }

  const manifestResponse = await fetch(manifestUrl, {
    headers: { "User-Agent": "disco-playground" },
  });
  if (!manifestResponse.ok) {
    throw new Error(`Manifest download failed with ${manifestResponse.status}`);
  }

  const manifest = await manifestResponse.json();
  const paths = Array.isArray(manifest.files) ? manifest.files : [];
  const baseUrl = new URL(".", manifestUrl);
  const files = {};

  for (const rawPath of paths) {
    const path = normalizeAppPath(rawPath);
    if (!path) {
      continue;
    }

    const fileUrl = new URL(encodeURI(path), baseUrl);
    const fileResponse = await fetch(fileUrl, {
      headers: { "User-Agent": "disco-playground" },
    });
    if (!fileResponse.ok) {
      continue;
    }

    const bytes = new Uint8Array(await fileResponse.arrayBuffer());
    if (bytes.byteLength > maxFileSize) {
      continue;
    }

    if (isTextPath(path)) {
      files[path] = new TextDecoder().decode(bytes);
    } else {
      files[path] = {
        encoding: "base64",
        content: Buffer.from(bytes).toString("base64"),
      };
    }
  }

  const saved = await saveProject({ files });
  return {
    files: Object.keys(saved.files).sort(),
    updatedAt: saved.updatedAt,
  };
}

async function readProject() {
  try {
    const saved = JSON.parse(await readFile(currentFilePath(), "utf8"));
    const files = saved.files ? normalizeFiles(saved.files) : normalizeFiles(saved);
    return {
      files,
      updatedAt: saved.updatedAt || null,
      updatedBy: saved.updatedBy || null,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { ...defaultProject, files: { ...defaultProject.files } };
    }
    throw error;
  }
}

async function saveProject(payload) {
  await mkdir(dataRoot, { recursive: true });
  const saved = {
    files: normalizeFiles(payload),
    updatedAt: new Date().toISOString(),
    updatedBy: "local",
  };
  await writeFile(currentFilePath(), JSON.stringify(saved, null, 2));
  await writeRevision(saved);
  return saved;
}

async function writeRevision(saved) {
  const root = historyRoot();
  await mkdir(root, { recursive: true });
  const stamp = saved.updatedAt.replaceAll(":", "-");
  await writeFile(join(root, `${stamp}.json`), JSON.stringify(saved, null, 2));
}

async function readHistory() {
  try {
    const names = (await readdir(historyRoot())).filter((name) => name.endsWith(".json")).sort().reverse();
    return Promise.all(
      names.slice(0, 20).map(async (name) => {
        const saved = JSON.parse(await readFile(join(historyRoot(), name), "utf8"));
        return {
          id: name.replace(/\.json$/, ""),
          updatedAt: saved.updatedAt || null,
          updatedBy: saved.updatedBy || null,
          files: Object.keys(normalizeFiles(saved.files || saved)).sort(),
        };
      }),
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function publicPath(pathname) {
  const decoded = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const safePath = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  return join(publicRoot, safePath);
}

async function servePublic(pathname, response) {
  const assetPathname = pathname === "/edit" ? "/edit.html" : pathname;
  const requested = publicPath(assetPathname);
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

    if (url.pathname === "/api/files") {
      if (request.method === "GET") {
        sendJson(response, 200, await readProject());
        return;
      }

      if (request.method === "PUT") {
        const files = JSON.parse(await readBody(request));
        const saved = await saveProject(files);
        sendJson(response, 200, { ok: true, url: "/", updatedAt: saved.updatedAt });
        return;
      }

      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    if (url.pathname === "/api/history") {
      if (request.method === "GET") {
        sendJson(response, 200, { revisions: await readHistory() });
        return;
      }

      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    if (url.pathname === "/api/import-manifest") {
      if (request.method === "POST") {
        const body = JSON.parse(await readBody(request));
        const imported = await importManifest(body.url);
        sendJson(response, 200, { ok: true, ...imported });
        return;
      }

      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    if (url.pathname === "/edit" || url.pathname.startsWith("/styles.css") || url.pathname.startsWith("/app.js")) {
      await servePublic(url.pathname, response);
      return;
    }

    if (request.method === "GET") {
      const project = await readProject();
      for (const candidate of projectCandidates(url.pathname)) {
        if (candidate in project.files) {
          response.writeHead(200, { "Content-Type": responseType(candidate) });
          response.end(fileResponseBody(project.files[candidate]));
          return;
        }
      }
    }

    response.writeHead(404).end("Not found");
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: error.message || "Internal server error" });
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`Disco Playground listening on http://localhost:${port}`);
});
