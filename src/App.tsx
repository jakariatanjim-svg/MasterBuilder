import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "./utils/cn";

type Status = "idle" | "detecting" | "cleaning" | "installing" | "building" | "success" | "failed";

type LogLine = {
  taskId: string;
  level: "command" | "info" | "warn" | "error";
  line: string;
  at: string;
};

type OutputPath = { name: string; path: string };

type ProjectAnalysis = {
  folderPath: string;
  name: string;
  projectType: string;
  packageManager: string;
  scripts: Record<string, string>;
  installPlan: null | { ecosystem: string; command: string; packageManager: string };
  buildPlan: {
    commands: string[];
    expectedOutputs: string[];
    canBuild: boolean;
    desktopCapable: boolean;
    installerCapable: boolean;
    explanation: string;
  };
  currentOutputs: OutputPath[];
  cleanTargets: OutputPath[];
  nodeHealth: null | {
    hasNodeModules: boolean;
    stale: boolean;
    corrupted: boolean;
    missingPackages: string[];
    recommendation: string;
  };
  supportsExe: boolean;
  supportsInstaller: boolean;
  outputExplanation: string;
};

type RuntimeInfo = {
  electron: string;
  node: string;
  chrome: string;
  platform: string;
};

type MasterBuilderApi = {
  selectFolder: () => Promise<string | null>;
  analyzeProject: (folderPath: string) => Promise<ProjectAnalysis>;
  cleanupProject: (payload: { folderPath: string; taskId: string; includeDependencies?: boolean }) => Promise<ActionResult>;
  installDependencies: (payload: { folderPath: string; taskId: string; repair?: boolean }) => Promise<ActionResult>;
  buildProject: (payload: { folderPath: string; taskId: string; autoRepair?: boolean; cleanFirst?: boolean }) => Promise<ActionResult>;
  openPath: (targetPath: string) => Promise<{ ok: boolean; error?: string }>;
  cancelTask: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
  getRuntimeInfo: () => Promise<RuntimeInfo>;
  onTaskLog: (callback: (message: LogLine) => void) => () => void;
  onTaskStatus: (callback: (message: { taskId: string; status: Status; error?: string; outputs?: OutputPath[]; analysis?: ProjectAnalysis }) => void) => () => void;
};

type ActionResult = {
  ok: boolean;
  error?: string;
  analysis?: ProjectAnalysis;
  outputs?: OutputPath[];
};

declare global {
  interface Window {
    masterBuilder?: MasterBuilderApi;
  }
}

const statusCopy: Record<Status, string> = {
  idle: "Ready",
  detecting: "Detecting",
  cleaning: "Cleaning",
  installing: "Installing",
  building: "Building",
  success: "Success",
  failed: "Failed",
};

const statusClasses: Record<Status, string> = {
  idle: "border-white/10 bg-white/8 text-slate-300",
  detecting: "border-cyan-300/30 bg-cyan-400/10 text-cyan-100",
  cleaning: "border-amber-300/30 bg-amber-400/10 text-amber-100",
  installing: "border-violet-300/30 bg-violet-400/10 text-violet-100",
  building: "border-blue-300/30 bg-blue-400/10 text-blue-100",
  success: "border-emerald-300/30 bg-emerald-400/10 text-emerald-100",
  failed: "border-rose-300/30 bg-rose-400/10 text-rose-100",
};

const busyStatuses: Status[] = ["detecting", "cleaning", "installing", "building"];

function newTaskId() {
  return `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function shortPath(value: string) {
  if (value.length <= 74) return value;
  const parts = value.split(/[\\/]/).filter(Boolean);
  return `${parts.slice(0, 2).join("/")}/.../${parts.slice(-3).join("/")}`;
}

function StatusBadge({ status }: { status: Status }) {
  const busy = busyStatuses.includes(status);
  return (
    <div className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium", statusClasses[status])}>
      <span className={cn("h-2 w-2 rounded-full", busy ? "animate-pulse bg-current" : "bg-current")} />
      {statusCopy[status]}
    </div>
  );
}

function ActionButton({
  children,
  variant = "secondary",
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group relative overflow-hidden rounded-2xl px-5 py-3 text-sm font-semibold transition duration-300 disabled:cursor-not-allowed disabled:opacity-40",
        "focus:outline-none focus:ring-2 focus:ring-cyan-300/50 focus:ring-offset-2 focus:ring-offset-slate-950",
        variant === "primary" && "bg-cyan-300 text-slate-950 shadow-[0_0_32px_rgba(103,232,249,0.26)] hover:bg-cyan-200",
        variant === "secondary" && "border border-white/10 bg-white/8 text-slate-100 hover:border-white/20 hover:bg-white/12",
        variant === "danger" && "border border-rose-300/20 bg-rose-400/10 text-rose-100 hover:bg-rose-400/16",
      )}
    >
      <span className="relative z-10">{children}</span>
      {variant === "primary" ? <span className="absolute inset-y-0 left-0 w-0 bg-white/30 transition-all duration-500 group-hover:w-full" /> : null}
    </button>
  );
}

function InfoLine({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/8 py-3 last:border-b-0">
      <span className="text-sm text-slate-500">{label}</span>
      <span className="max-w-[70%] text-right text-sm font-medium text-slate-200">{value}</span>
    </div>
  );
}

function Terminal({ logs }: { logs: LogLine[] }) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div className="h-[310px] overflow-hidden rounded-3xl border border-white/10 bg-black/45 shadow-2xl shadow-black/30">
      <div className="flex items-center justify-between border-b border-white/8 px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-rose-400/80" />
          <span className="h-3 w-3 rounded-full bg-amber-300/80" />
          <span className="h-3 w-3 rounded-full bg-emerald-300/80" />
        </div>
        <span className="text-xs uppercase tracking-[0.35em] text-slate-500">Live Logs</span>
      </div>
      <div className="terminal-scroll h-[262px] overflow-y-auto px-5 py-4 font-mono text-[12px] leading-6">
        {logs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center text-slate-500">
            Select a project and run cleanup, dependency repair, or build to stream logs here.
          </div>
        ) : (
          logs.map((log, index) => (
            <div
              key={`${log.taskId}-${index}`}
              className={cn(
                "whitespace-pre-wrap break-words",
                log.level === "command" && "text-cyan-200",
                log.level === "info" && "text-slate-300",
                log.level === "warn" && "text-amber-200",
                log.level === "error" && "text-rose-200",
              )}
            >
              <span className="mr-3 text-slate-600">{new Date(log.at).toLocaleTimeString()}</span>
              {log.line}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function Capability({ active, title, detail }: { active: boolean; title: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className={cn("h-2.5 w-2.5 rounded-full", active ? "bg-emerald-300 shadow-[0_0_16px_rgba(110,231,183,0.7)]" : "bg-slate-600")} />
        <span className="font-semibold text-slate-100">{title}</span>
      </div>
      <p className="text-sm leading-6 text-slate-400">{detail}</p>
    </div>
  );
}

export default function App() {
  const api = window.masterBuilder;
  const [analysis, setAnalysis] = useState<ProjectAnalysis | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [outputs, setOutputs] = useState<OutputPath[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [autoRepair, setAutoRepair] = useState(true);
  const [cleanFirst, setCleanFirst] = useState(true);
  const [includeDependenciesOnClean, setIncludeDependenciesOnClean] = useState(true);

  const busy = busyStatuses.includes(status);
  const selectedFolder = analysis?.folderPath;

  useEffect(() => {
    if (!api) return;
    api.getRuntimeInfo().then(setRuntime).catch(() => undefined);
    const removeLogListener = api.onTaskLog((message) => {
      setLogs((current) => [...current.slice(-499), message]);
    });
    const removeStatusListener = api.onTaskStatus((message) => {
      setStatus(message.status);
      if (message.error) setError(message.error);
      if (message.analysis) setAnalysis(message.analysis);
      if (message.outputs) setOutputs(message.outputs);
      if (["success", "failed"].includes(message.status)) setActiveTaskId(null);
    });
    return () => {
      removeLogListener();
      removeStatusListener();
    };
  }, [api]);

  const scriptNames = useMemo(() => Object.keys(analysis?.scripts || {}).slice(0, 8), [analysis]);

  async function selectFolder() {
    if (!api || busy) return;
    setError(null);
    setStatus("detecting");
    try {
      const folder = await api.selectFolder();
      if (!folder) {
        setStatus("idle");
        return;
      }
      const result = await api.analyzeProject(folder);
      setAnalysis(result);
      setOutputs(result.currentOutputs);
      setLogs([]);
      setStatus("success");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not analyze this folder.");
      setStatus("failed");
    }
  }

  async function refreshAnalysis() {
    if (!api || !selectedFolder || busy) return;
    setError(null);
    setStatus("detecting");
    try {
      const result = await api.analyzeProject(selectedFolder);
      setAnalysis(result);
      setOutputs(result.currentOutputs);
      setStatus("success");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not refresh project detection.");
      setStatus("failed");
    }
  }

  async function runAction(kind: "cleanup" | "install" | "build") {
    if (!api || !selectedFolder || busy) return;
    const taskId = newTaskId();
    setActiveTaskId(taskId);
    setError(null);
    setLogs([]);
    const result =
      kind === "cleanup"
        ? await api.cleanupProject({ folderPath: selectedFolder, taskId, includeDependencies: includeDependenciesOnClean })
        : kind === "install"
          ? await api.installDependencies({ folderPath: selectedFolder, taskId, repair: true })
          : await api.buildProject({ folderPath: selectedFolder, taskId, autoRepair, cleanFirst });

    if (!result.ok) {
      setError(result.error || "The operation failed.");
      setStatus("failed");
    }
    if (result.analysis) setAnalysis(result.analysis);
    if (result.outputs) setOutputs(result.outputs);
  }

  async function cancelTask() {
    if (!api || !activeTaskId) return;
    await api.cancelTask(activeTaskId);
  }

  async function openOutput(targetPath: string) {
    if (!api) return;
    const result = await api.openPath(targetPath);
    if (!result.ok) setError(result.error || "Could not open the output folder.");
  }

  return (
    <div className="min-h-screen overflow-hidden bg-[#070812] text-slate-100">
      <div className="pointer-events-none fixed inset-0 opacity-80">
        <div className="absolute left-[-12%] top-[-20%] h-[520px] w-[520px] rounded-full bg-cyan-500/20 blur-[110px]" />
        <div className="absolute bottom-[-18%] right-[-8%] h-[560px] w-[560px] rounded-full bg-violet-600/18 blur-[120px]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.05)_1px,transparent_1px)] [background-size:28px_28px] opacity-25" />
      </div>

      <main className="relative mx-auto flex min-h-screen max-w-[1480px] flex-col px-8 py-7">
        <motion.header
          initial={{ opacity: 0, y: -18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: "easeOut" }}
          className="mb-8 flex items-center justify-between"
        >
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-200/20 bg-cyan-300/12 shadow-[0_0_42px_rgba(103,232,249,0.25)]">
              <svg viewBox="0 0 24 24" className="h-6 w-6 text-cyan-200" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M4 17.5 12 22l8-4.5" />
                <path d="M4 12.5 12 17l8-4.5" />
                <path d="M4 7.5 12 12l8-4.5L12 3 4 7.5Z" />
              </svg>
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Master Builder</h1>
              <p className="text-sm text-slate-500">Automatic project detection, repair, cleanup, and local builds from one desktop interface.</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge status={status} />
            {activeTaskId ? <ActionButton variant="danger" onClick={cancelTask}>Cancel</ActionButton> : null}
          </div>
        </motion.header>

        {!api ? (
          <div className="rounded-3xl border border-amber-300/20 bg-amber-300/10 p-8 text-amber-50">
            Master Builder is designed to run inside Electron. Launch the Electron app to enable folder picking, cleanup, dependency repair, builds, and output handling.
          </div>
        ) : null}

        <div className="grid flex-1 grid-cols-[390px_minmax(0,1fr)] gap-6">
          <motion.aside
            initial={{ opacity: 0, x: -24 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6, ease: "easeOut", delay: 0.05 }}
            className="flex flex-col gap-5"
          >
            <section className="rounded-[2rem] border border-white/10 bg-white/[0.055] p-5 shadow-2xl shadow-black/25 backdrop-blur-2xl">
              <div className="mb-5">
                <p className="mb-2 text-xs uppercase tracking-[0.35em] text-cyan-200/70">Project Source</p>
                <h2 className="text-xl font-semibold">Choose a folder</h2>
              </div>
              <ActionButton variant="primary" disabled={!api || busy} onClick={selectFolder}>
                Select Local Project
              </ActionButton>
              <div className="mt-5 rounded-2xl border border-white/8 bg-black/20 p-4">
                <p className="text-xs uppercase tracking-[0.25em] text-slate-600">Selected Path</p>
                <p className="mt-2 break-words text-sm leading-6 text-slate-300">{selectedFolder ? shortPath(selectedFolder) : "No project selected yet"}</p>
              </div>
            </section>

            <section className="rounded-[2rem] border border-white/10 bg-white/[0.055] p-5 backdrop-blur-2xl">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Automation</h2>
                <button className="text-sm text-cyan-200 disabled:opacity-40" type="button" disabled={!analysis || busy} onClick={refreshAnalysis}>Refresh</button>
              </div>
              <div className="space-y-3">
                <label className="flex cursor-pointer items-center justify-between gap-4 rounded-2xl border border-white/8 bg-black/18 px-4 py-3 text-sm text-slate-300">
                  Repair dependencies before build
                  <input className="accent-cyan-300" type="checkbox" checked={autoRepair} onChange={(event) => setAutoRepair(event.target.checked)} />
                </label>
                <label className="flex cursor-pointer items-center justify-between gap-4 rounded-2xl border border-white/8 bg-black/18 px-4 py-3 text-sm text-slate-300">
                  Clean old outputs before build
                  <input className="accent-cyan-300" type="checkbox" checked={cleanFirst} onChange={(event) => setCleanFirst(event.target.checked)} />
                </label>
                <label className="flex cursor-pointer items-center justify-between gap-4 rounded-2xl border border-white/8 bg-black/18 px-4 py-3 text-sm text-slate-300">
                  Include node_modules in cleanup
                  <input className="accent-cyan-300" type="checkbox" checked={includeDependenciesOnClean} onChange={(event) => setIncludeDependenciesOnClean(event.target.checked)} />
                </label>
              </div>
            </section>

            <section className="rounded-[2rem] border border-white/10 bg-white/[0.055] p-5 backdrop-blur-2xl">
              <h2 className="mb-4 text-lg font-semibold">One-Click Actions</h2>
              <div className="grid gap-3">
                <ActionButton disabled={!analysis || busy} onClick={() => runAction("install")}>Repair or Install Dependencies</ActionButton>
                <ActionButton disabled={!analysis || busy} onClick={() => runAction("cleanup")}>Clean Workspace</ActionButton>
                <ActionButton variant="primary" disabled={!analysis || busy || !analysis.buildPlan.canBuild} onClick={() => runAction("build")}>Build Automatically</ActionButton>
              </div>
              {analysis && !analysis.buildPlan.canBuild ? (
                <p className="mt-4 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-3 text-sm leading-6 text-amber-100">{analysis.outputExplanation}</p>
              ) : null}
            </section>

            {runtime ? (
              <section className="rounded-[2rem] border border-white/10 bg-white/[0.045] p-5 text-sm text-slate-400">
                <InfoLine label="Electron" value={runtime.electron} />
                <InfoLine label="Node" value={runtime.node} />
                <InfoLine label="Platform" value={runtime.platform} />
              </section>
            ) : null}
          </motion.aside>

          <section className="min-w-0">
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: "easeOut", delay: 0.12 }}
              className="mb-6 overflow-hidden rounded-[2rem] border border-white/10 bg-white/[0.06] shadow-2xl shadow-black/30 backdrop-blur-2xl"
            >
              <div className="relative p-7">
                <motion.div
                  className="absolute right-10 top-8 h-28 w-28 rounded-full bg-cyan-300/15 blur-3xl"
                  animate={{ scale: [1, 1.28, 1], opacity: [0.55, 0.9, 0.55] }}
                  transition={{ duration: 4.5, repeat: Infinity, ease: "easeInOut" }}
                />
                <div className="relative flex items-start justify-between gap-8">
                  <div>
                    <p className="mb-3 text-xs uppercase tracking-[0.4em] text-cyan-200/70">Detected Project</p>
                    <h2 className="text-4xl font-semibold tracking-tight text-white">{analysis?.name || "Waiting for a project"}</h2>
                    <p className="mt-3 max-w-3xl text-base leading-7 text-slate-400">
                      {analysis
                        ? analysis.outputExplanation
                        : "Pick any local source-code folder. Master Builder will inspect it, choose the right build strategy, repair dependencies when needed, and stream every step here."}
                    </p>
                  </div>
                  <div className="min-w-[210px] rounded-3xl border border-white/10 bg-black/20 p-5">
                    <InfoLine label="Type" value={analysis?.projectType || "Not detected"} />
                    <InfoLine label="Manager" value={analysis?.packageManager || "none"} />
                    <InfoLine label="Build" value={analysis?.buildPlan.canBuild ? "Available" : "Not available"} />
                  </div>
                </div>
              </div>
            </motion.div>

            <div className="mb-6 grid grid-cols-3 gap-4">
              <Capability
                active={Boolean(analysis?.installPlan)}
                title="Dependencies"
                detail={analysis?.installPlan ? `${analysis.installPlan.command} will run automatically.` : "No dependency installer was detected for this folder."}
              />
              <Capability
                active={Boolean(analysis?.supportsExe)}
                title="EXE or App Package"
                detail={analysis?.supportsExe ? "Desktop packaging support was detected." : "This project does not currently expose desktop executable packaging."}
              />
              <Capability
                active={Boolean(analysis?.supportsInstaller)}
                title="Installer"
                detail={analysis?.supportsInstaller ? "Installer-capable Electron build script found." : "Installer output needs electron-builder, Forge, or another installer setup."}
              />
            </div>

            <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-6">
              <Terminal logs={logs} />

              <div className="space-y-5">
                <section className="rounded-3xl border border-white/10 bg-white/[0.055] p-5 backdrop-blur-2xl">
                  <h3 className="mb-3 text-lg font-semibold">Project Health</h3>
                  <InfoLine label="Dependency state" value={analysis?.nodeHealth?.recommendation || "No Node dependency scan"} />
                  <InfoLine label="Cleanup targets" value={analysis ? analysis.cleanTargets.length : "-"} />
                  <InfoLine label="Build command" value={analysis?.buildPlan.commands[0] || "None"} />
                  <InfoLine label="Known scripts" value={scriptNames.length > 0 ? scriptNames.join(", ") : "None"} />
                </section>

                <section className="rounded-3xl border border-white/10 bg-white/[0.055] p-5 backdrop-blur-2xl">
                  <h3 className="mb-3 text-lg font-semibold">Outputs</h3>
                  <AnimatePresence mode="popLayout">
                    {outputs.length > 0 ? (
                      outputs.map((output) => (
                        <motion.button
                          layout
                          key={output.path}
                          type="button"
                          onClick={() => openOutput(output.path)}
                          initial={{ opacity: 0, x: 18 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: -18 }}
                          className="mb-3 w-full rounded-2xl border border-white/10 bg-black/22 p-4 text-left transition hover:border-cyan-200/30 hover:bg-cyan-300/8"
                        >
                          <span className="block font-semibold text-slate-100">{output.name}</span>
                          <span className="mt-1 block truncate text-xs text-slate-500">{output.path}</span>
                        </motion.button>
                      ))
                    ) : (
                      <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="rounded-2xl border border-white/8 bg-black/18 p-4 text-sm leading-6 text-slate-500">
                        Outputs will appear here after detection or a successful build.
                      </motion.p>
                    )}
                  </AnimatePresence>
                </section>
              </div>
            </div>

            <AnimatePresence>
              {error ? (
                <motion.div
                  initial={{ opacity: 0, y: 18 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 18 }}
                  className="mt-6 rounded-3xl border border-rose-300/20 bg-rose-400/10 p-5 text-rose-100"
                >
                  <div className="font-semibold">Operation failed</div>
                  <p className="mt-2 text-sm leading-6 text-rose-100/80">{error}</p>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </section>
        </div>
      </main>
    </div>
  );
}