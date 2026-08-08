const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const activeTasks = new Map();

const OUTPUT_CANDIDATES = [
  "dist",
  "build",
  ".next",
  "out",
  "release",
  "releases",
  "packages",
  "packaged",
  "app",
  "target",
  "coverage",
];

const CLEAN_CANDIDATES = [
  "dist",
  "build",
  ".next",
  "out",
  ".svelte-kit",
  ".nuxt",
  ".vite",
  ".cache",
  "coverage",
  "release",
  "releases",
  "packaged",
  "target",
  "__pycache__",
];

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1120,
    minHeight: 720,
    title: "Master Builder",
    backgroundColor: "#070812",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function exists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function statTime(targetPath) {
  try {
    return (await fsp.stat(targetPath)).mtimeMs;
  } catch {
    return 0;
  }
}

async function listExisting(folderPath, names) {
  const found = [];
  for (const name of names) {
    const target = path.join(folderPath, name);
    if (await exists(target)) found.push({ name, path: target });
  }
  return found;
}

function allDependencies(packageJson) {
  return {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
    ...(packageJson.optionalDependencies || {}),
  };
}

function hasDependency(packageJson, names) {
  const deps = allDependencies(packageJson);
  return names.some((name) => deps[name]);
}

function detectPackageManager(folderPath) {
  if (fs.existsSync(path.join(folderPath, "pnpm-lock.yaml"))) return { name: "pnpm", install: "pnpm install", run: "pnpm run" };
  if (fs.existsSync(path.join(folderPath, "yarn.lock"))) return { name: "yarn", install: "yarn install", run: "yarn" };
  if (fs.existsSync(path.join(folderPath, "bun.lockb")) || fs.existsSync(path.join(folderPath, "bun.lock"))) return { name: "bun", install: "bun install", run: "bun run" };
  return { name: "npm", install: "npm install", run: "npm run" };
}

function scriptCommand(packageManager, scriptName) {
  if (packageManager.name === "yarn") return `yarn ${scriptName}`;
  return `${packageManager.run} ${scriptName}`;
}

async function detectNodeHealth(folderPath, packageJson) {
  if (!packageJson) return null;
  const nodeModules = path.join(folderPath, "node_modules");
  const packagePath = path.join(folderPath, "package.json");
  const lockPaths = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].map((name) => path.join(folderPath, name));
  const nodeModulesExists = await exists(nodeModules);
  const newestManifest = Math.max(await statTime(packagePath), ...(await Promise.all(lockPaths.map(statTime))));
  const modulesTime = await statTime(nodeModules);
  const deps = Object.keys(allDependencies(packageJson));
  const missing = [];

  if (nodeModulesExists) {
    for (const dep of deps.slice(0, 35)) {
      const depPath = dep.startsWith("@")
        ? path.join(nodeModules, ...dep.split("/"))
        : path.join(nodeModules, dep);
      if (!(await exists(depPath))) missing.push(dep);
    }
  }

  const stale = nodeModulesExists && newestManifest > modulesTime + 1000;
  const corrupted = nodeModulesExists && missing.length > 0;
  return {
    hasNodeModules: nodeModulesExists,
    stale,
    corrupted,
    missingPackages: missing,
    recommendation: !nodeModulesExists
      ? "Dependencies have not been installed yet."
      : corrupted
        ? "Some installed packages are missing. A repair reinstall is recommended."
        : stale
          ? "Dependency manifest changed after node_modules was created. Reinstall is recommended."
          : "Dependencies look ready.",
  };
}

function inferNodeProject(folderPath, packageJson) {
  const scripts = packageJson.scripts || {};
  const deps = allDependencies(packageJson);
  const has = (...names) => names.some((name) => deps[name]);
  const files = (names) => names.some((name) => fs.existsSync(path.join(folderPath, name)));

  if (has("electron", "electron-builder", "electron-forge") || files(["electron-builder.yml", "electron.vite.config.js", "electron.vite.config.ts"])) {
    return "Electron";
  }
  if (has("next") || files(["next.config.js", "next.config.mjs", "next.config.ts"])) return "Next.js";
  if (has("@sveltejs/kit", "svelte") || files(["svelte.config.js", "svelte.config.ts"])) return "Svelte";
  if (has("vue", "@vitejs/plugin-vue") || files(["vue.config.js"])) return "Vue";
  if (has("vite") || files(["vite.config.js", "vite.config.ts", "vite.config.mjs"])) {
    if (has("react", "@vitejs/plugin-react")) return "Vite React";
    return "Vite";
  }
  if (has("react")) return "React";
  if (scripts.build) return "Node.js";
  return "Node.js";
}

function detectBuildPlan(folderPath, packageJson, projectType, packageManager) {
  const scripts = packageJson?.scripts || {};
  const commands = [];
  const expectedOutputs = [];
  let canBuild = false;
  let desktopCapable = false;
  let installerCapable = false;
  let explanation = "A build command was detected.";

  if (packageJson) {
    const desktopScripts = ["dist", "make", "package", "pack", "electron:build", "builder"];
    const desktopScript = desktopScripts.find((name) => scripts[name]);
    if (projectType === "Electron" && desktopScript) {
      commands.push(scriptCommand(packageManager, desktopScript));
      expectedOutputs.push("dist", "release", "releases", "out");
      canBuild = true;
      desktopCapable = true;
      installerCapable = ["dist", "make", "electron:build", "builder"].includes(desktopScript);
      explanation = installerCapable
        ? "Electron packaging script found. Master Builder can create a desktop package or installer."
        : "Electron project found. Master Builder can create a packaged desktop app with the available script.";
    } else if (scripts.build) {
      commands.push(scriptCommand(packageManager, "build"));
      canBuild = true;
      if (projectType === "Next.js") expectedOutputs.push(".next", "out");
      else if (["Vite", "Vite React", "React", "Vue", "Svelte"].includes(projectType)) expectedOutputs.push("dist", "build");
      else expectedOutputs.push("dist", "build", "lib");
      explanation = projectType === "Electron"
        ? "This Electron project has a normal build script but no packaging script. It may not produce an EXE or installer until electron-builder, Electron Forge, or a similar packager is configured."
        : "Build script found. Master Builder will run it and locate generated output folders.";
    } else if (scripts.export) {
      commands.push(scriptCommand(packageManager, "export"));
      expectedOutputs.push("out", "dist");
      canBuild = true;
      explanation = "Export script found. Master Builder will create a static output if the project supports it.";
    } else {
      explanation = "No package build script was found. Dependencies can still be installed, but this project does not declare an automatic build command.";
    }
  }

  if (!packageJson && fs.existsSync(path.join(folderPath, "pyproject.toml"))) {
    commands.push("python -m build");
    expectedOutputs.push("dist");
    canBuild = true;
    explanation = "Python pyproject.toml found. Master Builder will run the standard Python build module.";
  }

  if (!packageJson && fs.existsSync(path.join(folderPath, "setup.py"))) {
    commands.push("python setup.py sdist bdist_wheel");
    expectedOutputs.push("dist", "build");
    canBuild = true;
    explanation = "Python setup.py found. Master Builder will create source and wheel distributions.";
  }

  const specFile = fs.readdirSync(folderPath, { withFileTypes: true }).find((entry) => entry.isFile() && entry.name.endsWith(".spec"));
  if (!packageJson && specFile) {
    commands.length = 0;
    commands.push(`pyinstaller "${specFile.name}"`);
    expectedOutputs.push("dist", "build");
    canBuild = true;
    desktopCapable = true;
    installerCapable = false;
    explanation = "PyInstaller spec file found. Master Builder can create a desktop executable, but not an installer unless the project adds installer tooling.";
  }

  if (!packageJson && !canBuild && fs.existsSync(path.join(folderPath, "index.html"))) {
    expectedOutputs.push("current folder");
    explanation = "Static web project found. It is already deployable as files and does not need a compiled build step.";
  }

  return { commands, expectedOutputs, canBuild, desktopCapable, installerCapable, explanation };
}

async function analyzeProject(folderPath) {
  if (!folderPath || !(await exists(folderPath))) throw new Error("Selected folder does not exist.");

  const packageJsonPath = path.join(folderPath, "package.json");
  const packageJson = (await exists(packageJsonPath)) ? safeReadJson(packageJsonPath) : null;
  const packageManager = packageJson ? detectPackageManager(folderPath) : null;
  let projectType = "Unknown";
  let installPlan = null;

  if (packageJson) {
    projectType = inferNodeProject(folderPath, packageJson);
    installPlan = {
      ecosystem: "Node.js",
      command: packageManager.install,
      packageManager: packageManager.name,
    };
  } else if (await exists(path.join(folderPath, "requirements.txt"))) {
    projectType = "Python";
    installPlan = { ecosystem: "Python", command: "python -m pip install -r requirements.txt", packageManager: "pip" };
  } else if ((await exists(path.join(folderPath, "pyproject.toml"))) || (await exists(path.join(folderPath, "setup.py")))) {
    projectType = "Python";
    installPlan = { ecosystem: "Python", command: "python -m pip install -e .", packageManager: "pip" };
  } else if (await exists(path.join(folderPath, "index.html"))) {
    projectType = "Static Web";
  }

  const buildPlan = detectBuildPlan(folderPath, packageJson, projectType, packageManager || { name: "npm", run: "npm run" });
  const currentOutputs = await listExisting(folderPath, OUTPUT_CANDIDATES);
  const cleanTargets = await listExisting(folderPath, CLEAN_CANDIDATES);
  const nodeHealth = await detectNodeHealth(folderPath, packageJson);
  const packageName = packageJson?.productName || packageJson?.name || path.basename(folderPath);

  return {
    folderPath,
    name: packageName,
    projectType,
    packageManager: packageManager?.name || installPlan?.packageManager || "none",
    scripts: packageJson?.scripts || {},
    installPlan,
    buildPlan,
    currentOutputs,
    cleanTargets,
    nodeHealth,
    supportsExe: buildPlan.desktopCapable,
    supportsInstaller: buildPlan.installerCapable,
    outputExplanation: buildPlan.explanation,
  };
}

function emitLog(taskId, level, line) {
  BrowserWindow.getAllWindows().forEach((win) => win.webContents.send("task:log", {
    taskId,
    level,
    line: String(line || "").replace(/\r?\n$/, ""),
    at: new Date().toISOString(),
  }));
}

function emitStatus(taskId, status, extra = {}) {
  BrowserWindow.getAllWindows().forEach((win) => win.webContents.send("task:status", {
    taskId,
    status,
    at: new Date().toISOString(),
    ...extra,
  }));
}

function runCommand(taskId, command, cwd) {
  return new Promise((resolve, reject) => {
    emitLog(taskId, "command", `$ ${command}`);
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, CI: "1", FORCE_COLOR: "1" },
    });

    activeTasks.set(taskId, child);
    child.stdout.on("data", (data) => data.toString().split(/\r?\n/).filter(Boolean).forEach((line) => emitLog(taskId, "info", line)));
    child.stderr.on("data", (data) => data.toString().split(/\r?\n/).filter(Boolean).forEach((line) => emitLog(taskId, "warn", line)));
    child.on("error", reject);
    child.on("close", (code) => {
      activeTasks.delete(taskId);
      if (code === 0) resolve();
      else reject(new Error(`Command failed with exit code ${code}: ${command}`));
    });
  });
}

async function removeTargets(taskId, folderPath, targets) {
  const removed = [];
  for (const relativeName of targets) {
    const targetPath = path.join(folderPath, relativeName);
    if (await exists(targetPath)) {
      emitLog(taskId, "info", `Removing ${relativeName}`);
      await fsp.rm(targetPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
      removed.push({ name: relativeName, path: targetPath });
    }
  }
  return removed;
}

async function findOutputs(folderPath, buildPlan) {
  const names = Array.from(new Set([...(buildPlan.expectedOutputs || []), ...OUTPUT_CANDIDATES])).filter((name) => name !== "current folder");
  const outputs = await listExisting(folderPath, names);
  if (buildPlan.expectedOutputs?.includes("current folder")) outputs.unshift({ name: "current folder", path: folderPath });
  return outputs;
}

ipcMain.handle("dialog:select-folder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Choose a project folder" });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle("project:analyze", async (_event, folderPath) => analyzeProject(folderPath));

ipcMain.handle("project:cleanup", async (_event, payload) => {
  const { folderPath, taskId, includeDependencies = false } = payload;
  emitStatus(taskId, "cleaning");
  try {
    const targets = [...CLEAN_CANDIDATES];
    if (includeDependencies) targets.unshift("node_modules");
    const removed = await removeTargets(taskId, folderPath, Array.from(new Set(targets)));
    emitStatus(taskId, "success", { removed });
    return { ok: true, removed, analysis: await analyzeProject(folderPath) };
  } catch (error) {
    emitLog(taskId, "error", error.message);
    emitStatus(taskId, "failed", { error: error.message });
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("project:install", async (_event, payload) => {
  const { folderPath, taskId, repair = false } = payload;
  emitStatus(taskId, "installing");
  try {
    const analysis = await analyzeProject(folderPath);
    if (!analysis.installPlan) throw new Error("This project does not declare installable dependencies.");
    if (repair) await removeTargets(taskId, folderPath, ["node_modules"]);
    await runCommand(taskId, analysis.installPlan.command, folderPath);
    const nextAnalysis = await analyzeProject(folderPath);
    emitStatus(taskId, "success", { analysis: nextAnalysis });
    return { ok: true, analysis: nextAnalysis };
  } catch (error) {
    emitLog(taskId, "error", error.message);
    emitStatus(taskId, "failed", { error: error.message });
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("project:build", async (_event, payload) => {
  const { folderPath, taskId, autoRepair = true, cleanFirst = true } = payload;
  emitStatus(taskId, "building");
  try {
    let analysis = await analyzeProject(folderPath);
    if (!analysis.buildPlan.canBuild) throw new Error(analysis.outputExplanation || "No supported build command was detected.");
    if (cleanFirst) await removeTargets(taskId, folderPath, CLEAN_CANDIDATES);
    if (analysis.installPlan) {
      const shouldRepair = autoRepair && analysis.nodeHealth && (!analysis.nodeHealth.hasNodeModules || analysis.nodeHealth.stale || analysis.nodeHealth.corrupted);
      if (shouldRepair && analysis.nodeHealth.corrupted) await removeTargets(taskId, folderPath, ["node_modules"]);
      if (shouldRepair) await runCommand(taskId, analysis.installPlan.command, folderPath);
    }
    for (const command of analysis.buildPlan.commands) await runCommand(taskId, command, folderPath);
    analysis = await analyzeProject(folderPath);
    const outputs = await findOutputs(folderPath, analysis.buildPlan);
    emitStatus(taskId, "success", { outputs, analysis });
    return { ok: true, outputs, analysis };
  } catch (error) {
    emitLog(taskId, "error", error.message);
    emitStatus(taskId, "failed", { error: error.message });
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("shell:open-path", async (_event, targetPath) => {
  if (!targetPath) return { ok: false, error: "No path was provided." };
  const error = await shell.openPath(targetPath);
  return error ? { ok: false, error } : { ok: true };
});

ipcMain.handle("task:cancel", async (_event, taskId) => {
  const child = activeTasks.get(taskId);
  if (!child) return { ok: false, error: "No active task found." };
  child.kill("SIGTERM");
  activeTasks.delete(taskId);
  emitStatus(taskId, "failed", { error: "Task cancelled by user." });
  return { ok: true };
});

ipcMain.handle("app:runtime-info", async () => ({
  electron: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
  platform: process.platform,
}));