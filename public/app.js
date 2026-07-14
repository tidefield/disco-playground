const slugInput = document.querySelector("#slug");
const editor = document.querySelector("#editor");
const preview = document.querySelector("#preview");
const statusLine = document.querySelector("#status");
const openLink = document.querySelector("#open");
const tabs = Array.from(document.querySelectorAll(".tab"));

const files = { html: "", css: "", js: "" };
let activeFile = "html";
let renderTimer;

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
  openLink.href = `/p/${slug}/`;
  return slug;
}

function render() {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${files.css}</style>
</head>
<body>
  ${files.html}
  <script>${files.js.replaceAll("</script", "<\\/script")}<\/script>
</body>
</html>`;
  preview.srcdoc = html;
}

function queueRender() {
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(render, 120);
}

function selectFile(file) {
  files[activeFile] = editor.value;
  activeFile = file;
  editor.value = files[file];
  tabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.file === file);
  });
  editor.focus();
}

async function loadApp() {
  const slug = currentSlug();
  setStatus("Loading...");
  const response = await fetch(`/api/apps/${slug}`);
  if (!response.ok) {
    setStatus("Could not load");
    return;
  }

  const nextFiles = await response.json();
  files.html = nextFiles.html || "";
  files.css = nextFiles.css || "";
  files.js = nextFiles.js || "";
  editor.value = files[activeFile];
  render();
  setStatus(`Loaded /p/${slug}/`);
}

async function saveApp() {
  const slug = currentSlug();
  files[activeFile] = editor.value;
  setStatus("Saving...");

  const response = await fetch(`/api/apps/${slug}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(files),
  });

  if (!response.ok) {
    setStatus("Could not save");
    return;
  }

  setStatus(`Saved /p/${slug}/`);
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => selectFile(tab.dataset.file));
});

editor.addEventListener("input", () => {
  files[activeFile] = editor.value;
  queueRender();
});

editor.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.value = `${editor.value.slice(0, start)}  ${editor.value.slice(end)}`;
    editor.selectionStart = start + 2;
    editor.selectionEnd = start + 2;
    files[activeFile] = editor.value;
    queueRender();
  }
});

slugInput.addEventListener("input", currentSlug);
document.querySelector("#load").addEventListener("click", loadApp);
document.querySelector("#save").addEventListener("click", saveApp);

loadApp();
