const slugInput = document.querySelector("#slug");
const editor = document.querySelector("#editor");
const preview = document.querySelector("#preview");
const statusLine = document.querySelector("#status");
const fileTree = document.querySelector("#file-tree");
const filePathInput = document.querySelector("#file-path");

let files = {};
let activeFile = "index.html";
let renderTimer;
let saveTimer;
let lastSavedPayload = "";
let isLoading = false;
const collapsedFolders = new Set();

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

function cleanSlug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function setStatus(message) {
  statusLine.textContent = message;
}

function currentSlug() {
  const slug = cleanSlug(slugInput.value || "hello-rc");
  slugInput.value = slug;
  return slug;
}

function normalizePath(value) {
  return value
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/(^|\/)\.\//g, "$1")
    .replaceAll("../", "")
    .trim();
}

function sortedPaths() {
  return Object.keys(files).sort((a, b) => a.localeCompare(b));
}

function buildTree() {
  const root = { folders: new Map(), files: [] };
  for (const path of sortedPaths()) {
    const parts = path.split("/");
    let node = root;
    for (const folder of parts.slice(0, -1)) {
      if (!node.folders.has(folder)) {
        node.folders.set(folder, { folders: new Map(), files: [] });
      }
      node = node.folders.get(folder);
    }
    node.files.push({ name: parts.at(-1), path });
  }
  return root;
}

function renderTreeNode(node, parentPath = "", depth = 0) {
  const fragment = document.createDocumentFragment();
  const folderNames = Array.from(node.folders.keys()).sort((a, b) => a.localeCompare(b));

  for (const name of folderNames) {
    const path = parentPath ? `${parentPath}/${name}` : name;
    const folder = node.folders.get(name);
    const isCollapsed = collapsedFolders.has(path);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tree-row folder";
    button.style.setProperty("--indent", `${depth * 14}px`);
    button.textContent = `${isCollapsed ? ">" : "v"} ${name}`;
    button.addEventListener("click", () => {
      if (isCollapsed) {
        collapsedFolders.delete(path);
      } else {
        collapsedFolders.add(path);
      }
      refreshFileTree();
    });
    fragment.append(button);

    if (!isCollapsed) {
      fragment.append(renderTreeNode(folder, path, depth + 1));
    }
  }

  for (const file of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tree-row file${file.path === activeFile ? " active" : ""}`;
    button.style.setProperty("--indent", `${depth * 14}px`);
    button.textContent = file.name;
    button.title = file.path;
    button.addEventListener("click", () => selectFile(file.path));
    fragment.append(button);
  }

  return fragment;
}

function refreshFileTree() {
  fileTree.replaceChildren(renderTreeNode(buildTree()));
  filePathInput.value = activeFile;
}

function render() {
  const html = files["index.html"];
  if (!html) {
    preview.srcdoc = "<!doctype html><p>Add an index.html file to preview this app.</p>";
    return;
  }

  const blobUrls = [];
  const previewHtml = html.replace(
    /(src|href)=["']\/?([^"':?#]+)["']/g,
    (match, attr, path) => {
      const normalized = normalizePath(path);
      if (!(normalized in files)) {
        return match;
      }

      const type = normalized.endsWith(".css")
        ? "text/css"
        : normalized.endsWith(".js")
          ? "text/javascript"
          : "text/plain";
      const blobUrl = URL.createObjectURL(new Blob([files[normalized]], { type }));
      blobUrls.push(blobUrl);
      return `${attr}="${blobUrl}"`;
    },
  );

  preview.srcdoc = previewHtml;
  window.setTimeout(() => blobUrls.forEach((url) => URL.revokeObjectURL(url)), 1000);
}

function queueRender() {
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(render, 120);
}

function queueSave(delay = 700) {
  if (isLoading) {
    return;
  }

  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveApp, delay);
}

function captureEditor() {
  files[activeFile] = editor.value;
}

function selectFile(file) {
  captureEditor();
  queueSave();
  activeFile = file;
  editor.value = files[file];
  refreshFileTree();
  editor.focus();
}

async function loadApp() {
  const slug = currentSlug();
  isLoading = true;
  setStatus("Loading...");
  const response = await fetch(`/api/apps/${slug}`);
  if (!response.ok) {
    isLoading = false;
    setStatus("Could not load");
    return;
  }

  const nextApp = await response.json();
  files = nextApp.files || { ...defaultFiles };
  activeFile = files[activeFile] ? activeFile : sortedPaths()[0] || "index.html";
  editor.value = files[activeFile];
  refreshFileTree();
  render();
  lastSavedPayload = JSON.stringify({ files });
  isLoading = false;
  setStatus(`Loaded /p/${slug}/`);
}

async function saveApp() {
  const slug = currentSlug();
  captureEditor();
  const payload = JSON.stringify({ files });
  if (payload === lastSavedPayload) {
    setStatus(`Saved /p/${slug}/`);
    return;
  }

  setStatus("Saving...");

  const response = await fetch(`/api/apps/${slug}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });

  if (!response.ok) {
    setStatus("Could not save");
    return;
  }

  lastSavedPayload = payload;
  setStatus(`Saved /p/${slug}/`);
}

function addFile() {
  const path = normalizePath(window.prompt("File path", "pages/about/index.html") || "");
  if (!path) {
    return;
  }

  captureEditor();
  if (!(path in files)) {
    files[path] = "";
  }
  selectFile(path);
  queueRender();
  queueSave(100);
}

function renameFile() {
  const nextPath = normalizePath(filePathInput.value);
  if (!nextPath || nextPath === activeFile) {
    filePathInput.value = activeFile;
    return;
  }

  captureEditor();
  if (nextPath in files && !window.confirm(`${nextPath} already exists. Replace it?`)) {
    filePathInput.value = activeFile;
    return;
  }

  files[nextPath] = files[activeFile];
  delete files[activeFile];
  activeFile = nextPath;
  refreshFileTree();
  queueRender();
  queueSave(100);
}

function deleteFile() {
  if (sortedPaths().length === 1) {
    setStatus("Keep at least one file");
    return;
  }

  if (!window.confirm(`Delete ${activeFile}?`)) {
    return;
  }

  delete files[activeFile];
  activeFile = sortedPaths()[0];
  editor.value = files[activeFile];
  refreshFileTree();
  queueRender();
  queueSave(100);
}

editor.addEventListener("input", () => {
  captureEditor();
  queueRender();
  queueSave();
});

editor.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.value = `${editor.value.slice(0, start)}  ${editor.value.slice(end)}`;
    editor.selectionStart = start + 2;
    editor.selectionEnd = start + 2;
    captureEditor();
    queueRender();
    queueSave();
  }
});

slugInput.addEventListener("change", loadApp);
slugInput.addEventListener("input", () => {
  currentSlug();
  setStatus(`Editing /p/${slugInput.value}/`);
});
filePathInput.addEventListener("change", renameFile);
document.querySelector("#new-file").addEventListener("click", addFile);
document.querySelector("#delete-file").addEventListener("click", deleteFile);

loadApp();
