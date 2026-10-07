"use client";

/**
 * Top 1 - one-page priority engine (Next.js App Router: app/page.tsx)
 * Deps: framer-motion, lucide-react.  Styling: inline CSS only.
 *
 * Method implemented:
 *  1. Timeline        -> planned schedule from "now" with due markers
 *  2. Priority tasks  -> each task has an estimate and optional due time
 *  3. Rank at now     -> importance, urgency (raised automatically by deadlines),
 *                        consequence of neglect, opportunity
 *  4. Execute leader  -> one active task; interrupt only when switching/stopping wins
 *  5. Metrics         -> valuable output, waiting time, context switches
 *
 * Persistence: localStorage, every session / wait / event is timestamped (epoch ms),
 * so timers survive reloads and sleeping tabs.
 */

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowRightLeft,
  Check,
  ChevronDown,
  Download,
  Hourglass,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  Undo2,
} from "lucide-react";

/* ----------------------------- types ----------------------------- */

type Rating = 1 | 2 | 3 | 4 | 5;
type RateKey = "importance" | "urgency" | "consequence" | "opportunity";
type Status = "todo" | "waiting" | "done";

interface Task {
  id: string;
  title: string;
  importance: Rating;
  urgency: Rating;
  consequence: Rating;
  opportunity: Rating;
  estMin: number;
  due: number | null;
  createdAt: number;
  status: Status;
  doneAt: number | null;
}
interface Span {
  id: string;
  taskId: string;
  start: number;
  end: number | null;
}
type LogType = "add" | "start" | "switch" | "pause" | "wait" | "unblock" | "done" | "reopen" | "remove";
interface LogEntry {
  id: string;
  t: number;
  type: LogType;
  taskId: string;
  title: string;
  note?: string;
}
interface State {
  tasks: Task[];
  sessions: Span[]; // focus time (end === null -> running)
  waits: Span[]; // blocked time (end === null -> still waiting)
  log: LogEntry[];
}
interface Row {
  task: Task;
  activeMs: number;
  score: number;
  urgency: number;
  raisedByDeadline: boolean;
}
interface Advice {
  kind: "switch" | "overrun";
  key: string;
  text: string;
  target?: Row;
}

/* ----------------------------- constants ----------------------------- */

const KEY = "top1:v1";
const SWITCH_MARGIN = 12; // a rival must beat the active task by this many points
const EMPTY: State = { tasks: [], sessions: [], waits: [], log: [] };

const C = {
  bg: "#E8ECF3",
  surface: "#F8F9FC",
  ink: "#101A2C",
  muted: "#5B6679",
  line: "#CBD3E1",
  track: "#EAEEF6",
  blue: "#2447D6",
  blueSoft: "#8CA0E8",
  amber: "#B7791F",
  red: "#C0293B",
  green: "#26805A",
};
const HEAD = `"Bricolage Grotesque", "Segoe UI", system-ui, sans-serif`;
const BODY = `"Instrument Sans", "Segoe UI", system-ui, sans-serif`;

const RATINGS: { key: RateKey; label: string; hint: string }[] = [
  { key: "importance", label: "Importance", hint: "Value if it gets done" },
  { key: "urgency", label: "Urgency", hint: "How soon it matters" },
  { key: "consequence", label: "Consequence of neglect", hint: "Cost of leaving it" },
  { key: "opportunity", label: "Opportunity", hint: "Upside that may expire" },
];

/* ----------------------------- helpers ----------------------------- */

const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const pad = (n: number) => String(n).padStart(2, "0");
const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const fmtTimer = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
};
const fmtDur = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
};
const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtDay = (ms: number, now: number) => {
  const diff = Math.round((startOfDay(ms) - startOfDay(now)) / 86400000);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  return new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
};
const fmtDue = (due: number, now: number) =>
  due < now ? `Overdue by ${fmtDur(now - due)}` : `Due ${fmtDay(due, now)} ${fmtClock(due)}`;

const overlap = (spans: Span[], now: number, from: number, taskId?: string) =>
  spans.reduce((acc, s) => {
    if (taskId && s.taskId !== taskId) return acc;
    return acc + Math.max(0, (s.end ?? now) - Math.max(s.start, from));
  }, 0);

/** Urgency is the higher of what you set and what the deadline demands right now. */
function scoreTask(task: Task, activeMs: number, now: number): Row {
  let derived = 1;
  if (task.due !== null) {
    const remaining = Math.max(5, task.estMin - activeMs / 60000) * 60000;
    const slackH = (task.due - now - remaining) / 3600000;
    derived = slackH <= 0 ? 5 : slackH < 1 ? 4.5 : slackH < 4 ? 4 : slackH < 24 ? 3 : slackH < 72 ? 2 : 1;
  }
  const urgency = Math.max(task.urgency, derived);
  const score = ((task.importance * 0.3 + urgency * 0.3 + task.consequence * 0.25 + task.opportunity * 0.15) / 5) * 100;
  return { task, activeMs, score, urgency, raisedByDeadline: derived > task.urgency };
}
const byRank = (a: Row, b: Row) =>
  b.score - a.score ||
  (a.task.due ?? 9e15) - (b.task.due ?? 9e15) ||
  a.task.createdAt - b.task.createdAt;

/* ----------------------------- state ----------------------------- */

type Action =
  | { type: "hydrate"; state: State }
  | { type: "add"; task: Task }
  | { type: "start"; id: string; t: number }
  | { type: "pause"; t: number }
  | { type: "wait"; id: string; t: number }
  | { type: "unblock"; id: string; t: number }
  | { type: "done"; id: string; t: number }
  | { type: "reopen"; id: string; t: number }
  | { type: "remove"; id: string; t: number }
  | { type: "rate"; id: string; key: RateKey; value: Rating }
  | { type: "reset" };

const closeSpans = (spans: Span[], t: number, taskId?: string): Span[] =>
  spans.map((s) => (s.end === null && (!taskId || s.taskId === taskId) ? { ...s, end: t } : s));
const entry = (t: number, type: LogType, task: Task, note?: string): LogEntry => ({
  id: uid(),
  t,
  type,
  taskId: task.id,
  title: task.title,
  note,
});
const withLog = (s: State, e: LogEntry): LogEntry[] => [...s.log, e].slice(-400);
const setStatus = (tasks: Task[], id: string, patch: Partial<Task>) =>
  tasks.map((x) => (x.id === id ? { ...x, ...patch } : x));

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "hydrate":
      return a.state;
    case "reset":
      return EMPTY;
    case "add":
      return { ...s, tasks: [...s.tasks, a.task], log: withLog(s, entry(a.task.createdAt, "add", a.task)) };
    case "rate":
      return { ...s, tasks: setStatus(s.tasks, a.id, { [a.key]: a.value }) };
    case "start": {
      const task = s.tasks.find((x) => x.id === a.id);
      if (!task || task.status === "done") return s;
      const open = s.sessions.find((x) => x.end === null);
      if (open?.taskId === a.id) return s;
      const from = open ? s.tasks.find((x) => x.id === open.taskId) : undefined;
      const e = open
        ? entry(a.t, "switch", task, from ? `left \u201C${from.title}\u201D` : undefined)
        : entry(a.t, "start", task);
      return {
        tasks: setStatus(s.tasks, a.id, { status: "todo" }),
        sessions: [...closeSpans(s.sessions, a.t), { id: uid(), taskId: a.id, start: a.t, end: null }],
        waits: task.status === "waiting" ? closeSpans(s.waits, a.t, a.id) : s.waits,
        log: withLog(s, e),
      };
    }
    case "pause": {
      const open = s.sessions.find((x) => x.end === null);
      const task = open && s.tasks.find((x) => x.id === open.taskId);
      if (!open || !task) return s;
      return { ...s, sessions: closeSpans(s.sessions, a.t), log: withLog(s, entry(a.t, "pause", task)) };
    }
    case "wait": {
      const task = s.tasks.find((x) => x.id === a.id);
      if (!task || task.status !== "todo") return s;
      return {
        tasks: setStatus(s.tasks, a.id, { status: "waiting" }),
        sessions: closeSpans(s.sessions, a.t, a.id),
        waits: [...s.waits, { id: uid(), taskId: a.id, start: a.t, end: null }],
        log: withLog(s, entry(a.t, "wait", task)),
      };
    }
    case "unblock": {
      const task = s.tasks.find((x) => x.id === a.id);
      if (!task || task.status !== "waiting") return s;
      return {
        ...s,
        tasks: setStatus(s.tasks, a.id, { status: "todo" }),
        waits: closeSpans(s.waits, a.t, a.id),
        log: withLog(s, entry(a.t, "unblock", task)),
      };
    }
    case "done": {
      const task = s.tasks.find((x) => x.id === a.id);
      if (!task || task.status === "done") return s;
      return {
        tasks: setStatus(s.tasks, a.id, { status: "done", doneAt: a.t }),
        sessions: closeSpans(s.sessions, a.t, a.id),
        waits: closeSpans(s.waits, a.t, a.id),
        log: withLog(s, entry(a.t, "done", task)),
      };
    }
    case "reopen": {
      const task = s.tasks.find((x) => x.id === a.id);
      if (!task || task.status !== "done") return s;
      return {
        ...s,
        tasks: setStatus(s.tasks, a.id, { status: "todo", doneAt: null }),
        log: withLog(s, entry(a.t, "reopen", task)),
      };
    }
    case "remove": {
      const task = s.tasks.find((x) => x.id === a.id);
      if (!task) return s;
      return {
        tasks: s.tasks.filter((x) => x.id !== a.id),
        sessions: s.sessions.filter((x) => x.taskId !== a.id),
        waits: s.waits.filter((x) => x.taskId !== a.id),
        log: withLog(s, entry(a.t, "remove", task)),
      };
    }
  }
}

function load(): State | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<State>;
    if (Array.isArray(p.tasks) && Array.isArray(p.sessions) && Array.isArray(p.waits) && Array.isArray(p.log)) {
      return p as State;
    }
  } catch {
    /* corrupted or blocked storage -> start clean */
  }
  return null;
}

/* ----------------------------- small components ----------------------------- */

/** Ticks on its own so the page doesn't re-render every second. */
function Live({ read, every = 1000 }: { read: (now: number) => string; every?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, every);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [every]);
  return <>{read(now)}</>;
}

type Variant = "solid" | "ghost" | "onBlue" | "danger";
const variantStyle: Record<Variant, CSSProperties> = {
  solid: { background: C.blue, color: "#fff", borderColor: C.blue },
  ghost: { background: "transparent", color: C.ink, borderColor: C.line },
  onBlue: { background: "rgba(255,255,255,0.16)", color: "#fff", borderColor: "rgba(255,255,255,0.35)" },
  danger: { background: "transparent", color: C.red, borderColor: C.line },
};
function Btn(props: {
  variant?: Variant;
  icon?: ReactNode;
  children?: ReactNode;
  onClick?: () => void;
  title?: string;
  type?: "button" | "submit";
}) {
  const { variant = "ghost", icon, children, onClick, title, type = "button" } = props;
  return (
    <motion.button
      type={type}
      title={title}
      aria-label={title}
      onClick={onClick}
      whileTap={{ scale: 0.96 }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        minHeight: 40,
        minWidth: 40,
        padding: children ? "0 14px" : "0 10px",
        borderRadius: 10,
        border: "1px solid",
        fontFamily: BODY,
        fontWeight: 600,
        fontSize: 14,
        cursor: "pointer",
        ...variantStyle[variant],
      }}
    >
      {icon}
      {children}
    </motion.button>
  );
}

function RatingInput(p: { label: string; hint: string; value: Rating; onChange: (v: Rating) => void }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{p.label}</span>
        <span style={{ fontSize: 12, color: C.muted }}>{p.hint}</span>
      </div>
      <div role="radiogroup" aria-label={p.label} style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 4 }}>
        {([1, 2, 3, 4, 5] as Rating[]).map((n) => {
          const on = p.value === n;
          return (
            <motion.button
              key={n}
              type="button"
              role="radio"
              aria-checked={on}
              whileTap={{ scale: 0.94 }}
              onClick={() => p.onChange(n)}
              style={{
                minHeight: 40,
                borderRadius: 8,
                border: `1px solid ${on ? C.blue : C.line}`,
                background: on ? C.blue : "#fff",
                color: on ? "#fff" : C.ink,
                fontFamily: BODY,
                fontWeight: 600,
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              {n}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}

const card: CSSProperties = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16 };
const h3: CSSProperties = { fontFamily: HEAD, fontSize: 19, fontWeight: 700, margin: 0, letterSpacing: "-0.01em" };
const sub: CSSProperties = { fontSize: 13, color: C.muted, margin: "4px 0 0" };
const ellipsis: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 };
const inputStyle: CSSProperties = {
  minHeight: 44,
  borderRadius: 10,
  border: `1px solid ${C.line}`,
  background: "#fff",
  padding: "0 12px",
  fontFamily: BODY,
  fontSize: 15,
  color: C.ink,
  width: "100%",
  boxSizing: "border-box",
};

/* ----------------------------- page ----------------------------- */

export default function Page() {
  const [state, dispatch] = useReducer(reducer, EMPTY);
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState(0); // coarse clock for ranking (15s)
  const [openId, setOpenId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const lastSaved = useRef("");

  const [title, setTitle] = useState("");
  const [est, setEst] = useState("25");
  const [due, setDue] = useState("");
  const [draft, setDraft] = useState<Record<RateKey, Rating>>({
    importance: 3,
    urgency: 3,
    consequence: 3,
    opportunity: 3,
  });

  /* load + cross-tab sync */
  useEffect(() => {
    const s = load();
    if (s) {
      lastSaved.current = JSON.stringify(s);
      dispatch({ type: "hydrate", state: s });
    }
    setReady(true);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== KEY || !e.newValue || e.newValue === lastSaved.current) return;
      const next = load();
      if (next) {
        lastSaved.current = e.newValue;
        dispatch({ type: "hydrate", state: next });
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  /* persist */
  useEffect(() => {
    if (!ready) return;
    const raw = JSON.stringify(state);
    if (raw === lastSaved.current) return;
    try {
      localStorage.setItem(KEY, raw);
      lastSaved.current = raw;
    } catch {
      /* quota or private mode: keep working in memory */
    }
  }, [state, ready]);

  /* coarse clock: re-rank as time passes without per-second renders */
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 15000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  /* -- derived -- */
  const d = useMemo(() => {
    const open = state.sessions.find((x) => x.end === null) ?? null;
    const ranked: Row[] = state.tasks
      .filter((t) => t.status === "todo")
      .map((t) => scoreTask(t, overlap(state.sessions, now, 0, t.id), now))
      .sort(byRank);
    const activeRow = open ? ranked.find((r) => r.task.id === open.taskId) ?? null : null;
    const lead = ranked[0] ?? null;
    const focus = activeRow ?? lead;

    let advice: Advice | null = null;
    if (activeRow) {
      const best = ranked.find((r) => r.task.id !== activeRow.task.id);
      if (best && best.score > activeRow.score + SWITCH_MARGIN) {
        advice = {
          kind: "switch",
          key: `s:${activeRow.task.id}:${best.task.id}`,
          target: best,
          text: `\u201C${best.task.title}\u201D now outranks this by ${Math.round(best.score - activeRow.score)} points. Switch only if it's worth the handoff.`,
        };
      } else if (activeRow.activeMs > activeRow.task.estMin * 60000 * 1.25) {
        advice = {
          kind: "overrun",
          key: `o:${activeRow.task.id}`,
          text: `${fmtDur(activeRow.activeMs - activeRow.task.estMin * 60000)} past your estimate. Finish it, re-scope it, or stop and mark it blocked.`,
        };
      }
    }

    /* timeline: active task first (don't thrash), then by rank */
    const order = [...(activeRow ? [activeRow] : []), ...ranked.filter((r) => r.task.id !== activeRow?.task.id)];
    let cursor = 0;
    const blocks = order.map((r) => {
      const dur = Math.max(5, r.task.estMin - r.activeMs / 60000);
      const startMin = cursor;
      cursor += dur;
      const endMs = now + cursor * 60000;
      return { ...r, startMin, durMin: dur, endMs, late: r.task.due !== null && endMs > r.task.due };
    });
    const total = cursor;
    const dueMins = blocks
      .map((b) => (b.task.due !== null ? (b.task.due - now) / 60000 : 0))
      .filter((m) => m > 0 && m <= Math.max(total * 2, 120));
    const horizon = Math.max(60, total, ...dueMins) * 1.05;

    /* metrics (today) */
    const from = startOfDay(now);
    const doneToday = state.tasks.filter((t) => t.status === "done" && (t.doneAt ?? 0) >= from);
    const value = doneToday.reduce((a, t) => a + t.importance + t.consequence + t.opportunity, 0);
    const focusMs = overlap(state.sessions, now, from);
    const waitMs = overlap(state.waits, now, from);
    const switches = state.log.filter((l) => l.type === "switch" && l.t >= from).length;

    return {
      open,
      ranked,
      activeRow,
      lead,
      focus,
      advice,
      blocks,
      horizon,
      doneToday: doneToday.length,
      value,
      focusMs,
      waitMs,
      switches,
      waiting: state.tasks.filter((t) => t.status === "waiting"),
      finished: state.tasks
        .filter((t) => t.status === "done")
        .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
        .slice(0, 5),
    };
  }, [state, now]);

  const act = {
    start: (id: string) => dispatch({ type: "start", id, t: Date.now() }),
    pause: () => dispatch({ type: "pause", t: Date.now() }),
    wait: (id: string) => dispatch({ type: "wait", id, t: Date.now() }),
    unblock: (id: string) => dispatch({ type: "unblock", id, t: Date.now() }),
    done: (id: string) => dispatch({ type: "done", id, t: Date.now() }),
    reopen: (id: string) => dispatch({ type: "reopen", id, t: Date.now() }),
    remove: (id: string) => dispatch({ type: "remove", id, t: Date.now() }),
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const clean = title.trim();
    if (!clean) return;
    const dueMs = due ? new Date(due).getTime() : NaN;
    dispatch({
      type: "add",
      task: {
        id: uid(),
        title: clean,
        ...draft,
        estMin: clamp(Math.round(Number(est)) || 25, 5, 600),
        due: Number.isNaN(dueMs) ? null : dueMs,
        createdAt: Date.now(),
        status: "todo",
        doneAt: null,
      },
    });
    setTitle("");
    setDue("");
    setEst("25");
    setDraft({ importance: 3, urgency: 3, consequence: 3, opportunity: 3 });
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `top1-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const globalCss = `
    @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Instrument+Sans:wght@400;500;600&display=swap');
    * { box-sizing: border-box; }
    html, body { margin: 0; background: ${C.bg}; }
    button:focus-visible, input:focus-visible { outline: 3px solid ${C.blue}; outline-offset: 2px; }
    ::selection { background: ${C.blueSoft}; }
  `;

  if (!ready || now === 0) {
    return (
      <main style={{ minHeight: "100dvh", background: C.bg }}>
        <style>{globalCss}</style>
      </main>
    );
  }

  const { focus, activeRow, advice } = d;
  const showAdvice = advice && advice.key !== dismissed;
  const pct = activeRow ? clamp((activeRow.activeMs / (activeRow.task.estMin * 60000)) * 100, 0, 100) : 0;
  const axis = [0, 0.25, 0.5, 0.75, 1].map((f) => now + f * d.horizon * 60000);

  return (
    <MotionConfig reducedMotion="user">
      <style>{globalCss}</style>
      <main style={{ minHeight: "100dvh", background: C.bg, color: C.ink, fontFamily: BODY, padding: "22px 16px 72px" }}>
        <div style={{ maxWidth: 1040, margin: "0 auto", display: "grid", gap: 18 }}>
          {/* header */}
          <header>
            <h1 style={{ fontFamily: HEAD, fontWeight: 800, fontSize: "clamp(34px, 7vw, 52px)", margin: 0, letterSpacing: "-0.03em" }}>
              Top 1
            </h1>
            <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 15 }}>
              One task at a time. Ranked against the clock, re-ranked as it moves.
            </p>
          </header>

          {/* lead / active */}
          <motion.section
            layout
            style={{
              background: C.blue,
              color: "#fff",
              borderRadius: 24,
              padding: "22px 20px",
              display: "grid",
              gap: 14,
              overflow: "hidden",
            }}
          >
            {focus ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", fontSize: 14, opacity: 0.9 }}>
                  <span>{activeRow ? "In progress" : "Next up"}</span>
                  <span>Priority {Math.round(focus.score)} of 100</span>
                </div>

                <AnimatePresence mode="wait" initial={false}>
                  <motion.h2
                    key={focus.task.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                    style={{ fontFamily: HEAD, fontWeight: 800, fontSize: "clamp(26px, 6vw, 40px)", lineHeight: 1.08, margin: 0, letterSpacing: "-0.02em", overflowWrap: "anywhere" }}
                  >
                    {focus.task.title}
                  </motion.h2>
                </AnimatePresence>

                {activeRow && d.open ? (
                  <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                      <span style={{ fontFamily: HEAD, fontWeight: 800, fontSize: "clamp(48px, 14vw, 88px)", lineHeight: 1, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.03em" }}>
                        <Live
                          read={(n) =>
                            fmtTimer(overlap(state.sessions, n, 0, activeRow.task.id))
                          }
                        />
                      </span>
                      <span style={{ fontSize: 15, opacity: 0.9 }}>of {activeRow.task.estMin} min planned</span>
                    </div>
                    <div style={{ height: 6, borderRadius: 3, background: "rgba(255,255,255,0.25)", overflow: "hidden" }}>
                      <motion.div
                        initial={false}
                        animate={{ width: `${pct}%` }}
                        transition={{ type: "spring", stiffness: 80, damping: 20 }}
                        style={{ height: "100%", background: pct >= 100 ? "#FFD27A" : "#fff" }}
                      />
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: 15, opacity: 0.92 }}>
                    {focus.task.estMin} min planned
                    {focus.task.due !== null ? `. ${fmtDue(focus.task.due, now)}` : ""}
                  </div>
                )}

                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {[
                    ["Importance", focus.task.importance, false],
                    ["Urgency", focus.urgency, focus.raisedByDeadline],
                    ["Consequence", focus.task.consequence, false],
                    ["Opportunity", focus.task.opportunity, false],
                  ].map(([label, val, raised]) => (
                    <span
                      key={String(label)}
                      title={raised ? "Raised automatically by the deadline" : undefined}
                      style={{ background: "rgba(255,255,255,0.16)", borderRadius: 999, padding: "4px 11px", fontSize: 13, fontWeight: 500 }}
                    >
                      {label} {val}
                      {raised ? " (deadline)" : ""}
                    </span>
                  ))}
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {activeRow ? (
                    <>
                      <Btn variant="onBlue" icon={<Check size={18} />} onClick={() => act.done(activeRow.task.id)}>Done</Btn>
                      <Btn variant="onBlue" icon={<Pause size={18} />} onClick={act.pause}>Pause</Btn>
                      <Btn variant="onBlue" icon={<Hourglass size={18} />} onClick={() => act.wait(activeRow.task.id)}>Blocked</Btn>
                    </>
                  ) : (
                    <Btn variant="onBlue" icon={<Play size={18} />} onClick={() => act.start(focus.task.id)}>Start</Btn>
                  )}
                </div>

                <AnimatePresence>
                  {showAdvice && advice && (
                    <motion.div
                      key={advice.key}
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      style={{ overflow: "hidden" }}
                    >
                      <div style={{ background: "#fff", color: C.ink, borderRadius: 12, padding: 12, display: "grid", gap: 10 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 14 }}>
                          <AlertTriangle size={18} color={C.amber} style={{ flexShrink: 0, marginTop: 1 }} />
                          <span>{advice.text}</span>
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {advice.kind === "switch" && advice.target && (
                            <Btn variant="solid" icon={<ArrowRightLeft size={16} />} onClick={() => act.start(advice.target!.task.id)}>
                              Switch
                            </Btn>
                          )}
                          <Btn onClick={() => setDismissed(advice.key)}>Keep going</Btn>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                <h2 style={{ fontFamily: HEAD, fontWeight: 800, fontSize: 30, margin: 0 }}>Nothing queued</h2>
                <p style={{ margin: 0, opacity: 0.92 }}>Add your first task below. The top-ranked one appears here.</p>
              </div>
            )}
          </motion.section>

          {/* metrics */}
          <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))", gap: 12 }}>
            <Metric
              label="Valuable output"
              big={String(d.value)}
              note={`${d.doneToday} finished today${d.focusMs > 60000 ? `, ${(d.value / (d.focusMs / 3600000)).toFixed(1)} per focus hour` : ""}`}
            />
            <Metric
              label="Waiting time"
              big={fmtDur(d.waitMs)}
              note={d.waiting.length ? `${d.waiting.length} blocked right now` : "Nothing blocked"}
              tone={d.waiting.length ? C.amber : undefined}
            />
            <Metric
              label="Context switches"
              big={String(d.switches)}
              note={`${fmtDur(d.focusMs)} focused today`}
              tone={d.switches > 3 ? C.red : undefined}
            />
          </section>

          {/* timeline */}
          <section style={card}>
            <h3 style={h3}>Timeline from now</h3>
            <p style={sub}>Projected order. The vertical tick on a row is its due time; red means it is projected to finish late.</p>
            {d.blocks.length === 0 ? (
              <p style={{ color: C.muted, margin: "14px 0 0", fontSize: 14 }}>Add tasks to see your day laid out.</p>
            ) : (
              <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
                <AnimatePresence initial={false}>
                  {d.blocks.map((b, i) => {
                    const left = (b.startMin / d.horizon) * 100;
                    const width = Math.max(1.5, (b.durMin / d.horizon) * 100);
                    const dueLeft = b.task.due !== null ? clamp(((b.task.due - now) / 60000 / d.horizon) * 100, 0, 100) : null;
                    const color = b.late ? C.red : i === 0 && activeRow ? C.blue : C.blueSoft;
                    return (
                      <motion.div
                        key={b.task.id}
                        layout
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        style={{ display: "grid", gap: 4 }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13 }}>
                          <span style={{ ...ellipsis, fontWeight: 600 }}>{b.task.title}</span>
                          <span style={{ color: C.muted, flexShrink: 0 }}>
                            {fmtClock(now + b.startMin * 60000)} to {fmtClock(b.endMs)}
                          </span>
                        </div>
                        <div style={{ position: "relative", height: 20, background: C.track, borderRadius: 6, borderLeft: `2px solid ${C.ink}` }}>
                          <motion.div
                            initial={false}
                            animate={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                            transition={{ type: "spring", stiffness: 160, damping: 26 }}
                            style={{ position: "absolute", top: 3, bottom: 3, borderRadius: 4, background: color }}
                          />
                          {dueLeft !== null && (
                            <div
                              title={fmtDue(b.task.due!, now)}
                              style={{ position: "absolute", left: `${dueLeft}%`, top: -3, bottom: -3, width: 2, background: b.task.due! < now ? C.red : C.ink }}
                            />
                          )}
                        </div>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.muted, paddingLeft: 2 }}>
                  {axis.map((t, i) => (
                    <span key={i}>{i === 0 ? "Now" : fmtClock(t)}</span>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* queue */}
          <section style={card}>
            <h3 style={h3}>Ranked now</h3>
            <p style={sub}>Order updates as deadlines get closer. Tap a task to adjust its ratings.</p>
            <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
              <AnimatePresence initial={false}>
                {d.ranked.map((r, i) => {
                  const isActive = r.task.id === activeRow?.task.id;
                  const isOpen = openId === r.task.id;
                  return (
                    <motion.div
                      key={r.task.id}
                      layout
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.97 }}
                      transition={{ type: "spring", stiffness: 300, damping: 30 }}
                      style={{ border: `1px solid ${isActive ? C.blue : C.line}`, borderRadius: 12, background: "#fff", overflow: "hidden" }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 10px 10px 14px" }}>
                        <span style={{ fontFamily: HEAD, fontWeight: 800, fontSize: 18, width: 22, color: i === 0 ? C.blue : C.muted }}>{i + 1}</span>
                        <button
                          type="button"
                          onClick={() => setOpenId(isOpen ? null : r.task.id)}
                          aria-expanded={isOpen}
                          style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", padding: "4px 0", cursor: "pointer", fontFamily: BODY, color: C.ink }}
                        >
                          <div style={{ ...ellipsis, fontWeight: 600, fontSize: 15 }}>{r.task.title}</div>
                          <div style={{ fontSize: 12, color: r.task.due !== null && r.task.due < now ? C.red : C.muted, marginTop: 2 }}>
                            Score {Math.round(r.score)}, {r.task.estMin} min
                            {r.task.due !== null ? `, ${fmtDue(r.task.due, now)}` : ""}
                          </div>
                        </button>
                        {isActive ? (
                          <Btn icon={<Pause size={18} />} title="Pause" onClick={act.pause} />
                        ) : (
                          <Btn icon={<Play size={18} />} title="Start" onClick={() => act.start(r.task.id)} />
                        )}
                        <motion.span animate={{ rotate: isOpen ? 180 : 0 }} style={{ display: "inline-flex", color: C.muted }}>
                          <ChevronDown size={18} />
                        </motion.span>
                      </div>
                      <AnimatePresence initial={false}>
                        {isOpen && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            style={{ overflow: "hidden" }}
                          >
                            <div style={{ padding: "4px 14px 14px", display: "grid", gap: 12, borderTop: `1px solid ${C.line}` }}>
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 230px), 1fr))", gap: 12, paddingTop: 12 }}>
                                {RATINGS.map((rt) => (
                                  <RatingInput
                                    key={rt.key}
                                    label={rt.label}
                                    hint={rt.hint}
                                    value={r.task[rt.key]}
                                    onChange={(value) => dispatch({ type: "rate", id: r.task.id, key: rt.key, value })}
                                  />
                                ))}
                              </div>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                <Btn icon={<Check size={16} />} onClick={() => act.done(r.task.id)}>Done</Btn>
                                <Btn icon={<Hourglass size={16} />} onClick={() => act.wait(r.task.id)}>Blocked</Btn>
                                <Btn variant="danger" icon={<Trash2 size={16} />} onClick={() => act.remove(r.task.id)}>Delete</Btn>
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
              {d.ranked.length === 0 && <p style={{ color: C.muted, margin: 0, fontSize: 14 }}>No open tasks.</p>}
            </div>
          </section>

          {/* waiting */}
          <AnimatePresence initial={false}>
            {d.waiting.length > 0 && (
              <motion.section
                key="waiting"
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                style={card}
              >
                <h3 style={h3}>Blocked</h3>
                <p style={sub}>Waiting time counts against you. Follow up, or resume when unblocked.</p>
                <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
                  {d.waiting.map((t) => {
                    const since = state.waits.find((w) => w.taskId === t.id && w.end === null)?.start ?? now;
                    const long = now - since > 30 * 60000;
                    return (
                      <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, border: `1px solid ${C.line}`, borderRadius: 12, background: "#fff", padding: "10px 10px 10px 14px" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ ...ellipsis, fontWeight: 600, fontSize: 15 }}>{t.title}</div>
                          <div style={{ fontSize: 12, color: long ? C.amber : C.muted, marginTop: 2 }}>
                            Waiting <Live read={(n) => fmtDur(n - since)} every={15000} /> since {fmtClock(since)}
                          </div>
                        </div>
                        <Btn icon={<Play size={16} />} onClick={() => act.unblock(t.id)}>Resume</Btn>
                        <Btn variant="danger" icon={<Trash2 size={16} />} title="Delete" onClick={() => act.remove(t.id)} />
                      </div>
                    );
                  })}
                </div>
              </motion.section>
            )}
          </AnimatePresence>

          {/* add */}
          <section style={card}>
            <h3 style={h3}>Add a task</h3>
            <form onSubmit={submit} style={{ display: "grid", gap: 14, marginTop: 14 }}>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What needs doing?"
                aria-label="Task title"
                style={inputStyle}
              />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))", gap: 12 }}>
                <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 600 }}>
                  Estimate (minutes)
                  <input type="number" inputMode="numeric" min={5} max={600} step={5} value={est} onChange={(e) => setEst(e.target.value)} style={inputStyle} />
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 600 }}>
                  Due (optional)
                  <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} style={inputStyle} />
                </label>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 230px), 1fr))", gap: 14 }}>
                {RATINGS.map((rt) => (
                  <RatingInput
                    key={rt.key}
                    label={rt.label}
                    hint={rt.hint}
                    value={draft[rt.key]}
                    onChange={(v) => setDraft((p) => ({ ...p, [rt.key]: v }))}
                  />
                ))}
              </div>
              <div>
                <Btn type="submit" variant="solid" icon={<Plus size={18} />}>Add task</Btn>
              </div>
            </form>
          </section>

          {/* finished + log */}
          <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 12 }}>
            <div style={card}>
              <h3 style={h3}>Finished</h3>
              <div style={{ display: "grid", gap: 6, marginTop: 12 }}>
                {d.finished.length === 0 && <p style={{ color: C.muted, margin: 0, fontSize: 14 }}>Nothing finished yet.</p>}
                {d.finished.map((t) => (
                  <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
                    <Check size={16} color={C.green} style={{ flexShrink: 0 }} />
                    <span style={{ ...ellipsis, flex: 1 }}>{t.title}</span>
                    <span style={{ color: C.muted, fontSize: 12, flexShrink: 0 }}>
                      {t.doneAt ? fmtClock(t.doneAt) : ""}
                    </span>
                    <Btn icon={<Undo2 size={15} />} title="Reopen" onClick={() => act.reopen(t.id)} />
                  </div>
                ))}
              </div>
            </div>

            <div style={card}>
              <h3 style={h3}>Activity</h3>
              <div style={{ display: "grid", gap: 6, marginTop: 12, fontSize: 13 }}>
                {state.log.length === 0 && <p style={{ color: C.muted, margin: 0, fontSize: 14 }}>Every action is timestamped here.</p>}
                {[...state.log].reverse().slice(0, 10).map((l) => (
                  <div key={l.id} style={{ display: "flex", gap: 8 }}>
                    <span style={{ color: C.muted, width: 64, flexShrink: 0 }}>{fmtClock(l.t)}</span>
                    <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      {LOG_VERB[l.type]} &ldquo;{l.title}&rdquo;{l.note ? `, ${l.note}` : ""}
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
                <Btn icon={<Download size={16} />} onClick={exportJson}>Export</Btn>
                <Btn
                  variant="danger"
                  icon={<RotateCcw size={16} />}
                  onClick={() => {
                    if (window.confirm("Delete all tasks, timers and history on this device?")) dispatch({ type: "reset" });
                  }}
                >
                  Reset
                </Btn>
              </div>
            </div>
          </section>
        </div>
      </main>
    </MotionConfig>
  );
}

const LOG_VERB: Record<LogType, string> = {
  add: "Added",
  start: "Started",
  switch: "Switched to",
  pause: "Paused",
  wait: "Blocked on",
  unblock: "Resumed",
  done: "Finished",
  reopen: "Reopened",
  remove: "Deleted",
};

function Metric(p: { label: string; big: string; note: string; tone?: string }) {
  return (
    <motion.div layout style={{ ...card, display: "grid", gap: 2 }}>
      <span style={{ fontSize: 14, fontWeight: 600 }}>{p.label}</span>
      <motion.span
        key={p.big}
        initial={{ opacity: 0.4, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ fontFamily: HEAD, fontWeight: 800, fontSize: 38, lineHeight: 1.1, color: p.tone ?? C.ink, letterSpacing: "-0.02em" }}
      >
        {p.big}
      </motion.span>
      <span style={{ fontSize: 13, color: C.muted }}>{p.note}</span>
    </motion.div>
  );
}

