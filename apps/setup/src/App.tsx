import clsx from "clsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Info, type Options } from "./api";
import { DoneScene, ErrorScene, GoodbyeScene, PuzzledScene, WelcomeScene, WorkingScene } from "./scenes";
import { pling } from "./sound";
import { fill, texts as t } from "./texts";

type Screen = "loading" | "welcome" | "running" | "working" | "done" | "error" | "uninstall" | "goodbye";
type Job = "install" | "update" | "uninstall";

/** Long enough to see Nyu at work, even when copying takes a split second. */
const MIN_WORKING_MS = 1800;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function Icon({ path, className }: { path: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={clsx("size-4", className)} fill="none" stroke="currentColor" strokeWidth={2.2}>
      <path d={path} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const ICONS = {
  soundOn: "M4 9v6h4l5 4V5L8 9H4Z M16.5 8.5a5 5 0 0 1 0 7 M19 6a8.5 8.5 0 0 1 0 12",
  soundOff: "M4 9v6h4l5 4V5L8 9H4Z M17 9l5 6 M22 9l-5 6",
  minimize: "M6 12h12",
  close: "M7 7l10 10 M17 7L7 17",
  chevron: "M9 6l6 6-6 6",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  check: "M5 12.5l4.5 4.5L19 7.5",
};

function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  autoFocus,
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: "primary" | "quiet";
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <button
      type="button"
      autoFocus={autoFocus}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "h-11 rounded-full px-6 text-[15px] font-extrabold transition active:scale-[0.97] disabled:opacity-50",
        variant === "primary"
          ? "bg-pink-solid text-white shadow-[0_10px_22px_-10px_rgb(225_29_116/0.8)] hover:bg-pink-solid-hover"
          : "text-plum-soft hover:text-plum hover:bg-white/70",
      )}
    >
      {children}
    </button>
  );
}

function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="hover:bg-blush/60 flex w-full items-center gap-3 rounded-2xl px-2 py-2 text-left"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-bold">{label}</span>
        {hint && <span className="text-plum-soft block text-[12px] leading-snug">{hint}</span>}
      </span>
      <span
        className={clsx(
          "relative h-6 w-10 shrink-0 rounded-full transition-colors",
          checked ? "bg-pink-solid" : "bg-[#ecd9e3]",
        )}
      >
        <span
          className={clsx(
            "absolute top-1 size-4 rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-5" : "translate-x-1",
          )}
        />
      </span>
    </button>
  );
}

function Window({
  children,
  busy,
  muted,
  onToggleSound,
}: {
  children: ReactNode;
  busy: boolean;
  muted: boolean;
  onToggleSound: () => void;
}) {
  const control = "grid size-8 place-items-center rounded-full text-plum-soft hover:bg-white/80 hover:text-plum";
  return (
    <div className="setup-sparkles flex h-full flex-col">
      <header data-tauri-drag-region className="flex h-11 shrink-0 items-center gap-1 px-2">
        <span data-tauri-drag-region className="mr-auto pl-3 text-[14px] font-extrabold tracking-tight">
          UwU<span className="text-pink">Mail</span>
        </span>
        <button type="button" className={control} onClick={onToggleSound} aria-label={muted ? t.soundOn : t.soundOff}>
          <Icon path={muted ? ICONS.soundOff : ICONS.soundOn} />
        </button>
        <button type="button" className={control} onClick={() => void api.minimize()} aria-label={t.minimize}>
          <Icon path={ICONS.minimize} />
        </button>
        <button
          type="button"
          className={clsx(control, "hover:bg-pink-solid! hover:text-white!")}
          disabled={busy}
          onClick={() => void api.finish()}
          aria-label={t.close}
        >
          <Icon path={ICONS.close} />
        </button>
      </header>
      <main className="flex min-h-0 flex-1 flex-col items-center px-7 pb-5">{children}</main>
    </div>
  );
}

function Stage({ scene, title, body, compact }: { scene: ReactNode; title: string; body?: string; compact?: boolean }) {
  return (
    <div className="setup-fade flex w-full flex-col items-center">
      <div className={clsx("pt-1 transition-[width] duration-300", compact ? "w-[168px]" : "w-[272px]")}>{scene}</div>
      <h1 className="pt-3 text-center text-[24px] leading-tight font-extrabold tracking-tight">{title}</h1>
      {body && !compact && (
        <p className="text-plum-soft max-w-[340px] pt-1.5 text-center text-[14px] leading-relaxed">{body}</p>
      )}
    </div>
  );
}

export function App() {
  const [info, setInfo] = useState<Info | null>(null);
  const [screen, setScreen] = useState<Screen>("loading");
  const [options, setOptions] = useState<Options | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [job, setJob] = useState<Job>("install");
  const [target, setTarget] = useState(0);
  const [shown, setShown] = useState(0);
  const [quote, setQuote] = useState(0);
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [keepData, setKeepData] = useState(true);
  const mutedRef = useRef(muted);
  const started = useRef(false);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const run = async (kind: Job, chosen: Options, loaded: Info, keep = true) => {
    setJob(kind);
    setTarget(0);
    setShown(0);
    setError("");
    setScreen("working");
    const begin = Date.now();
    try {
      if (kind === "uninstall") await api.uninstall(keep);
      else await api.install(chosen);
      await wait(Math.max(0, MIN_WORKING_MS - (Date.now() - begin)));
      setTarget(1);
      await wait(350);
      setScreen(kind === "uninstall" ? "goodbye" : "done");
      if (!mutedRef.current) pling();
      if (kind === "install" && chosen.defaultMailApp) void api.openDefaultApps();
      if (kind === "update") {
        await wait(1800);
        if (loaded.relaunch) await api.launchApp();
        await api.finish();
      }
    } catch (reason) {
      setError(typeof reason === "string" ? reason : String(reason));
      setScreen("error");
    }
  };
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });

  useEffect(() => {
    let cancelled = false;
    void api.info().then((loaded) => {
      if (cancelled) return;
      setInfo(loaded);
      setOptions(loaded.options);
      if (loaded.mode === "uninstall") {
        setScreen("uninstall");
      } else if (loaded.mode === "update") {
        // Strict mode runs effects twice in development; start only once.
        if (!started.current) {
          started.current = true;
          void runRef.current("update", loaded.options, loaded);
        }
      } else {
        setScreen("welcome");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => api.onProgress((progress) => setTarget((current) => Math.max(current, progress.overall))), []);

  // Glide towards the reported progress instead of jumping.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      setShown((current) => {
        const next = current + (target - current) * 0.14;
        return Math.abs(target - next) < 0.003 ? target : next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);

  useEffect(() => {
    if (screen !== "working") return;
    const timer = setInterval(() => setQuote((current) => (current + 1) % t.quotes.length), 2000);
    return () => clearInterval(timer);
  }, [screen]);

  const busy = screen === "working";
  const shell = (content: ReactNode) => (
    <Window busy={busy} muted={muted} onToggleSound={() => setMuted(!muted)}>
      {content}
    </Window>
  );

  if (!info || !options || screen === "loading") return shell(null);

  const installed = info.installed && !info.installed.legacy ? info.installed : null;
  const actionLabel = !installed ? t.install : installed.version === info.version ? t.reinstall : t.update;
  const startInstall = () => {
    if (info.appRunning) setScreen("running");
    else void run("install", options, info);
  };

  if (screen === "welcome") {
    return shell(
      <>
        <Stage
          scene={<WelcomeScene />}
          compact={showOptions}
          title={installed ? t.againTitle : t.welcomeTitle}
          body={
            installed ? fill(t.againBody, { installed: installed.version ?? "", version: info.version }) : t.welcomeBody
          }
        />
        <div className="flex flex-col items-center gap-2 pt-5">
          <Button onClick={startInstall} autoFocus disabled={!info.hasPayload}>
            {actionLabel} ♡
          </Button>
          <button
            type="button"
            onClick={() => setShowOptions(!showOptions)}
            aria-expanded={showOptions}
            className="text-plum-soft hover:text-plum flex items-center gap-1 rounded-full px-3 py-1 text-[13px] font-bold"
          >
            {showOptions ? t.fewerOptions : t.options}
            <Icon path={ICONS.chevron} className={clsx("size-3.5 transition-transform", showOptions && "rotate-90")} />
          </button>
        </div>
        {showOptions && (
          <div className="setup-card setup-fade mt-1 w-full rounded-[22px] p-3">
            <div className="flex items-center gap-2 px-2 pb-1">
              <Icon path={ICONS.folder} className="size-4 shrink-0 text-pink" />
              <span className="min-w-0 flex-1">
                <span className="text-plum-soft block text-[12px] font-bold">{t.folder}</span>
                <span className="block truncate text-[13px] font-semibold" title={options.dir}>
                  {options.dir}
                </span>
              </span>
              <button
                type="button"
                className="hover:bg-blush shrink-0 rounded-full px-3 py-1 text-[12.5px] font-bold text-pink-solid"
                onClick={async () => {
                  const dir = await api.pickFolder(options.dir);
                  if (dir) setOptions({ ...options, dir });
                }}
              >
                {t.change}
              </button>
            </div>
            <Switch
              checked={options.desktopShortcut}
              onChange={(desktopShortcut) => setOptions({ ...options, desktopShortcut })}
              label={t.desktopShortcut}
            />
            <Switch
              checked={options.autostart}
              onChange={(autostart) => setOptions({ ...options, autostart })}
              label={t.autostart}
              hint={t.autostartHint}
            />
            <Switch
              checked={options.defaultMailApp}
              onChange={(defaultMailApp) => setOptions({ ...options, defaultMailApp })}
              label={t.defaultMailApp}
              hint={t.defaultMailAppHint}
            />
          </div>
        )}
        <p className="text-plum-soft mt-auto pt-3 text-center text-[11.5px]">
          {!info.hasPayload ? t.devBuild : info.sandbox ? t.sandbox : fill(t.footer, { version: info.version })}
        </p>
      </>,
    );
  }

  if (screen === "running") {
    return shell(
      <div className="my-auto flex w-full flex-col items-center pb-10">
        <Stage scene={<PuzzledScene />} title={t.runningTitle} body={t.runningBody} />
        <div className="flex flex-col items-center gap-1 pt-6">
          <Button
            autoFocus
            onClick={async () => {
              try {
                await api.closeApp();
                void run("install", options, info);
              } catch (reason) {
                setError(String(reason));
                setScreen("error");
              }
            }}
          >
            {t.closeAndContinue}
          </Button>
          <Button variant="quiet" onClick={() => setScreen("welcome")}>
            {t.back}
          </Button>
        </div>
      </div>,
    );
  }

  if (screen === "working") {
    const title = job === "uninstall" ? t.progressUninstall : job === "update" ? t.progressUpdate : t.progressInstall;
    const percent = Math.round(shown * 100);
    return shell(
      <div className="my-auto flex w-full flex-col items-center pb-10">
        <Stage scene={<WorkingScene />} title={title} />
        <div className="w-full max-w-[340px] pt-7">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-4 overflow-hidden rounded-full bg-white/80 p-[3px] shadow-[inset_0_1px_3px_rgb(75_29_63/0.12)]"
          >
            <div className="setup-bar h-full rounded-full" style={{ width: `${Math.max(6, percent)}%` }} />
          </div>
          <div className="text-plum-soft flex items-center justify-between pt-2.5 text-[13px] font-semibold">
            <span key={quote} className="setup-fade">
              {t.quotes[quote]}
            </span>
            <span className="tabular-nums">{percent} %</span>
          </div>
        </div>
      </div>,
    );
  }

  if (screen === "done") {
    if (job === "update") {
      return shell(
        <div className="my-auto w-full pb-10">
          <Stage
            scene={<DoneScene />}
            title={t.updateDoneTitle}
            body={fill(t.updateDoneBody, { version: info.version })}
          />
        </div>,
      );
    }
    return shell(
      <>
        <Stage scene={<DoneScene />} title={t.doneTitle} body={t.doneBody} />
        <div className="setup-card setup-fade mt-4 w-full rounded-[22px] px-4 py-3">
          <p className="pb-1 text-[12px] font-extrabold tracking-wide text-pink-solid uppercase">{t.tipsTitle}</p>
          <ul className="flex flex-col gap-1.5">
            {t.tips.map((tip) => (
              <li key={tip} className="flex gap-2 text-[13px] leading-snug">
                <Icon path={ICONS.check} className="mt-0.5 size-3.5 shrink-0 text-pink" />
                {tip}
              </li>
            ))}
          </ul>
          {options.defaultMailApp && (
            <p className="bg-blush mt-2 rounded-xl px-3 py-2 text-[12px] font-semibold">{t.defaultAppsHint}</p>
          )}
        </div>
        <div className="mt-auto flex items-center gap-2 pt-3">
          <Button variant="quiet" onClick={() => void api.finish()}>
            {t.close}
          </Button>
          <Button
            autoFocus
            onClick={async () => {
              await api.launchApp();
              await api.finish();
            }}
          >
            {t.start}
          </Button>
        </div>
      </>,
    );
  }

  if (screen === "error") {
    return shell(
      <>
        <Stage scene={<ErrorScene />} title={t.errorTitle} />
        <p className="selectable text-plum-soft mt-3 w-full rounded-2xl bg-white/80 px-4 py-3 text-center text-[12.5px] break-words select-text">
          {error}
        </p>
        <div className="flex items-center gap-2 pt-5">
          <Button
            variant="quiet"
            onClick={() =>
              void (async () => {
                // UwUMail closed itself for the update; bring the installed version back.
                if (job === "update" && info.relaunch) await api.launchApp().catch(() => undefined);
                await api.finish();
              })()
            }
          >
            {t.close}
          </Button>
          <Button autoFocus onClick={() => void run(job, options, info, keepData)}>
            {t.retry}
          </Button>
        </div>
      </>,
    );
  }

  if (screen === "uninstall") {
    return shell(
      <>
        <Stage scene={<GoodbyeScene />} title={t.uninstallTitle} body={t.uninstallBody} />
        <div className="setup-card mt-5 w-full rounded-[22px] p-2">
          <Switch checked={keepData} onChange={setKeepData} label={t.keepData} hint={t.keepDataHint} />
        </div>
        <div className="mt-auto flex items-center gap-2 pt-3">
          <Button variant="quiet" onClick={() => void api.finish()}>
            {t.keep}
          </Button>
          <Button autoFocus onClick={() => void run("uninstall", options, info, keepData)}>
            {t.uninstall}
          </Button>
        </div>
      </>,
    );
  }

  return shell(
    <div className="my-auto flex w-full flex-col items-center pb-10">
      <Stage scene={<GoodbyeScene />} title={t.goodbyeTitle} body={t.goodbyeBody} />
      <div className="pt-6">
        <Button autoFocus onClick={() => void api.finish()}>
          {t.close}
        </Button>
      </div>
    </div>,
  );
}
