import { Button, Icon, ICONS, Toggle, Wordmark } from "@uwusuite/design";
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

/** The window controls' 10 px glyphs, the same as in the package's title bar. */
function Glyph({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 10 10" className="glyph" aria-hidden>
      <path d={path} />
    </svg>
  );
}

/** The package's pill button, a size bigger, as the installer's one big action. */
function SetupButton({
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
    <Button
      size="lg"
      variant={variant === "primary" ? "primary" : "ghost"}
      autoFocus={autoFocus}
      disabled={disabled}
      onClick={onClick}
      className={clsx("px-6 text-reading", variant === "quiet" && "text-plum-soft hover:bg-white/70 hover:text-plum")}
    >
      {children}
    </Button>
  );
}

/** One setting on the card: the package's Toggle, with the hint in the installer's plum. */
function SetupToggle({
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
    <div className="rounded-2xl px-2 py-2 hover:bg-pink-tint/60 [&_.text-muted]:text-plum-soft">
      <Toggle checked={checked} onChange={onChange} label={label} description={hint} />
    </div>
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
  return (
    <div className="setup-sparkles flex h-full flex-col">
      <header data-tauri-drag-region className="flex h-11 shrink-0 items-center gap-1 px-2">
        <span data-tauri-drag-region className="mr-auto pl-3">
          <Wordmark product="Mail" shell="mail" className="text-body" />
        </span>
        <button
          type="button"
          className="setup-control"
          onClick={onToggleSound}
          title={muted ? t.soundOn : t.soundOff}
          aria-label={muted ? t.soundOn : t.soundOff}
        >
          <Icon icon={muted ? ICONS.soundOff : ICONS.sound} />
        </button>
        <button
          type="button"
          className="setup-control"
          onClick={() => void api.minimize()}
          title={t.minimize}
          aria-label={t.minimize}
        >
          <Glyph path="M0 5.5h10" />
        </button>
        <button
          type="button"
          className="setup-control"
          data-kind="close"
          disabled={busy}
          onClick={() => void api.finish()}
          title={t.close}
          aria-label={t.close}
        >
          <Glyph path="M.5.5l9 9 M9.5.5l-9 9" />
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
        <p className="max-w-[340px] pt-1.5 text-center text-[14px] leading-relaxed text-plum-soft">{body}</p>
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
  const windows = info.platform === "windows";
  const pick = <T,>(forWindows: T, forMac: T, forLinux: T) =>
    info.platform === "macos" ? forMac : info.platform === "linux" ? forLinux : forWindows;
  const device = pick(t.devicePc, t.deviceMac, t.deviceComputer);

  if (screen === "welcome") {
    return shell(
      <>
        <Stage
          scene={<WelcomeScene />}
          compact={showOptions}
          title={installed ? t.againTitle : t.welcomeTitle}
          body={
            installed
              ? fill(t.againBody, { installed: installed.version ?? "", version: info.version })
              : fill(t.welcomeBody, { device })
          }
        />
        <div className="flex flex-col items-center gap-2 pt-5">
          <SetupButton onClick={startInstall} autoFocus disabled={!info.hasPayload}>
            {actionLabel} ♡
          </SetupButton>
          <button
            type="button"
            onClick={() => setShowOptions(!showOptions)}
            aria-expanded={showOptions}
            className="flex items-center gap-1 rounded-full px-3 py-1 text-[13px] font-bold text-plum-soft hover:text-plum"
          >
            {showOptions ? t.fewerOptions : t.options}
            <Icon
              icon={ICONS.expand}
              size="xs"
              className={clsx("transition-transform", !showOptions && "-rotate-90")}
            />
          </button>
        </div>
        {showOptions && (
          <div className="setup-card setup-fade mt-1 w-full rounded-[22px] p-3">
            <div className="flex items-center gap-2 px-2 pb-1">
              <Icon icon={ICONS.folder} className="text-pink" />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-bold text-plum-soft">{t.folder}</span>
                <span className="block truncate text-[13px] font-semibold" title={options.dir}>
                  {options.dir}
                </span>
              </span>
              {/* macOS and Linux have one fixed place for a user's apps. */}
              {windows && (
                <button
                  type="button"
                  className="shrink-0 rounded-full px-3 py-1 text-[12.5px] font-bold text-pink-solid hover:bg-pink-tint"
                  onClick={async () => {
                    const dir = await api.pickFolder(options.dir);
                    if (dir) setOptions({ ...options, dir });
                  }}
                >
                  {t.change}
                </button>
              )}
            </div>
            {windows && (
              <SetupToggle
                checked={options.desktopShortcut}
                onChange={(desktopShortcut) => setOptions({ ...options, desktopShortcut })}
                label={t.desktopShortcut}
              />
            )}
            <SetupToggle
              checked={options.autostart}
              onChange={(autostart) => setOptions({ ...options, autostart })}
              label={pick(t.autostart, t.autostartMac, t.autostartLinux)}
              hint={pick(t.autostartHint, t.autostartHintMac, t.autostartHintLinux)}
            />
            <SetupToggle
              checked={options.defaultMailApp}
              onChange={(defaultMailApp) => setOptions({ ...options, defaultMailApp })}
              label={t.defaultMailApp}
              hint={pick(t.defaultMailAppHint, t.defaultMailAppHintMac, t.defaultMailAppHintLinux)}
            />
            {/* Windows uninstalls from its "Installed apps" list; elsewhere the setup does it. */}
            {installed && !windows && (
              <button
                type="button"
                onClick={() => setScreen("uninstall")}
                className="mt-1 w-full rounded-2xl px-2 py-2 text-left text-[12.5px] font-bold text-plum-soft hover:text-plum"
              >
                {t.uninstallLink}
              </button>
            )}
          </div>
        )}
        <p className="mt-auto pt-3 text-center text-[11.5px] text-plum-soft">
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
          <SetupButton
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
          </SetupButton>
          <SetupButton variant="quiet" onClick={() => setScreen("welcome")}>
            {t.back}
          </SetupButton>
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
          <div className="flex items-center justify-between pt-2.5 text-[13px] font-semibold text-plum-soft">
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
                <Icon icon={ICONS.done} size="xs" className="mt-0.5 text-pink" />
                {tip}
              </li>
            ))}
          </ul>
          {options.defaultMailApp && info.platform !== "linux" && (
            <p className="mt-2 rounded-xl bg-pink-tint px-3 py-2 text-[12px] font-semibold">
              {windows ? t.defaultAppsHint : t.defaultAppsHintMac}
            </p>
          )}
        </div>
        <div className="mt-auto flex items-center gap-2 pt-3">
          <SetupButton variant="quiet" onClick={() => void api.finish()}>
            {t.close}
          </SetupButton>
          <SetupButton
            autoFocus
            onClick={async () => {
              await api.launchApp();
              await api.finish();
            }}
          >
            {t.start}
          </SetupButton>
        </div>
      </>,
    );
  }

  if (screen === "error") {
    return shell(
      <>
        <Stage scene={<ErrorScene />} title={t.errorTitle} />
        <p className="selectable mt-3 w-full rounded-2xl bg-white/80 px-4 py-3 text-center text-[12.5px] break-words text-plum-soft select-text">
          {error}
        </p>
        <div className="flex items-center gap-2 pt-5">
          <SetupButton
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
          </SetupButton>
          <SetupButton autoFocus onClick={() => void run(job, options, info, keepData)}>
            {t.retry}
          </SetupButton>
        </div>
      </>,
    );
  }

  if (screen === "uninstall") {
    return shell(
      <>
        <Stage scene={<GoodbyeScene />} title={t.uninstallTitle} body={fill(t.uninstallBody, { device })} />
        <div className="setup-card mt-5 w-full rounded-[22px] p-2">
          <SetupToggle checked={keepData} onChange={setKeepData} label={t.keepData} hint={t.keepDataHint} />
        </div>
        <div className="mt-auto flex items-center gap-2 pt-3">
          <SetupButton
            variant="quiet"
            onClick={() => (info.mode === "uninstall" ? void api.finish() : setScreen("welcome"))}
          >
            {t.keep}
          </SetupButton>
          <SetupButton autoFocus onClick={() => void run("uninstall", options, info, keepData)}>
            {t.uninstall}
          </SetupButton>
        </div>
      </>,
    );
  }

  return shell(
    <div className="my-auto flex w-full flex-col items-center pb-10">
      <Stage scene={<GoodbyeScene />} title={t.goodbyeTitle} body={t.goodbyeBody} />
      <div className="pt-6">
        <SetupButton autoFocus onClick={() => void api.finish()}>
          {t.close}
        </SetupButton>
      </div>
    </div>,
  );
}
