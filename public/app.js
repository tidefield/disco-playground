const editor = document.querySelector("#editor");
const preview = document.querySelector("#preview");
const statusLine = document.querySelector("#status");
const fileTree = document.querySelector("#file-tree");
const filePathInput = document.querySelector("#file-path");
const folderUpload = document.querySelector("#folder-upload");
const manifestForm = document.querySelector("#manifest-form");
const manifestUrl = document.querySelector("#manifest-url");

let files = {};
let activeFile = "index.html";
let renderTimer;
let saveTimer;
let lastSavedPayload = "";
let isLoading = false;
const collapsedFolders = new Set();

const defaultFiles = {
  "index.html": `<!doctype html>
<h1>Hello, RC</h1>`,
};

const textExtensions = new Set([
  ".css",
  ".csv",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".svg",
  ".txt",
  ".xml",
]);

const contentTypes = new Map([
  [".css", "text/css"],
  [".gif", "image/gif"],
  [".html", "text/html"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript"],
  [".json", "application/json"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
  [".xml", "application/xml"],
]);

function setStatus(message) {
  statusLine.textContent = message;
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

function extension(path) {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot).toLowerCase();
}

function contentType(path) {
  return contentTypes.get(extension(path)) || "application/octet-stream";
}

function isBinaryFile(fileRecord) {
  return fileRecord && typeof fileRecord === "object" && fileRecord.encoding === "base64";
}

function fileText(path) {
  return typeof files[path] === "string" ? files[path] : "";
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
    button.textContent = `${isBinaryFile(files[file.path]) ? "* " : ""}${file.name}`;
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
  if (!fileText("index.html")) {
    preview.removeAttribute("src");
    preview.srcdoc = "<!doctype html><p>Add an index.html file to preview this app.</p>";
    return;
  }

  preview.removeAttribute("srcdoc");
  preview.src = `/?preview=${Date.now()}`;
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
  if (!isBinaryFile(files[activeFile])) {
    files[activeFile] = editor.value;
  }
}

function selectFile(file) {
  captureEditor();
  queueSave();
  activeFile = file;
  if (isBinaryFile(files[file])) {
    editor.value = `[binary file]\n${file}`;
    editor.readOnly = true;
  } else {
    editor.value = fileText(file);
    editor.readOnly = false;
  }
  refreshFileTree();
  editor.focus();
}

async function loadApp() {
  isLoading = true;
  setStatus("Loading...");
  const response = await fetch("/api/files");
  if (!response.ok) {
    isLoading = false;
    setStatus("Could not load");
    return;
  }

  const nextApp = await response.json();
  files = nextApp.files || { ...defaultFiles };
  activeFile = files[activeFile] ? activeFile : sortedPaths()[0] || "index.html";
  editor.value = isBinaryFile(files[activeFile]) ? `[binary file]\n${activeFile}` : fileText(activeFile);
  editor.readOnly = isBinaryFile(files[activeFile]);
  refreshFileTree();
  render();
  lastSavedPayload = JSON.stringify({ files });
  isLoading = false;
  setStatus("Loaded shared playground");
}

async function saveApp() {
  captureEditor();
  const payload = JSON.stringify({ files });
  if (payload === lastSavedPayload) {
    setStatus("Saved");
    return;
  }

  setStatus("Saving...");

  const response = await fetch("/api/files", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });

  if (!response.ok) {
    setStatus("Could not save");
    return;
  }

  lastSavedPayload = payload;
  setStatus("Saved");
  render();
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

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = String(reader.result || "");
      resolve(result.slice(result.indexOf(",") + 1));
    });
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsText(file);
  });
}

async function uploadFolder() {
  const selected = Array.from(folderUpload.files || []);
  folderUpload.value = "";
  if (!selected.length) {
    return;
  }

  if (!window.confirm(`Replace the shared playground with ${selected.length} uploaded files?`)) {
    return;
  }

  setStatus("Reading upload...");
  const rawPaths = selected.map((file) => file.webkitRelativePath || file.name);
  const strippedPaths = stripCommonRoot(rawPaths).map(normalizePath);
  const nextFiles = {};

  for (const [index, file] of selected.entries()) {
    const path = strippedPaths[index];
    if (!path || file.size > 5 * 1024 * 1024) {
      continue;
    }

    if (textExtensions.has(extension(path))) {
      nextFiles[path] = await readFileAsText(file);
    } else {
      nextFiles[path] = {
        encoding: "base64",
        content: await readFileAsBase64(file),
      };
    }
  }

  files = Object.keys(nextFiles).length ? nextFiles : { ...defaultFiles };
  activeFile = files["index.html"] ? "index.html" : sortedPaths()[0];
  editor.value = isBinaryFile(files[activeFile]) ? `[binary file]\n${activeFile}` : fileText(activeFile);
  editor.readOnly = isBinaryFile(files[activeFile]);
  refreshFileTree();
  render();
  queueSave(100);
}

async function importManifest(event) {
  event.preventDefault();
  const url = manifestUrl.value.trim();
  if (!url) {
    return;
  }

  if (!window.confirm("Replace the shared playground with this manifest?")) {
    return;
  }

  setStatus("Pulling manifest...");
  const response = await fetch("/api/import-manifest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    setStatus(details.error || "Could not import manifest");
    return;
  }

  await loadApp();
  setStatus("Imported manifest");
}

function resetPlayground() {
  if (!window.confirm("Remove everything in the playground and reset to the default page?")) {
    return;
  }

  files = { ...defaultFiles };
  activeFile = "index.html";
  editor.value = fileText(activeFile);
  editor.readOnly = false;
  collapsedFolders.clear();
  refreshFileTree();
  render();
  queueSave(100);
  setStatus("Trashed playground");
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

filePathInput.addEventListener("change", renameFile);
document.querySelector("#new-file").addEventListener("click", addFile);
document.querySelector("#delete-file").addEventListener("click", deleteFile);
document.querySelector("#upload-folder").addEventListener("click", () => folderUpload.click());
document.querySelector("#trash-files").addEventListener("click", resetPlayground);
folderUpload.addEventListener("change", uploadFolder);
manifestForm.addEventListener("submit", importManifest);

loadApp();
