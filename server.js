const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const Database = require("better-sqlite3");
const multer = require("multer");
const unzipper = require("unzipper");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { spawn } = require("child_process");
const { Server } = require("socket.io");
const http = require("http");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ========== НАСТРОЙКИ ==========
const PORT = 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
const USERS_DIR = path.join(__dirname, "users");

// Создаем папки
[UPLOAD_DIR, USERS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ========== ЗАГРУЗКА ВЕРСИЙ PAPER ИЗ JSON ==========
let paperVersions = {};

function loadPaperVersions() {
  try {
    const data = fs.readFileSync(
      path.join(__dirname, "paper_versions.json"),
      "utf8"
    );
    paperVersions = JSON.parse(data);
    console.log(
      `✅ Загружено ${Object.keys(paperVersions.versions).length} версий Paper`
    );
  } catch (error) {
    console.error("❌ Ошибка загрузки paper_versions.json:", error.message);
    // Запасной список на случай ошибки
    paperVersions = {
      latest: "1.21.4",
      versions: {
        "1.21.4":
          "https://fill-data.papermc.io/v1/objects/5ee4f542f628a14c644410b08c94ea42e772ef4d29fe92973636b6813d4eaffc/paper-1.21.4-232.jar",
        "1.20.4":
          "https://fill-data.papermc.io/v1/objects/cabed3ae77cf55deba7c7d8722bc9cfd5e991201c211665f9265616d9fe5c77b/paper-1.20.4-499.jar",
      },
    };
  }
}

// Загружаем при старте
loadPaperVersions();

// ========== БАЗА ДАННЫХ ==========
const db = new Database("mcsv.db");

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        port INTEGER UNIQUE,
        software TEXT DEFAULT 'paper',
        version TEXT DEFAULT 'latest',
        status TEXT DEFAULT 'stopped',
        pid INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
`);

// ========== УПРАВЛЕНИЕ ПРОЦЕССАМИ ==========
const processes = {};

// ========== MIDDLEWARE ==========
app.use(express.json());
app.use(express.static("public"));
app.use(
  session({
    secret: "mcsv-panel-secret-key-2024",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 },
  })
);

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========
function getUser(username) {
  const stmt = db.prepare("SELECT * FROM users WHERE username = ?");
  return stmt.get(username);
}

function getUserId(username) {
  const user = getUser(username);
  return user ? user.id : null;
}

function getServerByUser(username) {
  const user = getUser(username);
  if (!user) return null;
  const stmt = db.prepare("SELECT * FROM servers WHERE user_id = ?");
  return stmt.get(user.id);
}

function generateRandomPort() {
  const stmt = db.prepare("SELECT port FROM servers WHERE port IS NOT NULL");
  const usedPorts = stmt.all().map((r) => r.port);

  let port;
  do {
    port = Math.floor(Math.random() * (50000 - 25565 + 1)) + 25565;
  } while (usedPorts.includes(port));

  return port;
}

function getLogsPath(username) {
  const userDir = path.join(USERS_DIR, username);
  const logsDir = path.join(userDir, "logs");
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  return path.join(logsDir, "server.log");
}

function appendLog(username, text) {
  const logPath = getLogsPath(username);
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${text}\n`;
  fs.appendFileSync(logPath, logLine, "utf8");
}

function getLogs(username, tail = 100) {
  const logPath = getLogsPath(username);
  if (!fs.existsSync(logPath)) {
    return ["Нет логов"];
  }

  try {
    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.split("\n").filter((line) => line.trim());
    return lines.slice(-tail);
  } catch (error) {
    return ["Ошибка чтения логов"];
  }
}

// ========== МИДЛВАРЫ АВТОРИЗАЦИИ ==========
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Не авторизован" });
  }
  const user = getUser(req.session.username);
  if (!user) {
    req.session.destroy();
    return res.status(401).json({ error: "Пользователь не найден" });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== "admin") {
    return res.status(403).json({ error: "Доступ запрещен" });
  }
  next();
}

// ========== СОЗДАНИЕ АДМИНА ==========
async function createAdmin() {
  const admin = getUser("admin");
  if (!admin) {
    const hashedPassword = await bcrypt.hash("admin123", 10);
    const stmt = db.prepare(
      "INSERT INTO users (username, password, role) VALUES (?, ?, ?)"
    );
    stmt.run("admin", hashedPassword, "admin");
    console.log("✅ Админ создан: admin / admin123");
  }
}

// ========== АВТОРИЗАЦИЯ ==========
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Заполните все поля" });
  }

  if (username.length < 3 || password.length < 6) {
    return res
      .status(400)
      .json({ error: "Имя минимум 3 символа, пароль минимум 6" });
  }

  if (username.toLowerCase() === "admin") {
    return res.status(400).json({ error: "Имя admin зарезервировано" });
  }

  if (getUser(username)) {
    return res.status(400).json({ error: "Пользователь уже существует" });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const stmt = db.prepare(
      "INSERT INTO users (username, password) VALUES (?, ?)"
    );
    stmt.run(username, hashedPassword);

    // Создаем папку пользователя
    const userDir = path.join(USERS_DIR, username);
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(path.join(userDir, "server"), { recursive: true });
    fs.mkdirSync(path.join(userDir, "logs"), { recursive: true });

    res.json({ success: true, message: "Регистрация успешна" });
  } catch (error) {
    console.error("Ошибка регистрации:", error);
    res.status(500).json({ error: "Ошибка при регистрации" });
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Заполните все поля" });
  }

  const user = getUser(username);
  if (!user) {
    return res.status(400).json({ error: "Неверное имя или пароль" });
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return res.status(400).json({ error: "Неверное имя или пароль" });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;

  res.json({
    success: true,
    username: user.username,
    role: user.role,
  });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get("/api/check-auth", (req, res) => {
  if (req.session.userId) {
    res.json({
      authenticated: true,
      username: req.session.username,
      role: req.session.role,
    });
  } else {
    res.json({ authenticated: false });
  }
});

// ========== УПРАВЛЕНИЕ СЕРВЕРОМ ==========

app.post("/api/server/create", requireAuth, async (req, res) => {
  const username = req.session.username;
  const { software = "paper", version = "latest" } = req.body;

  const user = getUser(username);
  const existing = getServerByUser(username);

  if (existing) {
    return res.status(400).json({ error: "Сервер уже создан" });
  }

  try {
    const port = generateRandomPort();

    // Сохраняем в базу
    const stmt = db.prepare(`
            INSERT INTO servers (user_id, port, software, version, status)
            VALUES (?, ?, ?, ?, ?)
        `);
    stmt.run(user.id, port, software, version, "created");

    res.json({
      success: true,
      message: "Сервер создан",
      port: port,
    });
  } catch (error) {
    console.error("Ошибка создания сервера:", error);
    res.status(500).json({ error: "Ошибка при создании сервера" });
  }
});

app.post("/api/server/start", requireAuth, async (req, res) => {
  const username = req.session.username;
  const server = getServerByUser(username);

  if (!server) {
    return res.status(404).json({ error: "Сервер не найден" });
  }

  if (processes[username]) {
    return res.status(400).json({ error: "Сервер уже запущен" });
  }

  const serverPath = path.join(USERS_DIR, username, "server");
  const jarPath = path.join(serverPath, "server.jar");

  if (!fs.existsSync(jarPath)) {
    return res
      .status(400)
      .json({ error: "Сначала скачайте ядро (server.jar)" });
  }

  // ===== ПРОВЕРКА НА JAVA =====
  const hasJava = await checkJavaInstalled();

  if (!hasJava) {
    // === ДЕМО-РЕЖИМ: ИМИТИРУЕМ ЗАПУСК ===
    console.log(`🔷 ДЕМО-РЕЖИМ: имитация запуска сервера для ${username}`);

    // Имитируем процесс
    const fakeProcess = {
      pid: Math.floor(Math.random() * 10000),
      stdin: { write: () => {} },
      kill: () => {},
      on: (event, callback) => {
        if (event === "close") {
          // Автоматически "останавливаем" через 30 секунд
          setTimeout(() => {
            callback(0);
          }, 30000);
        }
      },
    };

    processes[username] = fakeProcess;

    const stmt = db.prepare(
      "UPDATE servers SET status = ?, pid = ? WHERE id = ?"
    );
    stmt.run("running", fakeProcess.pid, server.id);

    appendLog(username, "🔷 ДЕМО-РЕЖИМ: Сервер запущен (имитация)");
    appendLog(username, "⚠️ Настоящий запуск невозможен — Java не установлена");

    // Отправляем логи в WebSocket
    io.to(`user-${username}`).emit(
      "log",
      "🔷 ДЕМО-РЕЖИМ: Сервер запущен (имитация)"
    );
    io.to(`user-${username}`).emit(
      "log",
      "⚠️ Настоящий запуск невозможен — Java не установлена"
    );
    io.to(`user-${username}`).emit(
      "log",
      "📝 Это демонстрационный режим для тестирования панели"
    );

    res.json({
      success: true,
      message: "🔷 ДЕМО-РЕЖИМ: Сервер запущен (имитация)",
      demo: true,
    });
    return;
  }

  // === РЕАЛЬНЫЙ ЗАПУСК (если Java есть) ===
  try {
    const propsPath = path.join(serverPath, "server.properties");
    if (!fs.existsSync(propsPath)) {
      fs.writeFileSync(propsPath, `server-port=${server.port}\n`, "utf8");
    }

    const eulaPath = path.join(serverPath, "eula.txt");
    if (!fs.existsSync(eulaPath)) {
      fs.writeFileSync(eulaPath, "eula=true\n", "utf8");
    }

    const process = spawn("java", ["-jar", "server.jar", "nogui"], {
      cwd: serverPath,
      stdio: ["pipe", "pipe", "pipe"],
    });

    processes[username] = process;

    const stmt = db.prepare(
      "UPDATE servers SET status = ?, pid = ? WHERE id = ?"
    );
    stmt.run("running", process.pid, server.id);

    appendLog(username, "🚀 Сервер запущен на порту " + server.port);

    process.stdout.on("data", (data) => {
      const text = data.toString();
      appendLog(username, text);
      io.to(`user-${username}`).emit("log", text);
    });

    process.stderr.on("data", (data) => {
      const text = data.toString();
      appendLog(username, "[ERROR] " + text);
      io.to(`user-${username}`).emit("log", "[ERROR] " + text);
    });

    process.on("close", (code) => {
      delete processes[username];
      const stmt = db.prepare(
        "UPDATE servers SET status = ? WHERE user_id = ?"
      );
      stmt.run("stopped", user.id);
      appendLog(username, `⚠️ Сервер остановлен (код: ${code})`);
      io.to(`user-${username}`).emit("log", "⚠️ Сервер остановлен");
    });

    res.json({ success: true, message: "Сервер запускается" });
  } catch (error) {
    console.error("Ошибка запуска:", error);
    res.status(500).json({ error: "Ошибка при запуске" });
  }
});

// ===== ФУНКЦИЯ ПРОВЕРКИ JAVA =====
async function checkJavaInstalled() {
  return new Promise((resolve) => {
    const check = spawn("java", ["-version"]);

    check.on("error", () => {
      resolve(false);
    });

    check.on("close", (code) => {
      resolve(code === 0);
    });

    // Таймаут на случай зависания
    setTimeout(() => {
      resolve(false);
    }, 3000);
  });
}

app.post("/api/server/stop", requireAuth, (req, res) => {
  const username = req.session.username;

  if (!processes[username]) {
    return res.status(400).json({ error: "Сервер не запущен" });
  }

  try {
    processes[username].stdin.write("stop\n");
    appendLog(username, "⏹️ Команда остановки отправлена");
    res.json({ success: true, message: "Сервер останавливается" });
  } catch (error) {
    console.error("Ошибка остановки:", error);
    res.status(500).json({ error: "Ошибка при остановке" });
  }
});

app.post("/api/server/restart", requireAuth, async (req, res) => {
  const username = req.session.username;

  if (!processes[username]) {
    return res.status(400).json({ error: "Сервер не запущен" });
  }

  try {
    processes[username].stdin.write("stop\n");
    appendLog(username, "🔄 Перезапуск...");

    // Ждем 5 секунд, затем запускаем снова
    setTimeout(async () => {
      try {
        await fetch(`http://localhost:${PORT}/api/server/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        console.error("Ошибка перезапуска:", e);
      }
    }, 5000);

    res.json({ success: true, message: "Сервер перезапускается" });
  } catch (error) {
    console.error("Ошибка перезапуска:", error);
    res.status(500).json({ error: "Ошибка при перезапуске" });
  }
});

app.get("/api/server/status", requireAuth, (req, res) => {
  const username = req.session.username;
  const server = getServerByUser(username);

  if (!server) {
    return res.json({ exists: false });
  }

  const isRunning = !!processes[username];

  // Обновляем статус в БД, если изменился
  if (server.status === "running" && !isRunning) {
    const stmt = db.prepare("UPDATE servers SET status = ? WHERE id = ?");
    stmt.run("stopped", server.id);
  }

  res.json({
    exists: true,
    status: isRunning ? "running" : "stopped",
    port: server.port,
    software: server.software,
    version: server.version,
  });
});

app.get("/api/server/logs", requireAuth, (req, res) => {
  const username = req.session.username;
  const logs = getLogs(username);
  res.json({ logs });
});

// ========== ВЕБСОКЕТ ДЛЯ КОНСОЛИ ==========
io.on("connection", (socket) => {
  const username = socket.handshake.auth.username;

  if (!username) {
    socket.disconnect();
    return;
  }

  socket.join(`user-${username}`);

  // Отправляем последние логи
  const logs = getLogs(username, 100);
  logs.forEach((log) => {
    socket.emit("log", log);
  });

  // Обработка команд
  socket.on("command", (cmd) => {
    if (processes[username]) {
      processes[username].stdin.write(cmd + "\n");
      appendLog(username, `> ${cmd}`);
    } else {
      socket.emit("error", "Сервер не запущен");
    }
  });
});

// ========== УПРАВЛЕНИЕ ФАЙЛАМИ ==========
const upload = multer({ dest: UPLOAD_DIR });

app.get("/api/files", requireAuth, (req, res) => {
  const username = req.session.username;
  const serverPath = path.join(USERS_DIR, username, "server");

  try {
    if (!fs.existsSync(serverPath)) {
      fs.mkdirSync(serverPath, { recursive: true });
    }

    const files = fs.readdirSync(serverPath).map((file) => {
      const filePath = path.join(serverPath, file);
      const stats = fs.statSync(filePath);
      return {
        name: file,
        size: stats.size,
        modified: stats.mtime,
        isDirectory: stats.isDirectory(),
      };
    });

    res.json(files);
  } catch (error) {
    console.error("Ошибка списка файлов:", error);
    res.status(500).json({ error: "Ошибка при чтении файлов" });
  }
});

app.get("/api/file/:filename", requireAuth, (req, res) => {
  const username = req.session.username;
  const filename = req.params.filename;

  if (filename.includes("..") || filename.includes("/")) {
    return res.status(400).send("Недопустимое имя файла");
  }

  const filePath = path.join(USERS_DIR, username, "server", filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Файл не найден");
  }

  if (filename === "server.jar") {
    return res.status(400).send("Нельзя редактировать server.jar");
  }

  try {
    const content = fs.readFileSync(filePath, "utf8");
    res.send(content);
  } catch (error) {
    res.status(500).send("Ошибка чтения файла");
  }
});

app.post("/api/file/:filename", requireAuth, (req, res) => {
  const username = req.session.username;
  const filename = req.params.filename;
  const { content } = req.body;

  if (filename.includes("..") || filename.includes("/")) {
    return res.status(400).send("Недопустимое имя файла");
  }

  if (filename === "server.jar") {
    return res.status(400).send("Нельзя редактировать server.jar");
  }

  const filePath = path.join(USERS_DIR, username, "server", filename);

  try {
    fs.writeFileSync(filePath, content);
    res.send("Файл сохранен");
  } catch (error) {
    console.error("Ошибка сохранения:", error);
    res.status(500).send("Ошибка при сохранении");
  }
});

app.post(
  "/api/upload",
  requireAuth,
  upload.single("file"),
  async (req, res) => {
    const username = req.session.username;

    if (!req.file) {
      return res.status(400).send("Файл не найден");
    }

    const serverPath = path.join(USERS_DIR, username, "server");
    const zipPath = req.file.path;

    try {
      await fs
        .createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: serverPath }))
        .promise();

      fs.unlinkSync(zipPath);
      res.send("ZIP распакован");
    } catch (error) {
      console.error("Ошибка распаковки:", error);
      res.status(500).send("Ошибка при распаковке");
    }
  }
);

// ========== SOFTWARES (Paper из JSON) ==========
app.get("/api/paper-versions", async (req, res) => {
  try {
    // Получаем все версии из JSON
    const versions = Object.keys(paperVersions.versions);

    // Фильтруем только стабильные (без pre, rc, snapshot)
    const stableVersions = versions
      .filter(
        (v) =>
          !v.includes("pre") && !v.includes("rc") && !v.includes("SNAPSHOT")
      )
      .sort((a, b) => {
        // Сортируем по версиям (новые сверху)
        const aParts = a.split(".").map(Number);
        const bParts = b.split(".").map(Number);
        for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
          if (aParts[i] !== bParts[i]) return bParts[i] - aParts[i];
        }
        return bParts.length - aParts.length;
      });

    res.json(stableVersions);
  } catch (error) {
    console.error("Ошибка получения версий:", error);
    // Запасной список
    res.json(["1.21.4", "1.20.4", "1.20.2"]);
  }
});

app.post("/api/download-paper", requireAuth, async (req, res) => {
  const username = req.session.username;
  const { version } = req.body;

  if (!version) {
    return res.status(400).send("Версия не указана");
  }

  // Проверяем, есть ли такая версия в нашем JSON
  const downloadUrl = paperVersions.versions[version];

  if (!downloadUrl) {
    return res
      .status(404)
      .send(
        `❌ Версия ${version} не найдена в списке. Доступные версии: ${Object.keys(
          paperVersions.versions
        ).join(", ")}`
      );
  }

  try {
    const serverPath = path.join(USERS_DIR, username, "server");
    if (!fs.existsSync(serverPath)) {
      fs.mkdirSync(serverPath, { recursive: true });
    }

    const jarPath = path.join(serverPath, "server.jar");

    // Удаляем старый файл, если есть
    if (fs.existsSync(jarPath)) {
      fs.unlinkSync(jarPath);
    }

    const writer = fs.createWriteStream(jarPath);
    const response = await axios({
      method: "get",
      url: downloadUrl,
      responseType: "stream",
      headers: { "User-Agent": "MCSV-Panel/2.0" },
      timeout: 60000, // 60 секунд
    });

    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    appendLog(username, `✅ Скачан Paper ${version}`);
    res.send(`✅ Paper ${version} успешно скачан!`);
  } catch (error) {
    console.error("Ошибка скачивания:", error.message);
    res.status(500).send(`❌ Ошибка при скачивании Paper: ${error.message}`);
  }
});

// ========== ПОИСК ПЛАГИНОВ ==========
app.get("/api/plugins/search", async (req, res) => {
  const query = req.query.q;

  if (!query || query.length < 3) {
    return res.json([]);
  }

  try {
    const response = await axios.get("https://api.modrinth.com/v2/search", {
      params: {
        query: query,
        limit: 10,
        facets: JSON.stringify([["project_type:plugin"]]),
      },
      timeout: 5000,
      headers: { "User-Agent": "MCSV-Panel/2.0" },
    });

    if (!response.data || !response.data.hits) {
      return res.json([]);
    }

    const plugins = response.data.hits.map((hit) => ({
      title: hit.title || "Без названия",
      description: hit.description || "Нет описания",
      icon_url: hit.icon_url || "https://cdn.modrinth.com/placeholder.png",
      downloads: hit.downloads || 0,
      author: hit.author || "Неизвестен",
      versions: hit.versions || [],
      project_id: hit.project_id,
    }));

    res.json(plugins);
  } catch (error) {
    console.error("Ошибка поиска плагинов:", error.message);
    // Возвращаем пустой массив, но с информацией об ошибке для фронтенда
    res.status(500).json({ error: "Ошибка поиска плагинов", plugins: [] });
  }
});

// ========== АДМИН-ПАНЕЛЬ ==========
app.get("/api/admin/users", requireAdmin, (req, res) => {
  const stmt = db.prepare(`
        SELECT u.*, s.status as server_status, s.port, s.pid
        FROM users u
        LEFT JOIN servers s ON u.id = s.user_id
        ORDER BY u.created_at DESC
    `);

  const users = stmt.all();
  res.json(users);
});

app.post("/api/admin/delete-user", requireAdmin, async (req, res) => {
  const { username } = req.body;

  if (username === "admin") {
    return res.status(400).json({ error: "Нельзя удалить админа" });
  }

  const user = getUser(username);
  if (!user) {
    return res.status(404).json({ error: "Пользователь не найден" });
  }

  try {
    // Останавливаем процесс
    if (processes[username]) {
      try {
        processes[username].kill("SIGKILL");
        delete processes[username];
      } catch (e) {
        console.log("Ошибка при остановке процесса:", e);
      }
    }

    // Удаляем сервер из БД
    const stmt = db.prepare("DELETE FROM servers WHERE user_id = ?");
    stmt.run(user.id);

    // Удаляем пользователя
    const stmt2 = db.prepare("DELETE FROM users WHERE id = ?");
    stmt2.run(user.id);

    // Удаляем папку
    const userDir = path.join(USERS_DIR, username);
    if (fs.existsSync(userDir)) {
      fs.rmSync(userDir, { recursive: true, force: true });
    }

    res.json({ success: true, message: "Пользователь удален" });
  } catch (error) {
    console.error("Ошибка удаления пользователя:", error);
    res.status(500).json({ error: "Ошибка при удалении" });
  }
});

app.post("/api/admin/stop-server", requireAdmin, (req, res) => {
  const { username } = req.body;

  if (!processes[username]) {
    return res.status(400).json({ error: "Сервер не запущен" });
  }

  try {
    processes[username].stdin.write("stop\n");
    res.json({ success: true, message: "Сервер останавливается" });
  } catch (error) {
    console.error("Ошибка остановки:", error);
    res.status(500).json({ error: "Ошибка при остановке" });
  }
});

// ========== СТАТИЧЕСКИЕ ФАЙЛЫ И СТРАНИЦЫ ==========
app.get("/", (req, res) => {
  if (req.session.userId) {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  } else {
    res.redirect("/login");
  }
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/admin", (req, res) => {
  if (req.session.userId && req.session.role === "admin") {
    res.sendFile(path.join(__dirname, "public", "admin.html"));
  } else {
    res.redirect("/");
  }
});

// ========== ЗАПУСК ==========
createAdmin().then(() => {
  server.listen(PORT, () => {
    console.log("=".repeat(40));
    console.log("🚀 MCSV Panel v2 запущен!");
    console.log(`🌐 http://localhost:${PORT}`);
    console.log("📝 Логин: admin / admin123");
    console.log("=".repeat(40));
  });
});
