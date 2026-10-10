'use client';
import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import { Ban, Bath, BedDouble, Brain, Briefcase, Check, Clock, Copy, Droplets, Dumbbell, Footprints, Heart, HeartPulse, ListTodo, Moon, Phone, Play, Plus, Scissors, Settings, Smile, Sparkles, Sun, Target, Trash2, Utensils } from 'lucide-react';

type Mode = 'none' | 'daily' | 'weekly';
type Task = { id: string; title: string; date: string; time: string; dur: number; pri: number; deadline: string; repeat: Mode; days: number[]; prep: string; post?: string };
type Prep = { id: string; name: string; min: number };
type Win = { s: string; e: string };
type Care = { id: string; label: string; icon: string; dur: number; slot: 'shower' | 'flex'; every?: number; days?: number[]; last?: string; note?: string };
type Block = { id: string; label: string; start: number; dur: number; icon: string; kind: 'routine' | 'task' | 'prep' | 'sleep' | 'call' | 'meal'; note?: string; pri?: number; msg?: boolean; warn?: boolean; hi?: boolean; at?: number; until?: number; soft?: boolean };
type Store = { sleep: string; wake: string; tasks: Task[]; preps: Prep[]; done: Record<string, boolean>; started: Record<string, number>; pris: Record<string, string[]>; care: Care[]; yuni: { usual: Win[]; today: Record<string, Win[]> }; call: Record<string, { start: number; len: number }>; seeded?: boolean; water: Record<string, number[]>; wGoal: number; wMl: number; wCut: number };

const KEY = 'next-action-v1';
// ---- easy-to-change config ----
const CALL = { min: 30, max: 60, from: 720 }; // call window starts at midday (minutes)
const KEEP = 960; // good morning, teeth, skin care and the no-entertainment rule stay valid until 4 pm
const WGAP = 20; // minutes between half glasses so catching up is spread out
const SHOWER: [string, number[]][] = [['shampoo', [1, 5]], ['conditioner', [1, 3, 5]], ['scrub', [5]]]; // product, weekdays (0 = Sunday)
const CARE: Care[] = [
  { id: 'shave', label: 'Shave', icon: 'cut', dur: 10, days: [1], slot: 'shower' },
  { id: 'fnail', label: 'Cut fingernails', icon: 'cut', dur: 10, every: 21, slot: 'shower' },
  { id: 'tnail', label: 'Cut toenails', icon: 'cut', dur: 10, every: 28, slot: 'shower' },
  { id: 'hair', label: 'Haircut trim', icon: 'cut', dur: 30, every: 40, slot: 'flex' },
];
const CBLANK = { label: '', dur: 10, mode: 'every' as 'every' | 'days', every: 21, days: [] as number[], slot: 'shower' as 'shower' | 'flex', last: '' };
const DL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEF: Store = { sleep: '21:00', wake: '05:00', tasks: [], preps: [{ id: 'h2s', name: 'Home to school', min: 90 }, { id: 's2h', name: 'School to home', min: 90 }, { id: 'w2s', name: 'Work to school', min: 60 }, { id: 's2w', name: 'School to work', min: 60 }], done: {}, started: {}, pris: {}, care: CARE, yuni: { usual: [], today: {} }, call: {}, seeded: true, water: {}, wGoal: 16, wMl: 125, wCut: 120 };
const BLANK = { title: '', date: '', time: '', dur: 30, pri: 3, deadline: '', repeat: 'none' as Mode, days: [] as number[], prep: '', post: '' };
const AM = [
  'Good morning, Yuni! I hope today feels light and kind.',
  'Rise and shine, Yuni. Today is going to be a good one.',
  'Morning, Yuni! Sending you a big hug and a strong start.',
  'Good morning, Yuni. Go get some sunshine today!',
  'Hi Yuni, good morning! Proud of you already.',
];
const PM = [
  'Good night, Yuni. Sleep well and dream sweet.',
  'Sweet dreams, Yuni. See you tomorrow.',
  'Night night, Yuni. You did great today, rest well.',
  'Good night, Yuni! Sending you warm hugs.',
];
const PC = ['#7c8aa5', '#6cb7d9', '#8fd0a4', '#f2c46d', '#ff8f7a'];
const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const IC: Record<string, LucideIcon> = { heart: Heart, water: Droplets, sun: Sun, target: Target, smile: Smile, sparkle: Sparkles, ban: Ban, brain: Brain, food: Utensils, bath: Bath, gym: Dumbbell, cardio: HeartPulse, task: Briefcase, prep: Footprints, sleep: BedDouble, cut: Scissors, call: Phone };
const EV = 13; // evening routine minutes (half bath 5, teeth 3, face 2, moisturizer 2, goodnight 1)

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const fmt = (m: number) => { const x = ((Math.round(m) % 1440) + 1440) % 1440; const h = Math.floor(x / 60); return `${h % 12 || 12}:${pad(x % 60)} ${h < 12 ? 'am' : 'pm'}`; };
const hash = (s: string) => Math.abs(s.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7));
const uid = () => Math.random().toString(36).slice(2, 9);
const dowOf = (d: string) => new Date(d + 'T00:00').getDay();
const info = (t: Task) => `Priority ${t.pri}, ${t.dur} min${t.deadline ? ', due ' + t.deadline : ''}`;

const dayN = (d: string) => Math.round(new Date(d + 'T00:00').getTime() / 864e5);
// weekday items repeat on those weekdays; "every N days" items count from the last time they were checked off
function careDue(c: Care, date: string, done: Record<string, boolean>) {
  if (c.days) return c.days.includes(dowOf(date));
  if (!c.every) return false;
  const prev = Object.keys(done).filter((k) => done[k] && k.endsWith('|c:' + c.id) && k.slice(0, 10) < date).map((k) => k.slice(0, 10));
  const last = [c.last || '', ...prev].sort().pop() || '';
  return !last || dayN(date) - dayN(last) >= c.every;
}

function occurs(t: Task, date: string, done: Record<string, boolean>) {
  if (t.repeat === 'daily') return date >= t.date;
  if (t.repeat === 'weekly') return date >= t.date && t.days.includes(dowOf(date));
  if (t.time) return t.date === date;
  return t.date <= date && !Object.keys(done).some((k) => k.endsWith('|t:' + t.id) && !k.startsWith(date));
}

function buildDay(s: Store, date: string, startAt: number) {
  const dow = dowOf(date);
  const h = hash(date);
  const R = (id: string, label: string, dur: number, icon: string, note?: string, x: Partial<Block> = {}): Block => ({ id, label, dur, icon, note, start: 0, kind: 'routine', ...x });
  const todays = s.tasks.filter((t) => occurs(t, date, s.done));
  const placed: Block[] = [];

  // fixed-time tasks and their automatic prep
  for (const t of todays.filter((t) => t.time)) {
    const st = toMin(t.time);
    const p = s.preps.find((x) => x.id === t.prep);
    if (p) placed.push(R('p:' + t.id, p.name + ' prep', p.min, 'prep', 'Auto prep for ' + t.title, { start: st - p.min, kind: 'prep', hi: true, at: st - p.min, until: st }));
    placed.push(R('t:' + t.id, t.title, t.dur, 'task', info(t), { start: st, kind: 'task', pri: t.pri, hi: true, at: st, until: st + t.dur }));
    const q = s.preps.find((x) => x.id === t.post); // travel back / wrap-up after the task
    if (q) placed.push(R('q:' + t.id, q.name, q.min, 'prep', 'After ' + t.title, { start: st + t.dur, kind: 'prep', hi: true, at: st + t.dur, until: st + t.dur + q.min }));
  }
  const fixed = [...placed];
  const minimal = fixed.length > 0 && Math.min(...fixed.map((b) => b.start)) < startAt + 162;
  const ac = s.call[date]; // a call already started is a fixed block nothing else can overlap
  if (ac) {
    const cb2 = R('call', 'Call with Yuni', ac.len, 'call', 'Uninterrupted. Phone on do not disturb.', { start: ac.start, kind: 'call', hi: true, at: ac.start });
    placed.push(cb2);
    fixed.push(cb2);
  }

  const parts = SHOWER.filter(([, d]) => d.includes(dow)).map(([n]) => n);
  const shower = R('shower', 'Take a shower', 15, 'bath', `Fast. Prioritize singit-singit, no soap on face. Today: ${parts.length ? parts.join(' + ') : 'just rinse'}.`);
  // priority work: 1, then 2, then 3 (falls back to one deep work block)
  const ps = (s.pris[date] ?? []).map((x, i) => ({ x: x.trim(), i })).filter((o) => o.x).slice(0, 3);
  const works = (ps.length ? ps : [{ x: 'Deep work', i: 0 }]).map((o, k) => R('w' + (o.i + 1), o.x, k === 0 ? 90 : 60, 'brain', k === 0 ? 'Phone away. One thing only.' : 'Next priority. Same focus.', { kind: 'task', pri: Math.max(1, 5 - k) }));
  const dueCare = s.care.filter((c) => careDue(c, date, s.done));
  const cb = (c: Care) => R('c:' + c.id, c.label, c.dur, c.icon, c.note);
  const inFlow = minimal ? [] : dueCare.filter((c) => c.slot === 'shower').map(cb);
  const later = dueCare.filter((c) => minimal || c.slot !== 'shower').map(cb);
  const start = [
    R('am', 'Good morning to Yuni', 2, 'heart', AM[h % AM.length], { msg: true, until: KEEP }),
    R('sun', 'Walk to the sunlight', 10, 'sun', 'No phone. Just light and air.', { soft: true, until: 600 }),
    R('pri', 'Set your 3 priorities', 5, 'target', 'Write the 3 that matter most today.'),
  ];
  const skin = [R('teeth', 'Brush teeth', 3, 'sparkle', undefined, { until: KEEP }), R('face', 'Wash face', 2, 'smile', undefined, { soft: true, until: KEEP }), R('moist', 'Moisturize', 1, 'smile', undefined, { soft: true, until: KEEP }), R('spf', 'Apply sunscreen', 1, 'sun', undefined, { soft: true, until: KEEP })];
  const flow = minimal
    ? [...start, shower, ...skin]
    : [...start, ...skin, R('noent', 'No entertainment for now', 1, 'ban', 'No entertainment until 4 pm. Priority work, food and water first.', { until: KEEP }), works[0], shower, ...inFlow, ...works.slice(1)];

  const place = (b: Block, from: number) => {
    let t = from;
    let c: Block | undefined;
    while ((c = placed.find((x) => x.start < t + b.dur && t < x.start + x.dur))) t = c.start + c.dur;
    b.start = t;
    placed.push(b);
    return t + b.dur;
  };
  let cur = startAt;
  for (const b of flow) cur = place(b, cur);
  const morningEnd = cur;
    // sleep can move later (up to 11 pm) when tasks run late
  const base = toMin(s.sleep);
  const lastEnd = Math.max(0, ...fixed.map((b) => b.start + b.dur));
  let sleepAt = base;
  let note = '';
  if (lastEnd + EV > base) {
    sleepAt = Math.max(base, Math.min(lastEnd + EV, 1380));
    note = `Sleep moved to ${fmt(sleepAt)} for your tasks.` + (lastEnd + EV > 1380 ? ' Tasks run past the 11 pm limit.' : '');
  }

  // meals fitted to the time left: up to 3 meals evenly spaced, plus a snack inside any gap of 4 h or more
  const first = startAt + (startAt < 480 ? 120 : 45);
  const last = Math.max(first, sleepAt - 210);
  const mt = last - first >= 240 ? [first, (first + last) / 2, last] : last - first >= 120 ? [first, last] : [first];
  const mn = mt.length === 3 ? ['Breakfast', 'Lunch', 'Dinner'] : mt.length === 2 ? ['First meal', 'Dinner'] : ['Meal'];
  const evs = mt.map((tt, i): [string, number, string, number] => [mn[i], 30, i === mt.length - 1 && mt.length > 1 ? 'High protein, whole food. Keep it lighter.' : 'High protein, whole food.', tt]);
  for (let i = 0; i < mt.length - 1; i++) if (mt[i + 1] - mt[i] >= 240) evs.push(['Snack', 10, 'Fruit, nuts or yogurt.', (mt[i] + mt[i + 1]) / 2]);
  evs.sort((x, y) => x[3] - y[3]);
  const nGap = evs.length > 1 ? (evs[evs.length - 1][3] - evs[0][3]) / (evs.length - 1) : 0;
  evs.forEach(([label, dur, note, tt], i) => {
    let t0 = Math.round(tt);
    if (t0 > sleepAt - 120) return; // no food within 2 h of bed
    const mb = R('m' + label.replace(/\s/g, '') + evs.slice(0, i).filter((e) => e[0] === label).length, label, dur, 'food', note, { kind: 'meal', hi: true });
    // meals only move for fixed commitments (class, travel, call); the next action engine interleaves them with the rest
    let c: Block | undefined;
    while ((c = fixed.find((x) => x.start < t0 + dur && t0 < x.start + x.dur))) t0 = c.start + c.dur;
    mb.start = t0;
    placed.push(mb);
    mb.at = mb.start;
    mb.until = mb.start + (dur > 10 ? 90 : 60);
  });
  if (minimal) for (const wb of works) place(wb, morningEnd); // early commitment: priority work moves after it
  const str = R('str', 'Strength exercise', 40, 'gym', 'Mid-day. Warm up first.');
  cur = place(str, Math.max(cur, 720));
  str.at = str.start - 60;
  const car = R('car', 'Cardio', 45, 'cardio', 'Steady pace for 45 minutes.');
  place(car, cur);
  car.at = car.start - 30;

  const flex = todays.filter((t) => !t.time).sort((x, y) => y.pri - x.pri || (x.deadline || '9').localeCompare(y.deadline || '9'));
  for (const t of flex) {
    const b = R('t:' + t.id, t.title, t.dur, 'task', info(t), { kind: 'task', pri: t.pri });
    place(b, morningEnd);
    if (b.start + b.dur > sleepAt - EV) { b.warn = true; b.note += ', may not fit today'; }
  }

  for (const b of later) {
    place(b, morningEnd);
    if (b.start + b.dur > sleepAt - EV) { b.warn = true; b.note = (b.note ?? '') + ' May not fit today.'; }
  }

  // call with Yuni: your free gaps (midday to night) overlapped with her free times
  const wins = s.yuni.today[date] ?? s.yuni.usual;
  const gaps: [number, number][] = [];
  let pc = CALL.from;
  for (const b of [...placed].sort((a, c) => a.start - c.start)) {
    if (b.start > pc) gaps.push([pc, Math.min(b.start, sleepAt - EV)]);
    pc = Math.max(pc, b.start + b.dur);
  }
  if (sleepAt - EV > pc) gaps.push([pc, sleepAt - EV]);
  const cands = gaps
    .flatMap((g): [number, number][] => (wins.length ? wins.map((w): [number, number] => [Math.max(g[0], toMin(w.s)), Math.min(g[1], toMin(w.e))]) : [g]))
    .filter(([a, e]) => e - a >= CALL.min);
  const best = cands.sort((a, c) => c[1] - c[0] - (a[1] - a[0]) || a[0] - c[0])[0];
  if (!ac && best) {
    placed.push(R('call', 'Call with Yuni', Math.min(CALL.max, best[1] - best[0]), 'call', wins.length ? 'Shared free time. You can also start it anytime from the call card.' : 'Not confirmed with Yuni yet. Ask her first.', { start: best[0], kind: 'call', hi: wins.length > 0, at: best[0], until: best[0] + 45 }));
  }

  let t = sleepAt - EV;
  for (const b of [R('half', 'Half bath', 5, 'bath', 'Just the singit-singit part. Quick rinse, no soap on face.'), R('teeth2', 'Brush teeth', 3, 'sparkle'), R('face2', 'Wash face', 2, 'smile'), R('moist2', 'Moisturize', 2, 'smile'), R('pm', 'Good night to Yuni', 1, 'heart', PM[h % PM.length], { msg: true })]) {
    b.start = t; b.hi = true; b.at = sleepAt - EV; t += b.dur; placed.push(b);
  }
  const rest = toMin(s.wake) + 1440 - sleepAt;
  placed.push(R('sleep', 'Sleep', rest, 'sleep', `Lights out. ${(rest / 60).toFixed(1)} hours until ${fmt(toMin(s.wake))}.`, { start: sleepAt, kind: 'sleep', hi: true, at: sleepAt }));
  return { blocks: placed.sort((a, b) => a.start - b.start), note, minimal, gaps, best, sleepAt, workStart: works[0].start, nGap };
}

const S: Record<string, CSSProperties> = {
  card: { background: '#1b1f2b', border: '1px solid #2a3042', borderRadius: 16, padding: 16, marginBottom: 12 },
  inp: { background: '#12151d', border: '1px solid #2f3650', color: '#eceef6', borderRadius: 10, padding: '9px 11px', fontSize: 14, width: '100%', boxSizing: 'border-box', colorScheme: 'dark' },
  lab: { display: 'block', fontSize: 12, color: '#98a1bd', margin: '12px 0 4px' },
  btn: { background: '#ffb38a', color: '#2a1608', border: 0, borderRadius: 12, padding: '13px 16px', fontSize: 15, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%' },
  chip: { background: '#12151d', border: '1px solid #2f3650', color: '#b3bad3', borderRadius: 999, padding: '6px 12px', fontSize: 13, cursor: 'pointer' },
  row: { display: 'flex', gap: 8 },
  warn: { background: '#3a2f1c', border: '1px solid #5b4a26', color: '#f2d9a0', borderRadius: 12, padding: '10px 12px', fontSize: 13, marginBottom: 12 },
  muted: { color: '#98a1bd', fontSize: 13, margin: '6px 0 0' },
};

const Chip = ({ on, c = '#ffb38a', onClick, children }: { on: boolean; c?: string; onClick: () => void; children: ReactNode }) => (
  <button type="button" onClick={onClick} style={{ ...S.chip, ...(on ? { background: c, borderColor: c, color: '#1a1208', fontWeight: 700 } : {}) }}>{children}</button>
);
const Lab = ({ t }: { t: string }) => <label style={S.lab}>{t}</label>;

const Wins = ({ w, set }: { w: Win[]; set: (w: Win[]) => void }) => {
  const [a, setA] = useState('18:00');
  const [b, setB] = useState('21:00');
  return (
    <div>
      <div style={{ ...S.row, flexWrap: 'wrap', marginTop: 8 }}>
        {w.map((x, i) => (
          <button key={i} style={{ ...S.chip, display: 'inline-flex', gap: 6, alignItems: 'center' }} aria-label="Remove time window" onClick={() => set(w.filter((_, j) => j !== i))}>
            {fmt(toMin(x.s))} to {fmt(toMin(x.e))} <Trash2 size={12} />
          </button>
        ))}
      </div>
      <div style={{ ...S.row, marginTop: 8 }}>
        <input type="time" style={S.inp} value={a} onChange={(e) => setA(e.target.value)} />
        <input type="time" style={S.inp} value={b} onChange={(e) => setB(e.target.value)} />
        <button style={S.chip} aria-label="Add time window" onClick={() => a && b && toMin(b) > toMin(a) && set([...w, { s: a, e: b }])}><Plus size={16} /></button>
      </div>
    </div>
  );
};

export default function Page() {
  const [st, setSt] = useState<Store>(DEF);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<'today' | 'tasks' | 'settings'>('today');
  const [now, setNow] = useState(0);
  const [today, setToday] = useState('');
  const [f, setF] = useState(BLANK);
  const [pf, setPf] = useState({ name: '', min: 30 });
  const [cl, setCl] = useState(45);
  const [cf, setCf] = useState(CBLANK);

  useEffect(() => {
    try { const r = localStorage.getItem(KEY); if (r) {
        const s: Store = { ...DEF, ...JSON.parse(r) };
        if (!s.seeded) { // one-time: add the default travel presets to older saved data
          s.preps = [...s.preps, ...DEF.preps.filter((d) => !s.preps.some((x) => x.id === d.id))];
          s.seeded = true;
        }
        if (s.wGoal === 8 && s.wMl === 250) { s.wGoal = 16; s.wMl = 125; } // half glasses
        setSt(s);
      } } catch { /* ignore */ }
    const tick = () => { const d = new Date(); setToday(ymd(d)); setNow(d.getHours() * 60 + d.getMinutes()); };
    tick();
    setReady(true);
    const i = setInterval(tick, 30000);
    return () => clearInterval(i);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* ignore */ }
  }, [st, ready]);

  const up = (p: Partial<Store>) => setSt((s) => ({ ...s, ...p }));
  const plan = useMemo(() => (today ? buildDay(st, today, st.started[today] ?? toMin(st.wake)) : null), [st, today]);
  if (!ready || !plan) return <div style={{ position: 'fixed', inset: 0, background: '#12151d' }} />;

  const started = st.started[today] !== undefined;
  const isDone = (id: string) => !!st.done[today + '|' + id];
  const toggle = (id: string) => up({ done: { ...st.done, [today + '|' + id]: !isDone(id) } });
  const pr = st.pris[today] ?? ['', '', ''];
  const sug = st.tasks.filter((t) => occurs(t, today, st.done)).sort((a, b) => b.pri - a.pri || (a.deadline || '9').localeCompare(b.deadline || '9')).slice(0, 3).map((t) => t.title);
  const copy = (t: string) => { try { navigator.clipboard.writeText(t).catch(() => undefined); } catch { /* ignore */ } };
  const kindColor = (b: Block) => (b.kind === 'task' ? PC[(b.pri ?? 3) - 1] : b.kind === 'prep' ? '#5fc4b8' : b.kind === 'call' ? '#f29fc0' : b.kind === 'meal' ? '#e8a35c' : b.kind === 'sleep' ? '#a99bff' : '#566086');

  const addTask = () => {
    if (!f.title.trim()) return;
    const date = f.date || today;
    const days = f.repeat === 'weekly' && !f.days.length ? [dowOf(date)] : f.days;
    up({ tasks: [...st.tasks, { ...f, id: uid(), title: f.title.trim(), date, days, dur: Math.max(5, f.dur) }] });
    setF(BLANK);
  };
  const addPrep = () => {
    if (!pf.name.trim()) return;
    up({ preps: [...st.preps, { id: uid(), name: pf.name.trim(), min: Math.max(1, pf.min) }] });
    setPf({ name: '', min: 30 });
  };
  const resetToday = () => {
    const ss = { ...st.started };
    delete ss[today];
    up({ started: ss, done: Object.fromEntries(Object.entries(st.done).filter(([k]) => !k.startsWith(today + '|'))) });
  };

  const ac = st.call[today];
  const left = ac ? ac.start + ac.len - now : 0;
  const yw = st.yuni.today[today] ?? st.yuni.usual;
  const free = plan.gaps.filter(([a, e]) => e - a >= CALL.min).map(([a, e]) => `${fmt(a)} to ${fmt(e)}`).join(', ');
  const ask = `Hi Yuni! Are you free for an uninterrupted call today? I can do ${free || 'later tonight'}. What time works for you?`;
  const cancelCall = () => { // put the call back into the plan as a suggestion
    const c = { ...st.call };
    delete c[today];
    up({ call: c, done: { ...st.done, [today + '|call']: false } });
  };
  // water: spread the daily glasses evenly from day start to (bedtime - cut-off)
  const w0 = st.started[today] ?? toMin(st.wake);
  const w1 = plan.sleepAt - st.wCut;
  const wFull = Math.max(1, st.wGoal);
  const wRef = Math.max(60, toMin(st.sleep) - st.wCut - toMin(st.wake)); // normal drinking window
  const wG = Math.min(wFull, Math.max(1, Math.round((wFull * Math.max(0, w1 - w0) * 1.3) / wRef)));
  const wl = st.water[today] ?? [];
  const wStep = wG > 1 ? Math.max(0, w1 - w0) / (wG - 1) : 0;
  const wExp = now >= w1 ? wG : now < w0 ? 0 : wStep > 0 ? Math.min(wG, Math.floor((now - w0) / wStep) + 1) : wG;
  const wLeft = wG - wl.length;
  const wBehind = Math.max(0, wExp - wl.length);
  const sip = () => up({ water: { ...st.water, [today]: [...wl, now] } });
  const undoSip = () => up({ water: { ...st.water, [today]: wl.slice(0, -1) } });
  // ---- next action engine ----
  // 1) commitments, meals, snacks, evening and sleep when due  2) water when behind  3) priority 1, 2, 3  4) the rest
  const behind = now > plan.workStart + 20; // running late: quick soft items (sunlight, skin care) wait until priority 1 is done
  const expired = (b: Block) => !isDone(b.id) && b.until !== undefined && now > b.until;
  const alive = (b: Block) => !isDone(b.id) && !expired(b);
  const due = (b: Block) => alive(b) && (b.at === undefined || now >= b.at);
  const wReady = wBehind > 0 && now < w1 && (wl.length === 0 || now - wl[wl.length - 1] >= WGAP);
  const WB: Block = { id: 'wat', label: 'Drink half a glass of water', start: now, dur: 1, icon: 'water', kind: 'routine', note: `${wl.length} of ${wG} half glasses so far, ${wBehind} behind. Sip now, the rest gets spread out.` };
  const nf = plan.blocks.find((b) => b.hi && b.kind !== 'meal' && b.at !== undefined && b.at > now && alive(b));
  const rest0 = plan.blocks.filter((b) => !b.hi && due(b));
  const w1i = rest0.findIndex((b) => /^w\d/.test(b.id));
  const rest = behind && w1i >= 0 ? [...rest0.slice(0, w1i + 1).filter((b) => !b.soft), ...rest0.slice(0, w1i).filter((b) => b.soft), ...rest0.slice(w1i + 1)] : rest0;
  const next: Block | null = plan.blocks.find((b) => b.hi && due(b)) ?? (wReady ? WB : null) ?? rest.find((b) => !nf || now + b.dur <= (nf.at as number)) ?? rest[0] ?? null;
  const later = next ? null : plan.blocks.find((b) => alive(b));
  const doneN = plan.blocks.filter((b) => isDone(b.id) || expired(b)).length;
  const NI = next ? IC[next.icon] ?? Sparkles : Sparkles;
  const meals = plan.blocks.filter((b) => b.kind === 'meal' && b.label !== 'Snack');
  const snacks = plan.blocks.filter((b) => b.kind === 'meal' && b.label === 'Snack');
  const nd = (a: Block[]) => a.filter((b) => isDone(b.id)).length;
  const act = () => {
    if (!next) return;
    if (next.id === 'wat') sip();
    else if (next.id === 'call' && !ac) startCall(Math.min(CALL.max, next.dur));
    else if (next.id === 'pri' && !pr.some(Boolean) && sug.length) up({ pris: { ...st.pris, [today]: [sug[0] ?? '', sug[1] ?? '', sug[2] ?? ''] }, done: { ...st.done, [today + '|pri']: true } });
    else toggle(next.id);
  };
  const actLabel = !next ? '' : next.id === 'wat' ? 'I drank it' : next.id === 'call' ? (ac ? 'End call' : 'Start call') : next.id === 'pri' && !pr.some(Boolean) && sug.length ? 'Use my top tasks' : next.kind === 'meal' ? 'I ate' : 'Done';
  const startCall = (len: number) => up({ call: { ...st.call, [today]: { start: now, len } } });
  const addCare = () => {
    if (!cf.label.trim()) return;
    up({ care: [...st.care, { id: uid(), label: cf.label.trim(), icon: 'cut', dur: Math.max(1, cf.dur), slot: cf.slot, last: cf.last, ...(cf.mode === 'days' ? { days: cf.days } : { every: Math.max(1, cf.every) }) }] });
    setCf(CBLANK);
  };

  const tabs: [typeof tab, string, LucideIcon][] = [['today', 'Today', Sun], ['tasks', 'Tasks', ListTodo], ['settings', 'Settings', Settings]];

  return (
    <div style={{ position: 'fixed', inset: 0, overflowY: 'auto', background: '#12151d', color: '#eceef6', fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif' }}>
      <div style={{ maxWidth: 520, margin: '0 auto', padding: '20px 16px 48px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>Next action</div>
            <div style={S.muted}>{new Date(today + 'T00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
          </div>
          <div style={{ textAlign: 'right', fontSize: 13, color: '#98a1bd' }}><Moon size={14} style={{ verticalAlign: -2 }} /> {fmt(toMin(st.sleep))} to {fmt(toMin(st.wake))}</div>
        </div>

        <div style={{ ...S.row, marginBottom: 14 }}>
          {tabs.map(([k, label, Ico]) => (
            <button key={k} onClick={() => setTab(k)} style={{ ...S.chip, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, ...(tab === k ? { background: '#2a3042', color: '#fff', borderColor: '#566086' } : {}) }}>
              <Ico size={15} /> {label}
            </button>
          ))}
        </div>

        {tab === 'today' && (
          <>
            {!started ? (
              <div style={{ ...S.card, textAlign: 'center', padding: 28 }}>
                <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 30, ease: 'linear' }} style={{ display: 'inline-block' }}><Sun size={56} color="#ffc27a" /></motion.div>
                <h2 style={{ margin: '12px 0 4px' }}>Good morning</h2>
                <p style={{ ...S.muted, margin: '0 0 18px' }}>Tap when you are awake. Your day will be planned from that moment.</p>
                <motion.button whileTap={{ scale: 0.96 }} style={S.btn} onClick={() => up({ started: { ...st.started, [today]: now } })}><Play size={18} /> Start my day</motion.button>
              </div>
            ) : (
              <>
                {plan.minimal && <div style={S.warn}>Early commitment found. Minimal morning today: sunlight, priorities, food, shower, skin care. No deep work.</div>}
                {plan.note && <div style={S.warn}>{plan.note}</div>}
                {now < KEEP && <div style={{ ...S.warn, background: '#2a2438', borderColor: '#4a3f6b', color: '#d4c8ff' }}>No entertainment until 4 pm. Priority work, food and water come first.</div>}

                <div style={{ height: 6, background: '#2a3042', borderRadius: 6, marginBottom: 12, overflow: 'hidden' }}>
                  <motion.div animate={{ width: `${(doneN / plan.blocks.length) * 100}%` }} style={{ height: '100%', background: '#8fd0a4' }} />
                </div>

                <AnimatePresence mode="wait">
                  {next ? (
                    <motion.div key={next.id} initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -18 }} transition={{ duration: 0.22 }} style={{ ...S.card, border: '1px solid #ffb38a66', background: '#221e26', padding: 20 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                        <div style={{ width: 52, height: 52, borderRadius: 16, background: '#ffb38a22', display: 'grid', placeItems: 'center' }}><NI size={26} color="#ffb38a" /></div>
                        <div>
                          <div style={{ fontSize: 13, color: '#c9a58f' }}>Next action</div>
                          <div style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.2 }}>{next.label}</div>
                        </div>
                      </div>
                      <p style={{ ...S.muted, marginTop: 14 }}><Clock size={13} style={{ verticalAlign: -2 }} /> {fmt(next.start)} to {fmt(next.start + next.dur)}, {next.dur} min</p>
                      {next.note && <p style={{ margin: '10px 0 0', fontSize: 15, lineHeight: 1.5 }}>{next.note}</p>}
                      {next.msg && next.note && <button onClick={() => copy(next.note as string)} style={{ ...S.chip, marginTop: 10, display: 'inline-flex', gap: 6, alignItems: 'center' }}><Copy size={14} /> Copy message</button>}
                      <motion.button whileTap={{ scale: 0.96 }} onClick={act} style={{ ...S.btn, marginTop: 16 }}><Check size={18} /> {actLabel}</motion.button>
                      {!next.hi && next.id !== 'wat' && next.id !== 'pri' && <button onClick={() => toggle(next.id)} style={{ ...S.chip, marginTop: 10, width: '100%' }}>Skip for today</button>}
                    </motion.div>
                  ) : (
                    <motion.div key="end" initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ ...S.card, textAlign: 'center', padding: 28 }}>
                      <Moon size={40} color="#a99bff" />
                      <h3 style={{ margin: '10px 0 0' }}>{later ? 'Nothing due right now.' : 'Everything is done. Rest well.'}</h3>
                      {later && <p style={S.muted}>Next: {later.label} at {fmt(later.at ?? later.start)}.</p>}
                    </motion.div>
                  )}
                </AnimatePresence>

                <div style={S.card}>
                  <b style={{ fontSize: 15 }}>3 priorities for today</b>
                  {[0, 1, 2].map((i) => (
                    <input key={i} style={{ ...S.inp, marginTop: 8 }} placeholder={sug[i] ?? `Priority ${i + 1}`} value={pr[i] ?? ''} onChange={(e) => { const n = [...pr]; n[i] = e.target.value; up({ pris: { ...st.pris, [today]: n } }); }} />
                  ))}
                </div>

                <div style={{ ...S.card, borderColor: '#f29fc055' }}>
                  <b style={{ fontSize: 15 }}><Phone size={15} style={{ verticalAlign: -2 }} /> Call with Yuni</b>
                  {ac && !isDone('call') ? (
                    <>
                      <p style={{ margin: '10px 0 14px', fontSize: 15 }}>{left > 0 ? `${left} min left. Phone on do not disturb. Nothing else is scheduled.` : 'Time is up. Wrap up warmly.'}</p>
                      <motion.button whileTap={{ scale: 0.96 }} style={S.btn} onClick={() => toggle('call')}><Check size={18} /> End call</motion.button>
                      <Lab t="Move the start time" />
                      <input type="time" style={S.inp} value={`${pad(Math.floor(ac.start / 60))}:${pad(ac.start % 60)}`} onChange={(e) => e.target.value && up({ call: { ...st.call, [today]: { ...ac, start: toMin(e.target.value) } } })} />
                      <button onClick={cancelCall} style={{ ...S.chip, marginTop: 10 }}>Cancel and put it back in the plan</button>
                    </>
                  ) : isDone('call') ? (
                    <>
                      <p style={S.muted}>Call finished. Nice.</p>
                      <button onClick={cancelCall} style={{ ...S.chip, marginTop: 10 }}>Undo and put it back in the plan</button>
                    </>
                  ) : (
                    <>
                      <p style={S.muted}>Your free time, midday to night: {free || 'none yet'}</p>
                      <p style={{ ...S.muted, marginTop: 10 }}>Yuni free times today (usual times are in Settings):</p>
                      <Wins w={yw} set={(w) => up({ yuni: { ...st.yuni, today: { ...st.yuni.today, [today]: w } } })} />
                      <p style={{ ...S.muted, marginTop: 10 }}>{plan.best ? `Best shared slot: ${fmt(plan.best[0])} to ${fmt(plan.best[0] + Math.min(CALL.max, plan.best[1] - plan.best[0]))}` : 'No shared slot of 30 minutes yet.'}</p>
                      <button onClick={() => copy(ask)} style={{ ...S.chip, marginTop: 10, display: 'inline-flex', gap: 6, alignItems: 'center' }}><Copy size={14} /> Copy message to ask Yuni</button>
                      <div style={{ ...S.row, margin: '12px 0' }}>{[30, 45, 60].map((l) => <Chip key={l} on={cl === l} c="#f29fc0" onClick={() => setCl(l)}>{l} min</Chip>)}</div>
                      <motion.button whileTap={{ scale: 0.96 }} style={S.btn} onClick={() => startCall(cl)}><Phone size={18} /> Start call now</motion.button>
                    </>
                  )}
                </div>

                <div style={{ ...S.card, padding: 12, fontSize: 13, color: '#b3bad3' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span><Droplets size={14} style={{ verticalAlign: -2 }} /> {wl.length}/{wG} half glasses, {wExp} due by now</span>
                    <span>Meals {nd(meals)}/{meals.length}, snacks {nd(snacks)}/{snacks.length}</span>
                  </div>
                  <div style={{ ...S.muted, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span>{plan.nGap > 0 ? `Eating about every ${Math.floor(plan.nGap / 60)}h ${Math.round(plan.nGap % 60)}m, ` : ''}no food 2 hours before bed.</span>
                    <button style={{ ...S.chip, padding: '4px 10px', fontSize: 12 }} onClick={undoSip}>Undo water</button>
                  </div>
                </div>

                <div style={{ ...S.card, padding: 8 }}>
                  {plan.blocks.map((b) => {
                    const Ico = IC[b.icon] ?? Sparkles;
                    const d = isDone(b.id);
                    const x = expired(b);
                    return (
                      <motion.div layout key={b.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '9px 8px', borderLeft: `3px solid ${kindColor(b)}`, margin: '4px 0', opacity: d || x ? 0.4 : 1, background: b.warn ? '#3a2523' : 'transparent', borderRadius: 6 }}>
                        <button aria-label={d ? 'Mark not done' : 'Mark done'} onClick={() => toggle(b.id)} style={{ width: 26, height: 26, borderRadius: 13, border: '2px solid #566086', background: d ? '#8fd0a4' : 'transparent', display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0, padding: 0 }}>
                          {d && <Check size={15} color="#10261a" />}
                        </button>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 15, fontWeight: 600, textDecoration: d ? 'line-through' : 'none' }}>{b.label}</div>
                          <div style={{ fontSize: 12, color: '#98a1bd' }}>{fmt(b.start)}, {b.dur} min{x ? ', skipped' : ''}</div>
                        </div>
                        <Ico size={18} color="#7d86a8" />
                      </motion.div>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}

        {tab === 'tasks' && (
          <>
            <div style={S.card}>
              <b style={{ fontSize: 15 }}>Add a task</b>
              <Lab t="What do you need to do?" />
              <input style={S.inp} placeholder="Meeting inside school" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
              <div style={S.row}>
                <div style={{ flex: 1 }}><Lab t="Date" /><input type="date" style={S.inp} value={f.date || today} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>
                <div style={{ flex: 1 }}><Lab t="Start time (empty = flexible)" /><input type="time" style={S.inp} value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></div>
              </div>
              <div style={S.row}>
                <div style={{ flex: 1 }}><Lab t="Estimated minutes" /><input type="number" min={5} style={S.inp} value={f.dur} onChange={(e) => setF({ ...f, dur: +e.target.value || 0 })} /></div>
                <div style={{ flex: 1 }}><Lab t="Deadline (optional)" /><input type="date" style={S.inp} value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} /></div>
              </div>
              <Lab t="Priority (5 is highest)" />
              <div style={S.row}>{[1, 2, 3, 4, 5].map((p) => <Chip key={p} on={f.pri === p} c={PC[p - 1]} onClick={() => setF({ ...f, pri: p })}>{p}</Chip>)}</div>
              <Lab t="Repeat" />
              <div style={S.row}>{(['none', 'daily', 'weekly'] as Mode[]).map((m) => <Chip key={m} on={f.repeat === m} onClick={() => setF({ ...f, repeat: m })}>{m === 'none' ? 'Once' : m === 'daily' ? 'Every day' : 'Every week'}</Chip>)}</div>
              {f.repeat === 'weekly' && (
                <div style={{ ...S.row, marginTop: 8 }}>
                  {DAYS.map((d, i) => <Chip key={i} on={f.days.includes(i)} onClick={() => setF({ ...f, days: f.days.includes(i) ? f.days.filter((x) => x !== i) : [...f.days, i] })}>{d}</Chip>)}
                </div>
              )}
              <Lab t="Prep or travel before (set once in Settings)" />
              <select style={S.inp} value={f.prep} onChange={(e) => setF({ ...f, prep: e.target.value })}>
                <option value="">No prep</option>
                {st.preps.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.min} min)</option>)}
              </select>
              <Lab t="Travel or wrap-up after" />
              <select style={S.inp} value={f.post ?? ''} onChange={(e) => setF({ ...f, post: e.target.value })}>
                <option value="">Nothing after</option>
                {st.preps.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.min} min)</option>)}
              </select>
              <motion.button whileTap={{ scale: 0.97 }} style={{ ...S.btn, marginTop: 16 }} onClick={addTask}><Plus size={18} /> Add task</motion.button>
            </div>

            {st.tasks.length === 0 && <p style={S.muted}>No tasks yet. Add one above and it will appear in your day.</p>}
            <AnimatePresence>
              {[...st.tasks].sort((a, b) => b.pri - a.pri).map((t) => (
                <motion.div key={t.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, x: 40 }} style={{ ...S.card, display: 'flex', gap: 10, alignItems: 'center', borderLeft: `4px solid ${PC[t.pri - 1]}`, padding: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700 }}>{t.title}</div>
                    <div style={{ fontSize: 12, color: '#98a1bd', marginTop: 2 }}>
                      {t.time ? fmt(toMin(t.time)) : 'Flexible'}, {t.dur} min, priority {t.pri}
                      {t.repeat === 'daily' ? ', every day' : t.repeat === 'weekly' ? ', every ' + t.days.map((d) => DAYS[d]).join('') : ', ' + t.date}
                      {t.deadline ? ', due ' + t.deadline : ''}
                      {st.preps.find((p) => p.id === t.prep) ? ', before: ' + st.preps.find((p) => p.id === t.prep)?.name : ''}{st.preps.find((p) => p.id === t.post) ? ', after: ' + st.preps.find((p) => p.id === t.post)?.name : ''}
                    </div>
                  </div>
                  <button aria-label="Delete task" onClick={() => up({ tasks: st.tasks.filter((x) => x.id !== t.id) })} style={{ ...S.chip, padding: 8 }}><Trash2 size={16} /></button>
                </motion.div>
              ))}
            </AnimatePresence>
          </>
        )}

        {tab === 'settings' && (
          <>
            <div style={S.card}>
              <b style={{ fontSize: 15 }}>Sleep schedule</b>
              <div style={S.row}>
                <div style={{ flex: 1 }}><Lab t="Sleep at" /><input type="time" style={S.inp} value={st.sleep} onChange={(e) => e.target.value && up({ sleep: e.target.value })} /></div>
                <div style={{ flex: 1 }}><Lab t="Wake at" /><input type="time" style={S.inp} value={st.wake} onChange={(e) => e.target.value && up({ wake: e.target.value })} /></div>
              </div>
              <p style={S.muted}>When a task runs late, bedtime moves later automatically, up to 11 pm.</p>
            </div>

            <div style={S.card}>
              <b style={{ fontSize: 15 }}>Prep and travel presets</b>
              <p style={S.muted}>Set once, then attach to any task as before (prep, travel there) or after (travel back, wrap-up). Both are placed automatically around the task time.</p>
              {st.preps.map((p) => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                  <div style={{ flex: 1 }}>{p.name}</div>
                  <input type="number" min={1} aria-label="Minutes" style={{ ...S.inp, width: 76 }} value={p.min} onChange={(e) => up({ preps: st.preps.map((x) => (x.id === p.id ? { ...x, min: Math.max(1, +e.target.value || 0) } : x)) })} />
                  <button aria-label="Delete preset" onClick={() => up({ preps: st.preps.filter((x) => x.id !== p.id) })} style={{ ...S.chip, padding: 8 }}><Trash2 size={16} /></button>
                </div>
              ))}
              <div style={{ ...S.row, marginTop: 12 }}>
                <input style={{ ...S.inp, flex: 2 }} placeholder="Going to the gym" value={pf.name} onChange={(e) => setPf({ ...pf, name: e.target.value })} />
                <input type="number" min={1} style={{ ...S.inp, flex: 1 }} value={pf.min} onChange={(e) => setPf({ ...pf, min: +e.target.value || 0 })} />
              </div>
              <motion.button whileTap={{ scale: 0.97 }} style={{ ...S.btn, marginTop: 12 }} onClick={addPrep}><Plus size={18} /> Add preset</motion.button>
            </div>

            <div style={S.card}>
              <b style={{ fontSize: 15 }}>Yuni usual free times</b>
              <p style={S.muted}>Used to find a shared call slot when you have not set times for today.</p>
              <Wins w={st.yuni.usual} set={(w) => up({ yuni: { ...st.yuni, usual: w } })} />
            </div>

            <div style={S.card}>
              <b style={{ fontSize: 15 }}>Grooming and recurring care</b>
              <p style={S.muted}>By weekday, or every N days counted from the last time you checked it off. Empty last done means due now.</p>
              {st.care.map((c) => (
                <div key={c.id} style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #2a3042' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ flex: 1, fontSize: 14 }}><b>{c.label}</b>, {c.dur} min, {c.days ? 'every ' + c.days.map((d) => DL[d]).join(', ') : `every ${c.every} days`}, {c.slot === 'shower' ? 'after shower' : 'anytime'}</div>
                    <button aria-label="Delete care item" onClick={() => up({ care: st.care.filter((x) => x.id !== c.id) })} style={{ ...S.chip, padding: 8 }}><Trash2 size={16} /></button>
                  </div>
                  {!c.days && <input type="date" aria-label="Last done" style={{ ...S.inp, marginTop: 8 }} value={c.last ?? ''} onChange={(e) => up({ care: st.care.map((x) => (x.id === c.id ? { ...x, last: e.target.value } : x)) })} />}
                </div>
              ))}
              <Lab t="Add recurring care" />
              <input style={S.inp} placeholder="Trim eyebrows" value={cf.label} onChange={(e) => setCf({ ...cf, label: e.target.value })} />
              <div style={{ ...S.row, marginTop: 8 }}>
                <Chip on={cf.mode === 'every'} onClick={() => setCf({ ...cf, mode: 'every' })}>Every N days</Chip>
                <Chip on={cf.mode === 'days'} onClick={() => setCf({ ...cf, mode: 'days' })}>Weekdays</Chip>
              </div>
              {cf.mode === 'every' ? (
                <input type="number" min={1} style={{ ...S.inp, marginTop: 8 }} value={cf.every} onChange={(e) => setCf({ ...cf, every: +e.target.value || 0 })} />
              ) : (
                <div style={{ ...S.row, marginTop: 8 }}>{DAYS.map((d, i) => <Chip key={i} on={cf.days.includes(i)} onClick={() => setCf({ ...cf, days: cf.days.includes(i) ? cf.days.filter((x) => x !== i) : [...cf.days, i] })}>{d}</Chip>)}</div>
              )}
              <div style={S.row}>
                <div style={{ flex: 1 }}><Lab t="Minutes" /><input type="number" min={1} style={S.inp} value={cf.dur} onChange={(e) => setCf({ ...cf, dur: +e.target.value || 0 })} /></div>
                <div style={{ flex: 1 }}><Lab t="Last done (optional)" /><input type="date" style={S.inp} value={cf.last} onChange={(e) => setCf({ ...cf, last: e.target.value })} /></div>
              </div>
              <div style={{ ...S.row, marginTop: 10 }}>
                <Chip on={cf.slot === 'shower'} onClick={() => setCf({ ...cf, slot: 'shower' })}>After shower</Chip>
                <Chip on={cf.slot === 'flex'} onClick={() => setCf({ ...cf, slot: 'flex' })}>Anytime</Chip>
              </div>
              <motion.button whileTap={{ scale: 0.97 }} style={{ ...S.btn, marginTop: 14 }} onClick={addCare}><Plus size={18} /> Add care item</motion.button>
            </div>

            <div style={S.card}>
              <b style={{ fontSize: 15 }}>Water</b>
              <p style={S.muted}>Half glasses are spread evenly from your day start until the cut-off before bed. Water shows up as your next action when you are behind.</p>
              <div style={S.row}>
                <div style={{ flex: 1 }}><Lab t="Half glasses per day" /><input type="number" min={1} style={S.inp} value={st.wGoal} onChange={(e) => up({ wGoal: +e.target.value || 0 })} /></div>
                <div style={{ flex: 1 }}><Lab t="ml per half glass" /><input type="number" min={1} style={S.inp} value={st.wMl} onChange={(e) => up({ wMl: +e.target.value || 0 })} /></div>
                <div style={{ flex: 1 }}><Lab t="No water before bed (min)" /><input type="number" min={0} style={S.inp} value={st.wCut} onChange={(e) => up({ wCut: +e.target.value || 0 })} /></div>
              </div>
            </div>

            <button style={{ ...S.chip, width: '100%', padding: 12 }} onClick={resetToday}>Reset today and show Start my day again</button>
          </>
        )}
      </div>
    </div>
  );
}

