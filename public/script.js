// ========== ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ==========
let socket = null;
let username = "";
let currentFile = "";

// ========== АВТОРИЗАЦИЯ ==========
async function checkAuth() {
  try {
    const res = await fetch("/api/check-auth");
    const data = await res.json();

    if (!data.authenticated) {
      window.location.href = "/login";
      return;
    }

    username = data.username;

    document.getElementById("userInfo").innerHTML = `
            <div class="user-badge">
                <span>👤 ${data.username}</span>
                ${
                  data.role === "admin"
                    ? '<span class="admin-label">admin</span>'
                    : ""
                }
            </div>
        `;

    if (data.role === "admin") {
      document.getElementById("adminBtn").style.display = "block";
    }

    // Подключаем WebSocket
    connectWebSocket();

    // Загружаем статус
    updateStatus();
    loadFiles();
    loadVersions();

    setInterval(updateStatus, 5000);
  } catch (error) {
    console.error("Ошибка проверки авторизации:", error);
  }
}

// ========== WEBSOCKET ==========
function connectWebSocket() {
  socket = io({
    auth: { username: username },
  });

  socket.on("connect", () => {
    console.log("✅ WebSocket подключен");
  });

  socket.on("log", (data) => {
    const consoleDiv = document.getElementById("console");
    consoleDiv.innerHTML += data + "<br>";
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
  });

  socket.on("error", (error) => {
    console.error("Ошибка WebSocket:", error);
  });

  socket.on("disconnect", () => {
    console.log("❌ WebSocket отключен");
    setTimeout(connectWebSocket, 3000);
  });
}

function sendCommand() {
  const input = document.getElementById("commandInput");
  if (!input.value) return;

  if (socket) {
    socket.emit("command", input.value);
    input.value = "";
  }
}

// ========== УПРАВЛЕНИЕ СЕРВЕРОМ ==========
async function createServer() {
  try {
    const res = await fetch("/api/server/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ software: "paper", version: "latest" }),
    });

    const data = await res.json();

    if (data.success) {
      alert(`✅ Сервер создан! Порт: ${data.port}`);
      updateStatus();
    } else {
      alert("❌ " + data.error);
    }
  } catch (error) {
    alert("❌ Ошибка создания сервера");
  }
}

async function startServer() {
  try {
    const res = await fetch("/api/server/start", { method: "POST" });
    const data = await res.json();

    if (data.success) {
      updateStatus();

      // Если это демо-режим — показываем предупреждение
      if (data.demo) {
        const consoleDiv = document.getElementById("console");
        consoleDiv.innerHTML += "⚠️ " + data.message + "<br>";
        consoleDiv.scrollTop = consoleDiv.scrollHeight;
      }
    } else {
      alert("❌ " + data.error);
    }
  } catch (error) {
    alert("❌ Ошибка запуска");
  }
}

async function stopServer() {
  try {
    const res = await fetch("/api/server/stop", { method: "POST" });
    const data = await res.json();
    if (data.success) {
      updateStatus();
    } else {
      alert("❌ " + data.error);
    }
  } catch (error) {
    alert("❌ Ошибка остановки");
  }
}

async function restartServer() {
  try {
    const res = await fetch("/api/server/restart", { method: "POST" });
    const data = await res.json();
    if (data.success) {
      updateStatus();
    } else {
      alert("❌ " + data.error);
    }
  } catch (error) {
    alert("❌ Ошибка перезапуска");
  }
}

async function updateStatus() {
  try {
    const res = await fetch("/api/server/status");
    const data = await res.json();

    const statusSpan = document.getElementById("status");
    const portSpan = document.getElementById("portInfo");
    const createBtn = document.getElementById("createBtn");

    if (data.exists) {
      statusSpan.textContent =
        data.status === "running" ? "🟢 Запущен" : "🔴 Остановлен";
      portSpan.textContent = `📡 Порт: ${data.port}`;
      createBtn.style.display = "none";
    } else {
      statusSpan.textContent = "⚪ Сервер не создан";
      portSpan.textContent = "";
      createBtn.style.display = "inline-block";
    }
  } catch (error) {
    console.error("Ошибка получения статуса:", error);
  }
}

// ========== ФАЙЛЫ ==========
async function loadFiles() {
  try {
    const res = await fetch("/api/files");
    const files = await res.json();

    const list = document.getElementById("fileList");
    list.innerHTML = files
      .map(
        (file) => `
            <li class="file-item" onclick="loadFile('${file.name}')">
                ${file.isDirectory ? "📁" : "📄"} ${file.name}
            </li>
        `
      )
      .join("");
  } catch (error) {
    console.error("Ошибка загрузки файлов:", error);
  }
}

async function loadFile(filename) {
  try {
    const res = await fetch(`/api/file/${filename}`);
    const content = await res.text();

    document.getElementById("currentFileName").textContent = filename;
    document.getElementById("fileContent").value = content;
    document.getElementById("fileContent").readOnly = false;
    document.getElementById("saveBtn").style.display = "inline-block";
    currentFile = filename;
  } catch (error) {
    alert("❌ Ошибка загрузки файла");
  }
}

async function saveFile() {
  if (!currentFile) return;

  const content = document.getElementById("fileContent").value;

  try {
    const res = await fetch(`/api/file/${currentFile}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });

    if (res.ok) {
      alert("✅ Файл сохранен");
    } else {
      alert("❌ Ошибка сохранения");
    }
  } catch (error) {
    alert("❌ Ошибка сохранения");
  }
}

// ========== ПОИСК ПЛАГИНОВ ==========
let searchTimeout;

function searchPlugins() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(async () => {
    const query = document.getElementById("pluginSearch").value.trim();
    const container = document.getElementById("pluginResults");

    if (query.length < 3) {
      container.innerHTML =
        '<p style="color: #6b7280;">Введите минимум 3 символа для поиска</p>';
      return;
    }

    container.innerHTML = "<p>🔍 Поиск плагинов...</p>";

    try {
      const res = await fetch(
        `/api/plugins/search?q=${encodeURIComponent(query)}`
      );

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Ошибка сервера");
      }

      const data = await res.json();

      if (data.error) {
        container.innerHTML = `<p style="color: #f87171;">❌ ${data.error}</p>`;
        return;
      }

      if (!data || data.length === 0) {
        container.innerHTML = "<p>😕 Ничего не найдено</p>";
        return;
      }

      container.innerHTML = data
        .map(
          (p) => `
                <div class="plugin-card">
                    <div class="plugin-info">
                        <h3>${p.title}</h3>
                        <p>${p.description || "Нет описания"}</p>
                        <div class="plugin-meta">
                            <span>👤 ${p.author || "Неизвестен"}</span>
                            <span>⬇️ ${(
                              p.downloads || 0
                            ).toLocaleString()}</span>
                        </div>
                        <div class="plugin-versions">
                            <strong>Версии:</strong> ${
                              p.versions && p.versions.length > 0
                                ? p.versions.slice(0, 3).join(", ") +
                                  (p.versions.length > 3 ? "..." : "")
                                : "Не указано"
                            }
                        </div>
                    </div>
                </div>
            `
        )
        .join("");
    } catch (error) {
      console.error("Ошибка поиска плагинов:", error);
      container.innerHTML =
        '<p style="color: #f87171;">❌ Ошибка при поиске плагинов. Попробуйте позже.</p>';
    }
  }, 500);
}

// ========== PAPER VERSIONS ==========
async function loadVersions() {
  const select = document.getElementById("versionSelect");
  if (!select) return;

  select.innerHTML = "<option>⏳ Загрузка версий...</option>";

  try {
    const res = await fetch("/api/paper-versions");
    if (!res.ok) throw new Error("Ошибка сервера");

    const versions = await res.json();

    if (!versions || versions.length === 0) {
      select.innerHTML = "<option>❌ Версии не найдены</option>";
      return;
    }

    select.innerHTML = versions
      .map((v) => `<option value="${v}">📦 Paper ${v}</option>`)
      .join("");

    console.log(`✅ Загружено ${versions.length} версий Paper`);
  } catch (error) {
    console.error("Ошибка загрузки версий:", error);
    const fallback = ["1.21.4", "1.20.4", "1.20.2"];
    select.innerHTML = fallback
      .map((v) => `<option value="${v}">📦 Paper ${v}</option>`)
      .join("");
  }
}

async function downloadPaper() {
  const version = document.getElementById("versionSelect").value;
  const msg = document.getElementById("coreMessage");

  msg.textContent = "⏳ Скачивание...";
  msg.style.color = "#b5b9ff";

  try {
    const res = await fetch("/api/download-paper", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version }),
    });

    const text = await res.text();
    msg.textContent = text;
    msg.style.color = text.includes("✅") ? "#4ade80" : "#f87171";
  } catch (error) {
    msg.textContent = "❌ Ошибка скачивания";
    msg.style.color = "#f87171";
  }
}

// ========== ВЫХОД ==========
async function logout() {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login";
}

// ========== ВКЛАДКИ ==========
function showTab(tab) {
  document
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.remove("active"));
  document.getElementById(tab + "Tab").classList.add("active");
}

// ========== ЗАГРУЗКА ==========
document.addEventListener("DOMContentLoaded", checkAuth);

// Обработка формы загрузки ZIP
document.getElementById("uploadForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const formData = new FormData(e.target);

  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });

    if (res.ok) {
      alert("✅ ZIP загружен и распакован");
      loadFiles();
    } else {
      alert("❌ Ошибка загрузки");
    }
  } catch (error) {
    alert("❌ Ошибка загрузки");
  }
});
