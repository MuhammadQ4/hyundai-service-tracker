import React, { useState, useEffect, useMemo, useCallback, useContext, createContext, useRef } from "react";
import { supabase } from "./supabaseClient";

// ─── Constants ───
const H = {
  navy: "#002C5F", blue: "#0073CF", lightBlue: "#00AAD2", steel: "#1B3D6D",
  accent: "#4EC3E0", white: "#FFFFFF", offWhite: "#F4F6F9",
  g100: "#E8ECF1", g200: "#CDD4DE", g400: "#8B95A5", g600: "#5A6575", g800: "#2D3442",
  red: "#D32F2F", redBg: "#FDE8E8", yellow: "#F9A825", yellowBg: "#FFF8E1",
  green: "#2E7D32", greenBg: "#E8F5E9", blueBg: "#E3F2FD", greyBg: "#ECEFF1",
};

const REQUEST_TYPES = ["New", "Pre-Owned", "Demonstration", "General Service"];
const CATEGORIES = ["Reconditioning", "Safety", "Delivery Preparation", "General Repair"];
const PRIORITIES = ["High", "Medium", "Low"];
const STATUSES = ["In Queue", "In Progress", "On Hold", "Completed"];
const WORKFLOW_ORDER = ["Reconditioning", "Safety", "Delivery Preparation"];

// ─── VIN Validation (unchanged) ───
const VIN_VALUES = {};
"0123456789".split("").forEach((c, i) => (VIN_VALUES[c] = i));
"ABCDEFGH".split("").forEach((c, i) => (VIN_VALUES[c] = i + 1));
VIN_VALUES["J"] = 1; VIN_VALUES["K"] = 2; VIN_VALUES["L"] = 3; VIN_VALUES["M"] = 4;
VIN_VALUES["N"] = 5; VIN_VALUES["P"] = 7; VIN_VALUES["R"] = 9;
"STUVWXYZ".split("").forEach((c, i) => (VIN_VALUES[c] = i + 2));
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

function validateVIN(vin) {
  const v = vin.replace(/\s/g, "").toUpperCase();
  if (v.length !== 17) return { valid: false, error: "VIN must be exactly 17 characters" };
  if (/[IOQ]/.test(v)) return { valid: false, error: "VIN cannot contain I, O, or Q" };
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return { valid: false, error: "VIN contains invalid characters" };
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    if (i === 8) continue;
    sum += (VIN_VALUES[v[i]] || 0) * VIN_WEIGHTS[i];
  }
  const remainder = sum % 11;
  const checkChar = remainder === 10 ? "X" : String(remainder);
  if (v[8] !== checkChar) return { valid: false, error: `Check digit invalid — position 9 should be "${checkChar}" (got "${v[8]}")` };
  return { valid: true, cleaned: v };
}

// ─── Helpers ───
const genId = () => "SR-" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
const now = () => new Date().toISOString();
const fmt = (iso) => { if (!iso) return "—"; const d = new Date(iso); return d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" }) + " " + d.toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" }); };
const fmtDate = (iso) => { if (!iso) return "—"; return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" }); };
const isOverdue = (eta, status) => { if (!eta || status === "Completed") return false; return new Date(eta) < new Date(new Date().toDateString()); };
const timeDiff = (s, e) => { if (!s || !e) return "—"; const ms = new Date(e) - new Date(s); const h = Math.floor(ms / 3600000); const m = Math.floor((ms % 3600000) / 60000); return h > 0 ? `${h}h ${m}m` : `${m}m`; };
const timeRemaining = (eta) => { if (!eta) return "—"; const ms = new Date(eta) - new Date(); if (ms < 0) return "OVERDUE"; const d = Math.floor(ms / 86400000); const h = Math.floor((ms % 86400000) / 3600000); return d > 0 ? `${d}d ${h}h` : `${h}h`; };

const sortItems = (items, wf) => [...items].sort((a, b) => {
  const wA = wf[a.id], wB = wf[b.id];
  const odA = isOverdue(a.eta, wA?.status) ? 0 : 1;
  const odB = isOverdue(b.eta, wB?.status) ? 0 : 1;
  if (odA !== odB) return odA - odB;
  const po = { High: 0, Medium: 1, Low: 2 };
  if (po[a.priority] !== po[b.priority]) return po[a.priority] - po[b.priority];
  if (a.eta && b.eta) return new Date(a.eta) - new Date(b.eta);
  if (a.eta) return -1; if (b.eta) return 1; return 0;
});

// ─── Supabase ↔ JS mapping (camelCase ↔ snake_case) ───
const reqToRow = (r) => ({
  id: r.id, type: r.type, stock: r.stock, vin: r.vin,
  category: r.category, priority: r.priority, notes: r.notes ?? null,
  created: r.created, eta: r.eta || null,
  workflow_group: r.workflowGroup ?? null,
  workflow_step: r.workflowStep ?? null,
});
const reqFromRow = (row) => ({
  id: row.id, type: row.type, stock: row.stock, vin: row.vin,
  category: row.category, priority: row.priority, notes: row.notes,
  created: row.created, eta: row.eta,
  workflowGroup: row.workflow_group, workflowStep: row.workflow_step,
});
const wfToRow = (id, w) => ({
  request_id: id, work_order: w.workOrder || null, status: w.status,
  technician: w.technician || null, start_time: w.startTime,
  completion_time: w.completionTime, service_notes: w.serviceNotes || null,
});
const wfFromRow = (row) => ({
  workOrder: row.work_order || "", status: row.status, technician: row.technician || "",
  startTime: row.start_time, completionTime: row.completion_time,
  serviceNotes: row.service_notes || "",
});

// ─── Atomic Work Order generator (Supabase-backed) ───
async function generateWorkOrder() {
  const today = new Date().toISOString().slice(0, 10);
  const { data: existing, error: selErr } = await supabase
    .from("wo_counter").select("count").eq("date", today).maybeSingle();
  if (selErr) throw selErr;
  const next = (existing?.count ?? 0) + 1;
  const { error: upErr } = await supabase
    .from("wo_counter").upsert({ date: today, count: next }, { onConflict: "date" });
  if (upErr) throw upErr;
  return `WO-${today.replace(/-/g, "")}-${String(next).padStart(3, "0")}`;
}

// ─── Color helpers ───
const stColor = (status, eta) => {
  if (isOverdue(eta, status)) return { bg: H.redBg, text: H.red, dot: H.red };
  switch (status) {
    case "In Queue": return { bg: H.greyBg, text: H.g600, dot: H.g400 };
    case "In Progress": return { bg: H.blueBg, text: H.blue, dot: H.blue };
    case "On Hold": return { bg: H.yellowBg, text: "#E68A00", dot: H.yellow };
    case "Completed": return { bg: H.greenBg, text: H.green, dot: H.green };
    case "Pending": return { bg: H.g100, text: H.g400, dot: H.g200 };
    default: return { bg: H.greyBg, text: H.g600, dot: H.g400 };
  }
};
const prColor = (p) => {
  switch (p) { case "High": return { bg: H.redBg, text: H.red }; case "Medium": return { bg: H.yellowBg, text: "#E68A00" }; case "Low": return { bg: H.greenBg, text: H.green }; default: return { bg: H.greyBg, text: H.g600 }; }
};

// ════════════════════════════════════════
// TOAST SYSTEM
// ════════════════════════════════════════
const ToastCtx = createContext(null);
export const useToast = () => useContext(ToastCtx);

function ToastCard({ msg, kind }) {
  const palette = kind === "success" ? { bg: H.greenBg, border: H.green, text: H.green, icon: "✓" }
    : kind === "error" ? { bg: H.redBg, border: H.red, text: H.red, icon: "✕" }
    : { bg: H.blueBg, border: H.blue, text: H.steel, icon: "ℹ" };
  return (
    <div style={{
      background: palette.bg, color: palette.text, border: `1px solid ${palette.border}`,
      borderRadius: 8, padding: "10px 14px", fontSize: 13, fontWeight: 600,
      display: "flex", alignItems: "center", gap: 8, minWidth: 220, maxWidth: 360,
      boxShadow: "0 4px 12px rgba(0,44,95,.12)",
    }}>
      <span style={{ fontSize: 16 }}>{palette.icon}</span>
      <span style={{ flex: 1 }}>{msg}</span>
    </div>
  );
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((msg, kind = "info") => {
    const id = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now() + Math.random());
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  const api = useMemo(() => ({
    success: (m) => push(m, "success"),
    error: (m) => push(m, "error"),
    info: (m) => push(m, "info"),
  }), [push]);
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div style={{ position: "fixed", top: 16, right: 16, zIndex: 9999, display: "flex", flexDirection: "column", gap: 8 }}>
        {toasts.map((t) => <ToastCard key={t.id} msg={t.msg} kind={t.kind} />)}
      </div>
    </ToastCtx.Provider>
  );
}

// ════════════════════════════════════════
// CONFIRM DIALOG
// ════════════════════════════════════════
function useConfirm() {
  const [state, setState] = useState(null); // { msg, options, resolve }
  const confirm = useCallback((msg, options = {}) => new Promise((resolve) => {
    setState({ msg, options, resolve });
  }), []);
  const close = (val) => { if (state) state.resolve(val); setState(null); };
  const dialog = state && (
    <div onClick={() => close(false)} style={{
      position: "fixed", inset: 0, background: "rgba(0,44,95,.4)", zIndex: 9998,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: H.white, borderRadius: 12, padding: 0, maxWidth: 440, width: "100%",
        boxShadow: "0 12px 40px rgba(0,44,95,.25)", overflow: "hidden",
      }}>
        <div style={{ background: state.options.danger ? H.red : H.navy, color: H.white, padding: "14px 18px", fontSize: 14, fontWeight: 700 }}>
          {state.options.title || (state.options.danger ? "Confirm action" : "Please confirm")}
        </div>
        <div style={{ padding: "18px", fontSize: 14, color: H.g800, lineHeight: 1.5 }}>{state.msg}</div>
        <div style={{ padding: "0 18px 18px", display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          {state.options.buttons ? state.options.buttons.map((b) => (
            <button key={b.value} onClick={() => close(b.value)} style={{
              padding: "8px 16px", borderRadius: 8, border: `1px solid ${b.danger ? H.red : H.g200}`,
              background: b.primary ? H.navy : b.danger ? H.red : H.white,
              color: b.primary || b.danger ? H.white : H.g800,
              fontSize: 13, fontWeight: 600, cursor: "pointer",
            }}>{b.label}</button>
          )) : (<>
            <button onClick={() => close(false)} style={{
              padding: "8px 16px", borderRadius: 8, border: `1px solid ${H.g200}`, background: H.white,
              color: H.g800, fontSize: 13, fontWeight: 600, cursor: "pointer",
            }}>{state.options.cancelLabel || "Cancel"}</button>
            <button onClick={() => close(true)} style={{
              padding: "8px 16px", borderRadius: 8, border: "none",
              background: state.options.danger ? H.red : H.navy, color: H.white,
              fontSize: 13, fontWeight: 600, cursor: "pointer",
            }}>{state.options.confirmLabel || "Confirm"}</button>
          </>)}
        </div>
      </div>
    </div>
  );
  return { confirm, dialog };
}

const ConfirmCtx = createContext(null);
const useAppConfirm = () => useContext(ConfirmCtx);

// ════════════════════════════════════════
// LOADING (per-record) CONTEXT
// ════════════════════════════════════════
const LoadingCtx = createContext(null);
const useLoading = () => useContext(LoadingCtx);

function Spinner({ size = 12 }) {
  return (
    <span style={{
      display: "inline-block", width: size, height: size, borderRadius: "50%",
      border: `2px solid ${H.g200}`, borderTopColor: H.blue,
      animation: "spin 0.8s linear infinite",
    }} />
  );
}

// ─── Shared Components ───
const Badge = ({ children, bg, color, style }) => (
  <span style={{ display: "inline-flex", alignItems: "center", padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, letterSpacing: 0.3, background: bg, color, whiteSpace: "nowrap", ...style }}>{children}</span>
);
const StatusBadge = ({ status, eta }) => { const c = stColor(status, eta); const od = isOverdue(eta, status); return <Badge bg={c.bg} color={c.text}><span style={{ width: 6, height: 6, borderRadius: "50%", background: c.dot, marginRight: 6, display: "inline-block" }} />{od ? "OVERDUE" : status}</Badge>; };
const PriorityBadge = ({ priority }) => { const c = prColor(priority); return <Badge bg={c.bg} color={c.text}>{priority}</Badge>; };

const Card = ({ children, style, id, onClick }) => (
  <div id={id} onClick={onClick} style={{ background: H.white, borderRadius: 12, padding: 20, boxShadow: "0 1px 4px rgba(0,44,95,.07)", border: `1px solid ${H.g100}`, ...style }}>{children}</div>
);
const MetricCard = ({ label, value, color }) => (
  <div style={{ background: H.white, borderRadius: 12, padding: "16px 18px", boxShadow: "0 1px 4px rgba(0,44,95,.07)", border: `1px solid ${H.g100}`, flex: "1 1 130px", minWidth: 120 }}>
    <div style={{ fontSize: 11, fontWeight: 600, color: H.g400, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>{label}</div>
    <div style={{ fontSize: 28, fontWeight: 800, color: color || H.navy, lineHeight: 1 }}>{value}</div>
  </div>
);

const Input = ({ label, value, onChange, type = "text", placeholder, maxLength, required, error, hint }) => (
  <div style={{ marginBottom: 14 }}>
    <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: H.g600, marginBottom: 4, letterSpacing: 0.4, textTransform: "uppercase" }}>{label}{required && <span style={{ color: H.red }}> *</span>}</label>
    <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} maxLength={maxLength}
      style={{ width: "100%", padding: "9px 12px", border: `1.5px solid ${error ? H.red : H.g200}`, borderRadius: 8, fontSize: 14, color: H.g800, background: H.white, outline: "none", boxSizing: "border-box", fontFamily: type === "text" && maxLength === 17 ? "monospace" : "inherit", letterSpacing: maxLength === 17 ? 1 : 0 }}
      onFocus={e => e.target.style.borderColor = H.blue} onBlur={e => e.target.style.borderColor = error ? H.red : H.g200} />
    {error && <div style={{ fontSize: 11, color: H.red, marginTop: 3 }}>{error}</div>}
    {hint && !error && <div style={{ fontSize: 11, color: H.g400, marginTop: 3 }}>{hint}</div>}
  </div>
);

const Select = ({ label, value, onChange, options, placeholder, required }) => (
  <div style={{ marginBottom: 14 }}>
    <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: H.g600, marginBottom: 4, letterSpacing: 0.4, textTransform: "uppercase" }}>{label}{required && <span style={{ color: H.red }}> *</span>}</label>
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ width: "100%", padding: "9px 12px", border: `1.5px solid ${H.g200}`, borderRadius: 8, fontSize: 14, color: value ? H.g800 : H.g400, background: H.white, outline: "none", boxSizing: "border-box", cursor: "pointer" }}
      onFocus={e => e.target.style.borderColor = H.blue} onBlur={e => e.target.style.borderColor = H.g200}>
      <option value="" disabled>{placeholder || "Select..."}</option>
      {options.map(o => typeof o === "string" ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </div>
);

const SearchBar = ({ value, onChange, placeholder }) => (
  <div style={{ position: "relative", flex: 1, minWidth: 200 }}>
    <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: H.g400, pointerEvents: "none" }}>🔍</span>
    <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder || "Search..."}
      style={{ width: "100%", padding: "9px 12px 9px 36px", border: `1.5px solid ${H.g200}`, borderRadius: 8, fontSize: 13, color: H.g800, background: H.white, outline: "none", boxSizing: "border-box" }}
      onFocus={e => e.target.style.borderColor = H.blue} onBlur={e => e.target.style.borderColor = H.g200} />
  </div>
);

const Tab = ({ active, label, onClick, icon }) => (
  <button onClick={onClick} style={{
    display: "flex", alignItems: "center", gap: 6, padding: "10px 16px", border: "none",
    background: active ? H.navy : "transparent", color: active ? H.white : H.g600,
    borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all .2s", letterSpacing: 0.3, whiteSpace: "nowrap",
  }}>{icon && <span style={{ fontSize: 15 }}>{icon}</span>}{label}</button>
);

const FilterPill = ({ active, label, onClick, count }) => (
  <button onClick={onClick} style={{
    padding: "6px 14px", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer",
    background: active ? H.white : "transparent", color: active ? H.navy : H.g400,
    boxShadow: active ? "0 1px 3px rgba(0,0,0,.1)" : "none", display: "flex", alignItems: "center", gap: 4,
  }}>{label}{count !== undefined && <span style={{ fontSize: 10, fontWeight: 700, background: active ? H.blueBg : "transparent", color: active ? H.blue : H.g400, borderRadius: 10, padding: "1px 6px" }}>{count}</span>}</button>
);

const InlineField = ({ label, value, onChange, placeholder, small, readOnly }) => (
  <div style={{ flex: small ? "0 0 auto" : 1 }}>
    <label style={{ fontSize: 10, fontWeight: 600, color: H.g400, textTransform: "uppercase", display: "block", marginBottom: 2 }}>{label}</label>
    <input value={value || ""} onChange={e => onChange(e.target.value)} placeholder={placeholder} readOnly={readOnly}
      style={{ width: small ? 140 : "100%", padding: "5px 8px", borderRadius: 6, border: `1px solid ${H.g200}`, fontSize: 12, boxSizing: "border-box", background: readOnly ? H.g100 : H.white, color: readOnly ? H.g600 : H.g800, fontFamily: "monospace" }} />
  </div>
);

const InlineSelect = ({ label, value, onChange, options, disabled }) => (
  <div>
    <label style={{ fontSize: 10, fontWeight: 600, color: H.g400, textTransform: "uppercase", display: "block", marginBottom: 2 }}>{label}</label>
    <select value={value} onChange={e => onChange(e.target.value)} disabled={disabled}
      style={{ padding: "5px 8px", borderRadius: 6, border: `1px solid ${H.g200}`, fontSize: 12, cursor: disabled ? "not-allowed" : "pointer", background: disabled ? H.g100 : H.white, minWidth: 110 }}>
      {options.map(s => typeof s === "string" ? <option key={s} value={s}>{s}</option> : <option key={s.value} value={s.value}>{s.label}</option>)}
    </select>
  </div>
);

const InlineTextarea = ({ label, value, onSave, placeholder, rows = 2 }) => {
  const [draft, setDraft] = useState(value || "");
  useEffect(() => { setDraft(value || ""); }, [value]);
  return (
    <div style={{ width: "100%" }}>
      <label style={{ fontSize: 10, fontWeight: 600, color: H.g400, textTransform: "uppercase", display: "block", marginBottom: 2 }}>{label}</label>
      <textarea value={draft} onChange={e => setDraft(e.target.value)}
        onBlur={() => { if (draft !== (value || "")) onSave(draft); }}
        placeholder={placeholder} rows={rows}
        style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: `1px solid ${H.g200}`, fontSize: 12, boxSizing: "border-box", resize: "vertical", fontFamily: "inherit", color: H.g800, background: H.white, outline: "none" }}
      />
    </div>
  );
};

// ─── Technician Select with workload ───
const TechSelect = ({ label, value, onChange, technicians, workflow, requests, eta }) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef(null);
  const inputRef = useRef(null);
  const toast = useToast();
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setQ(""); } };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);
  useEffect(() => { if (open && inputRef.current) inputRef.current.focus(); }, [open]);
  const allTechs = technicians || [];

  // Off-duty assignment policy:
  //   - ETA in the future  → allow, but warn the user
  //   - ETA today / past / null → block (off-duty techs stay non-selectable)
  const todayStart = new Date(new Date().toDateString());
  const etaIsFuture = eta ? new Date(eta) > todayStart : false;
  const tryAssignOff = (name) => {
    if (etaIsFuture) {
      onChange(name);
      setOpen(false); setQ("");
      toast.info(`${name} is currently Off Duty — confirm availability before the due date`);
    } else {
      toast.error(`${name} is Off Duty — cannot assign for a job due today or earlier`);
    }
  };
  const techWorkload = useMemo(() => {
    const wl = {};
    allTechs.forEach(t => { wl[t.name] = 0; });
    (requests || []).forEach(r => { const w = (workflow || {})[r.id]; if (w && (w.status === "In Progress" || w.status === "In Queue") && w.technician && wl[w.technician] !== undefined) wl[w.technician]++; });
    return wl;
  }, [allTechs, workflow, requests]);
  const getDot = (name) => { const tech = allTechs.find(t => t.name === name); if (!tech?.available) return H.g400; const a = techWorkload[name] || 0; if (a === 0) return H.green; if (a <= 2) return H.blue; if (a <= 4) return H.yellow; return H.red; };
  const getLabel = (name) => { const tech = allTechs.find(t => t.name === name); const a = techWorkload[name] || 0; if (!tech?.available) return "Off Duty"; if (a === 0) return "Available"; return `${a} job${a > 1 ? "s" : ""}`; };
  const ql = q.toLowerCase();
  const avail = allTechs.filter(t => t.available && (!ql || t.name.toLowerCase().includes(ql))).sort((a, b) => (techWorkload[a.name] || 0) - (techWorkload[b.name] || 0));
  const off = allTechs.filter(t => !t.available && (!ql || t.name.toLowerCase().includes(ql)));
  const itemStyle = (isSelected) => ({ padding: "8px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, fontSize: 12, background: isSelected ? H.blueBg : "transparent" });

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <label style={{ fontSize: 10, fontWeight: 600, color: H.g400, textTransform: "uppercase", display: "block", marginBottom: 2 }}>{label}</label>
      <button onClick={() => { setOpen(!open); setQ(""); }} type="button"
        style={{ padding: "5px 28px 5px 8px", borderRadius: 6, border: `1px solid ${open ? H.blue : H.g200}`, fontSize: 12, cursor: "pointer", background: H.white, minWidth: 180, textAlign: "left", display: "flex", alignItems: "center", gap: 6, position: "relative", color: H.g800, height: 30 }}>
        {value ? (<><span style={{ width: 8, height: 8, borderRadius: "50%", background: getDot(value), flexShrink: 0 }} /><span>{value}</span><span style={{ fontSize: 10, color: H.g400 }}>({getLabel(value)})</span></>) : (<span style={{ color: H.g400 }}>Unassigned</span>)}
        <span style={{ position: "absolute", right: 8, top: "50%", transform: `translateY(-50%) rotate(${open ? 180 : 0}deg)`, fontSize: 10, color: H.g400 }}>▼</span>
      </button>
      {open && (
        <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, background: H.white, border: `1px solid ${H.g200}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,44,95,.12)", zIndex: 50, minWidth: 250, maxHeight: 300, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "8px 10px", borderBottom: `1px solid ${H.g100}` }}>
            <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search technician..."
              style={{ width: "100%", padding: "5px 8px", border: `1px solid ${H.g200}`, borderRadius: 6, fontSize: 12, outline: "none", boxSizing: "border-box" }} />
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {(!ql || "unassigned".includes(ql)) && (
              <div onClick={() => { onChange(""); setOpen(false); setQ(""); }} style={{ ...itemStyle(false), borderBottom: `1px solid ${H.g100}`, color: H.g600 }}
                onMouseEnter={e => e.currentTarget.style.background = H.offWhite} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: H.g200 }} /><span>Unassigned</span>
              </div>
            )}
            {avail.map(t => (
              <div key={t.name} onClick={() => { onChange(t.name); setOpen(false); setQ(""); }} style={itemStyle(value === t.name)}
                onMouseEnter={e => e.currentTarget.style.background = value === t.name ? H.blueBg : H.offWhite}
                onMouseLeave={e => e.currentTarget.style.background = value === t.name ? H.blueBg : "transparent"}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: getDot(t.name), flexShrink: 0 }} />
                <span style={{ fontWeight: 600, color: H.g800 }}>{t.name}</span>
                <span style={{ fontSize: 10, color: H.g400, marginLeft: "auto" }}>{getLabel(t.name)}</span>
              </div>
            ))}
            {off.length > 0 && (<>
              <div style={{ padding: "4px 12px", fontSize: 10, fontWeight: 700, color: H.g400, textTransform: "uppercase", borderTop: `1px solid ${H.g100}`, background: H.offWhite, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Off Duty</span>
                {etaIsFuture && <span style={{ color: H.yellow, textTransform: "none", fontWeight: 600 }}>future ETA — selectable with warning</span>}
              </div>
              {off.map(t => (
                <div key={t.name}
                  onClick={() => tryAssignOff(t.name)}
                  title={etaIsFuture ? "Off duty — selectable because the due date is in the future" : "Off duty — cannot assign (due today or earlier)"}
                  style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, fontSize: 12, opacity: etaIsFuture ? 0.85 : 0.4, cursor: etaIsFuture ? "pointer" : "not-allowed", background: value === t.name ? H.yellowBg : "transparent" }}
                  onMouseEnter={e => { if (etaIsFuture) e.currentTarget.style.background = H.yellowBg; }}
                  onMouseLeave={e => { e.currentTarget.style.background = value === t.name ? H.yellowBg : "transparent"; }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: H.g400 }} />
                  <span style={{ color: etaIsFuture ? H.g600 : H.g400, fontWeight: etaIsFuture ? 600 : 400 }}>{t.name}</span>
                  {etaIsFuture && <span style={{ marginLeft: "auto", fontSize: 10, color: "#E68A00", fontWeight: 700 }}>⚠ Off Duty</span>}
                </div>
              ))}
            </>)}
            {avail.length === 0 && off.length === 0 && ql && <div style={{ padding: 12, textAlign: "center", fontSize: 12, color: H.g400 }}>No match for "{q}"</div>}
            {allTechs.length === 0 && <div style={{ padding: 12, textAlign: "center", fontSize: 12, color: H.g400 }}>Add technicians in the Technicians tab first</div>}
          </div>
        </div>
      )}
    </div>
  );
};

// ════════════════════════════════════════
// TECHNICIAN MANAGEMENT
// ════════════════════════════════════════
function TechManager({ technicians, setTechnicians, workflow, requests }) {
  const [newName, setNewName] = useState("");
  const toast = useToast();
  const { confirm } = useAppConfirm();
  const { busy, setBusy } = useLoading();

  const addTech = async () => {
    const name = newName.trim();
    if (!name) return;
    if (technicians.find(t => t.name.toLowerCase() === name.toLowerCase())) {
      toast.error(`Technician "${name}" already exists`); return;
    }
    setBusy(`tech:add`, true);
    const prev = technicians;
    setTechnicians([...technicians, { name, available: true }]);
    const { error } = await supabase.from("technicians").insert({ name, available: true });
    setBusy(`tech:add`, false);
    if (error) {
      setTechnicians(prev);
      toast.error(`Couldn't add technician: ${error.message}`);
      return;
    }
    setNewName("");
    toast.success(`Added ${name}`);
  };

  const toggleAvail = async (name) => {
    const target = technicians.find(t => t.name === name);
    if (!target) return;
    const prev = technicians;
    setBusy(`tech:${name}`, true);
    setTechnicians(technicians.map(t => t.name === name ? { ...t, available: !t.available } : t));
    const { error } = await supabase.from("technicians").update({ available: !target.available }).eq("name", name);
    setBusy(`tech:${name}`, false);
    if (error) { setTechnicians(prev); toast.error(`Couldn't update ${name}: ${error.message}`); }
  };

  const removeTech = async (name) => {
    const ok = await confirm(`Remove ${name} from the technician list?`, { danger: true, confirmLabel: "Remove" });
    if (!ok) return;
    const prev = technicians;
    setBusy(`tech:${name}`, true);
    setTechnicians(technicians.filter(t => t.name !== name));
    const { error } = await supabase.from("technicians").delete().eq("name", name);
    setBusy(`tech:${name}`, false);
    if (error) { setTechnicians(prev); toast.error(`Couldn't remove ${name}: ${error.message}`); return; }
    toast.success(`Removed ${name}`);
  };

  const techWorkload = useMemo(() => {
    const wl = {};
    technicians.forEach(t => { wl[t.name] = { inProgress: 0, inQueue: 0, onHold: 0 }; });
    requests.forEach(r => {
      const w = workflow[r.id];
      if (w?.technician && wl[w.technician]) {
        if (w.status === "In Progress") wl[w.technician].inProgress++;
        else if (w.status === "In Queue") wl[w.technician].inQueue++;
        else if (w.status === "On Hold") wl[w.technician].onHold++;
      }
    });
    return wl;
  }, [technicians, workflow, requests]);

  return (
    <div style={{ maxWidth: 700, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: H.navy, margin: 0 }}>Technician Management</h2>
        <p style={{ fontSize: 13, color: H.g400, margin: "4px 0 0" }}>Manage your service team and track workload</p>
      </div>

      <Card style={{ marginBottom: 16, padding: "14px 18px" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: H.g600, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4 }}>Add Technician</label>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Technician name..."
              onKeyDown={e => e.key === "Enter" && addTech()}
              style={{ width: "100%", padding: "9px 12px", border: `1.5px solid ${H.g200}`, borderRadius: 8, fontSize: 14, color: H.g800, background: H.white, outline: "none", boxSizing: "border-box" }} />
          </div>
          <button onClick={addTech} disabled={busy.has("tech:add")} style={{
            padding: "10px 20px", background: H.navy, color: H.white, border: "none", borderRadius: 8,
            fontSize: 13, fontWeight: 700, cursor: busy.has("tech:add") ? "wait" : "pointer", whiteSpace: "nowrap",
            display: "inline-flex", alignItems: "center", gap: 8, opacity: busy.has("tech:add") ? 0.6 : 1,
          }}>{busy.has("tech:add") && <Spinner />}+ Add</button>
        </div>
      </Card>

      {technicians.length === 0 ? (
        <Card style={{ textAlign: "center", padding: 40, color: H.g400 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>👨‍🔧</div>
          <div style={{ fontWeight: 600 }}>No technicians added yet</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Add your service team above to start assigning work</div>
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {technicians.map(t => {
            const wl = techWorkload[t.name] || { inProgress: 0, inQueue: 0, onHold: 0 };
            const totalActive = wl.inProgress + wl.inQueue + wl.onHold;
            const isBusy = busy.has(`tech:${t.name}`);
            return (
              <Card key={t.name} style={{ padding: "14px 18px", borderLeft: `4px solid ${t.available ? (totalActive > 3 ? H.yellow : H.green) : H.g400}` }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 36, height: 36, borderRadius: "50%", background: t.available ? H.blueBg : H.g100, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 700, color: t.available ? H.navy : H.g400 }}>
                      {t.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: t.available ? H.navy : H.g400, display: "flex", alignItems: "center", gap: 6 }}>
                        {t.name}{isBusy && <Spinner />}
                      </div>
                      <div style={{ fontSize: 11, color: H.g400 }}>
                        {t.available ? (totalActive === 0 ? "Available — no active jobs" : `${wl.inProgress} in progress · ${wl.inQueue} queued · ${wl.onHold} on hold`) : "Off Duty"}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {totalActive > 0 && (
                      <Badge bg={totalActive > 3 ? H.yellowBg : H.blueBg} color={totalActive > 3 ? "#E68A00" : H.blue}>
                        {totalActive} active
                      </Badge>
                    )}
                    <button onClick={() => toggleAvail(t.name)} disabled={isBusy} style={{
                      padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: isBusy ? "wait" : "pointer",
                      background: t.available ? H.greenBg : H.g100, color: t.available ? H.green : H.g600,
                      border: `1px solid ${t.available ? H.green : H.g200}`,
                    }}>{t.available ? "On Duty" : "Off Duty"}</button>
                    <button onClick={() => removeTech(t.name)} disabled={isBusy} style={{
                      padding: "5px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: isBusy ? "wait" : "pointer",
                      background: H.redBg, color: H.red, border: `1px solid ${H.red}`,
                    }}>Remove</button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════
// REQUEST ENTRY FORM
// ════════════════════════════════════════
function RequestEntryForm({ requests, setRequests, workflow, setWorkflow }) {
  const [form, setForm] = useState({ type: "", stock: "", vin: "", category: "", priority: "", notes: "", eta: "" });
  const [errors, setErrors] = useState({});
  const [vinWarning, setVinWarning] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  const handleVinChange = (v) => {
    setForm(f => ({ ...f, vin: v }));
    const clean = v.replace(/\s/g, "").toUpperCase();
    if (clean.length === 0) { setVinWarning(""); return; }
    if (/[IOQ]/.test(clean)) { setVinWarning("VIN cannot contain letters I, O, or Q"); return; }
    if (clean.length < 17) { setVinWarning(`${17 - clean.length} more character${17 - clean.length > 1 ? "s" : ""} needed`); return; }
    if (clean.length === 17) {
      const result = validateVIN(clean);
      if (!result.valid) { setVinWarning(result.error); return; }
      setVinWarning("");
    }
  };

  const validate = () => {
    const e = {};
    if (!form.type) e.type = "Required";
    if (!form.stock.trim()) e.stock = "Required";
    if (!form.vin.trim()) e.vin = "Required";
    else { const vinResult = validateVIN(form.vin); if (!vinResult.valid) e.vin = vinResult.error; }
    if (form.type !== "Pre-Owned" && !form.category) e.category = "Required";
    if (!form.priority) e.priority = "Required";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate()) return;
    const vinResult = validateVIN(form.vin);
    const cleanVin = vinResult.cleaned;

    if (form.type === "Pre-Owned") {
      const groupKey = cleanVin + "-" + form.stock.trim();
      const existing = requests.find(r => r.workflowGroup === groupKey);
      if (existing) {
        const allDone = requests.filter(r => r.workflowGroup === groupKey).every(r => workflow[r.id]?.status === "Completed");
        if (!allDone) {
          setErrors({ stock: "An active Pre-Owned workflow already exists for this Stock # + VIN combination" });
          return;
        }
      }
    }

    setSubmitting(true);
    const newRequests = [];
    const newWorkflowEntries = [];

    if (form.type === "Pre-Owned") {
      for (let i = 0; i < WORKFLOW_ORDER.length; i++) {
        const id = genId() + "-" + (i + 1);
        newRequests.push({
          id, type: form.type, stock: form.stock.trim(), vin: cleanVin,
          category: WORKFLOW_ORDER[i], priority: form.priority,
          notes: i === 0 ? form.notes : `Auto-created: ${WORKFLOW_ORDER[i]} for ${form.stock.trim()}`,
          created: now(), eta: form.eta || null,
          workflowGroup: cleanVin + "-" + form.stock.trim(), workflowStep: i,
        });
        newWorkflowEntries.push({
          id,
          w: { workOrder: "", status: i === 0 ? "In Queue" : "Pending", technician: "", startTime: null, completionTime: null, serviceNotes: "" },
        });
      }
    } else {
      const id = genId();
      newRequests.push({
        id, type: form.type, stock: form.stock.trim(), vin: cleanVin,
        category: form.category, priority: form.priority,
        notes: form.notes, created: now(), eta: form.eta || null,
        workflowGroup: null, workflowStep: null,
      });
      newWorkflowEntries.push({
        id,
        w: { workOrder: "", status: "In Queue", technician: "", startTime: null, completionTime: null, serviceNotes: "" },
      });
    }

    const { error: reqErr } = await supabase.from("requests").insert(newRequests.map(reqToRow));
    if (reqErr) { setSubmitting(false); toast.error(`Couldn't save request: ${reqErr.message}`); return; }
    const { error: wfErr } = await supabase.from("workflow").insert(newWorkflowEntries.map(({ id, w }) => wfToRow(id, w)));
    if (wfErr) {
      await supabase.from("requests").delete().in("id", newRequests.map(r => r.id));
      setSubmitting(false);
      toast.error(`Couldn't save workflow: ${wfErr.message}`);
      return;
    }

    setRequests([...requests, ...newRequests]);
    const wfMerged = { ...workflow };
    newWorkflowEntries.forEach(({ id, w }) => { wfMerged[id] = w; });
    setWorkflow(wfMerged);
    const wasPreOwned = form.type === "Pre-Owned";
    setForm({ type: "", stock: "", vin: "", category: "", priority: "", notes: "", eta: "" });
    setErrors({}); setVinWarning("");
    setSubmitting(false);
    toast.success(wasPreOwned ? "Pre-Owned workflow created — Reconditioning → Safety → Delivery Prep" : "Request submitted successfully");
  };

  const recentGroups = useMemo(() => {
    const groups = []; const seen = new Set();
    for (const r of [...requests].reverse()) {
      if (r.workflowGroup) {
        if (seen.has(r.workflowGroup)) continue;
        seen.add(r.workflowGroup);
        groups.push({ type: "group", items: requests.filter(x => x.workflowGroup === r.workflowGroup).sort((a, b) => a.workflowStep - b.workflowStep), key: r.workflowGroup });
      } else { groups.push({ type: "single", item: r, key: r.id }); }
    }
    return groups.slice(0, 10);
  }, [requests]);

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: H.navy, margin: 0 }}>New Service Request</h2>
        <p style={{ fontSize: 13, color: H.g400, margin: "4px 0 0" }}>Submit a request for the service department</p>
      </div>
      <Card>
        <div className="form-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
          <Select label="Request Type" value={form.type} onChange={v => setForm(f => ({ ...f, type: v, category: v === "Pre-Owned" ? "" : f.category }))} options={REQUEST_TYPES} placeholder="Select type..." required />
          <Select label="Priority" value={form.priority} onChange={v => setForm(f => ({ ...f, priority: v }))} options={PRIORITIES} placeholder="Select priority..." required />
          <Input label="Stock Number" value={form.stock} onChange={v => setForm(f => ({ ...f, stock: v }))} placeholder="e.g. A12345" required error={errors.stock} />
          <Input label="VIN" value={form.vin} onChange={handleVinChange} placeholder="e.g. 1HGBH41JXMN109186" maxLength={17} required error={errors.vin}
            hint={vinWarning ? vinWarning : (form.vin.length > 0 && form.vin.replace(/\s/g, "").length === 17 && !errors.vin ? "✓ Valid VIN" : "17 characters, no I/O/Q")} />
          {form.type !== "Pre-Owned" && <Select label="Request Category" value={form.category} onChange={v => setForm(f => ({ ...f, category: v }))} options={CATEGORIES} placeholder="Select category..." required />}
          <Input label="ETA / Due Date" value={form.eta} onChange={v => setForm(f => ({ ...f, eta: v }))} type="date" />
        </div>
        {form.type === "Pre-Owned" && (
          <div style={{ padding: "10px 14px", background: H.blueBg, borderRadius: 8, marginBottom: 14, fontSize: 12, color: H.steel, lineHeight: 1.5 }}>
            <strong>Pre-Owned Workflow:</strong> 3 sequential stages — Reconditioning → Safety → Delivery Prep. Each must complete before the next unlocks.
          </div>
        )}
        <div style={{ marginBottom: 14 }}>
          <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: H.g600, marginBottom: 4, letterSpacing: 0.4, textTransform: "uppercase" }}>Issue / Notes</label>
          <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Describe the issue or work required..." rows={3}
            style={{ width: "100%", padding: "9px 12px", border: `1.5px solid ${H.g200}`, borderRadius: 8, fontSize: 14, color: H.g800, background: H.white, outline: "none", boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }} />
        </div>
        <button onClick={submit} disabled={submitting} style={{ width: "100%", padding: "12px", background: H.navy, color: H.white, border: "none", borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: submitting ? "wait" : "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 10, opacity: submitting ? 0.7 : 1 }}
          onMouseEnter={e => e.target.style.background = H.steel} onMouseLeave={e => e.target.style.background = H.navy}>
          {submitting && <Spinner size={14} />}
          Submit Request
        </button>
      </Card>

      {recentGroups.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: H.navy, marginBottom: 10 }}>Recent Submissions ({recentGroups.length})</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {recentGroups.map(g => {
              if (g.type === "single") {
                const r = g.item, w = workflow[r.id];
                return (
                  <Card key={g.key} style={{ padding: "12px 16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: H.navy }}>{r.stock}</span>
                      <Badge bg={H.g100} color={H.g600}>{r.category}</Badge>
                      <PriorityBadge priority={r.priority} />
                      {w && <StatusBadge status={w.status} eta={r.eta} />}
                      <span style={{ fontSize: 11, color: H.g400, marginLeft: "auto" }}>{fmt(r.created)}</span>
                    </div>
                    <div style={{ fontSize: 11, color: H.g400, marginTop: 4 }}>VIN: <span style={{ fontFamily: "monospace", color: H.g600 }}>{r.vin}</span></div>
                  </Card>
                );
              }
              const first = g.items[0];
              return (
                <Card key={g.key} style={{ padding: "12px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
                    <Badge bg={H.blueBg} color={H.steel}>Pre-Owned</Badge>
                    <span style={{ fontSize: 13, fontWeight: 700, color: H.navy }}>{first.stock}</span>
                    <PriorityBadge priority={first.priority} />
                    <span style={{ fontSize: 11, color: H.g400, marginLeft: "auto" }}>{fmt(first.created)}</span>
                  </div>
                  <div style={{ fontSize: 11, color: H.g400, marginBottom: 8 }}>VIN: <span style={{ fontFamily: "monospace", color: H.g600 }}>{first.vin}</span></div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    {g.items.map((r, i) => {
                      const w = workflow[r.id]; const sc = stColor(w?.status || "Pending", r.eta);
                      return (<React.Fragment key={r.id}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 10px", borderRadius: 6, background: sc.bg }}>
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: sc.dot }} />
                          <span style={{ fontSize: 11, fontWeight: 600, color: sc.text }}>{r.category}</span>
                        </div>
                        {i < g.items.length - 1 && <span style={{ color: H.g200, fontSize: 14 }}>→</span>}
                      </React.Fragment>);
                    })}
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════
// WORKFLOW TRACKER
// ════════════════════════════════════════
function WorkflowTracker({ requests, setRequests, workflow, setWorkflow, technicians, singleEntryKey, onEntryGone }) {
  const [filter, setFilter] = useState("Active");
  const [search, setSearch] = useState("");
  const toast = useToast();
  const { confirm } = useAppConfirm();
  const { busy, setBusy } = useLoading();
  // When `singleEntryKey` is set, this component is being rendered inside the
  // detail drawer — render only that one entry, hide the list chrome (title,
  // search, filter pills), and tell the parent to close the drawer if the
  // entry no longer exists (e.g. user just deleted it).
  const isDrawer = !!singleEntryKey;

  const updateRequest = async (id, field, value) => {
    const prev = requests;
    const updated = requests.map(r => r.id === id ? { ...r, [field]: value } : r);
    setRequests(updated);
    setBusy(`req:${id}`, true);
    const { error } = await supabase.from("requests").update({ [field]: value }).eq("id", id);
    setBusy(`req:${id}`, false);
    if (error) { setRequests(prev); toast.error(`Couldn't save: ${error.message}`); }
  };

  const canChangeStatus = (req, newStatus) => {
    if (!req.workflowGroup) return true;
    if (newStatus === "Pending") return false;
    const group = requests.filter(r => r.workflowGroup === req.workflowGroup).sort((a, b) => a.workflowStep - b.workflowStep);
    const myIdx = group.findIndex(r => r.id === req.id);
    if (myIdx === 0) return true;
    return workflow[group[myIdx - 1].id]?.status === "Completed";
  };

  const persistWorkflow = async (id, w) => {
    const { error } = await supabase.from("workflow").update(wfToRow(id, w)).eq("request_id", id);
    return error;
  };

  const updateStatus = async (id, newStatus) => {
    const prev = workflow;
    const updated = { ...workflow };
    const entry = { ...updated[id] };
    const req = requests.find(r => r.id === id);
    // Industry practice: one Work Order per vehicle visit, not per stage.
    // For Pre-Owned (workflowGroup), all stages share the same WO#.
    // Generate once on the first stage that hits "In Progress"; reuse on the rest.
    const propagatedWoIds = []; // sibling ids that we wrote the shared WO# to
    if (newStatus === "In Progress" && !entry.startTime) {
      entry.startTime = now();
      if (!entry.workOrder) {
        let sharedWo = null;
        let groupSiblings = [];
        if (req?.workflowGroup) {
          groupSiblings = requests.filter(r => r.workflowGroup === req.workflowGroup);
          for (const s of groupSiblings) {
            if (workflow[s.id]?.workOrder) { sharedWo = workflow[s.id].workOrder; break; }
          }
        }
        if (!sharedWo) {
          try { sharedWo = await generateWorkOrder(); }
          catch (e) { toast.error(`Couldn't generate Work Order: ${e.message || e}`); return; }
        }
        entry.workOrder = sharedWo;
        // Propagate to sibling stages so the WO# is visible on all of them now.
        if (req?.workflowGroup) {
          for (const sib of groupSiblings) {
            if (sib.id !== id && !updated[sib.id]?.workOrder) {
              updated[sib.id] = { ...updated[sib.id], workOrder: sharedWo };
              propagatedWoIds.push(sib.id);
            }
          }
        }
      }
    }
    let nextUnlock = null;
    if (newStatus === "Completed") {
      entry.completionTime = now();
      if (!entry.startTime) entry.startTime = entry.completionTime;
      if (req?.workflowGroup) {
        const group = requests.filter(r => r.workflowGroup === req.workflowGroup).sort((a, b) => a.workflowStep - b.workflowStep);
        const myIdx = group.findIndex(r => r.id === id);
        if (myIdx < group.length - 1) {
          const next = group[myIdx + 1];
          if (updated[next.id]?.status === "Pending") {
            nextUnlock = next.id;
            updated[next.id] = { ...updated[next.id], status: "In Queue" };
          }
        }
      }
    }
    entry.status = newStatus;
    updated[id] = entry;
    setBusy(`wf:${id}`, true);
    setWorkflow(updated);
    // Persist this row + any sibling rows we just wrote a shared WO# to + the
    // optionally-unlocked next stage. All in parallel.
    const idsToPersist = new Set([id, ...propagatedWoIds]);
    if (nextUnlock) idsToPersist.add(nextUnlock);
    const errors = await Promise.all(
      [...idsToPersist].map(pid => persistWorkflow(pid, updated[pid]))
    );
    setBusy(`wf:${id}`, false);
    const failure = errors.find(Boolean);
    if (failure) {
      setWorkflow(prev);
      toast.error(`Couldn't save status: ${failure.message}`);
    }
  };

  const updateField = async (id, field, value) => {
    const prev = workflow;
    const updated = { ...workflow, [id]: { ...workflow[id], [field]: value } };
    setWorkflow(updated);
    setBusy(`wf:${id}`, true);
    const colMap = { workOrder: "work_order", technician: "technician", serviceNotes: "service_notes" };
    const col = colMap[field] || field;
    const { error } = await supabase.from("workflow").update({ [col]: value || null }).eq("request_id", id);
    setBusy(`wf:${id}`, false);
    if (error) { setWorkflow(prev); toast.error(`Couldn't save: ${error.message}`); }
  };

  const deleteOne = async (id) => {
    const prev = { req: requests, wf: workflow };
    setBusy(`del:${id}`, true);
    setRequests(requests.filter(r => r.id !== id));
    const wfNew = { ...workflow }; delete wfNew[id]; setWorkflow(wfNew);
    const { error } = await supabase.from("requests").delete().eq("id", id);
    setBusy(`del:${id}`, false);
    if (error) { setRequests(prev.req); setWorkflow(prev.wf); toast.error(`Couldn't delete: ${error.message}`); return false; }
    toast.success("Request deleted");
    return true;
  };

  const deleteGroup = async (groupKey) => {
    const ids = requests.filter(r => r.workflowGroup === groupKey).map(r => r.id);
    if (ids.length === 0) return false;
    const prev = { req: requests, wf: workflow };
    setBusy(`del:${groupKey}`, true);
    setRequests(requests.filter(r => r.workflowGroup !== groupKey));
    const wfNew = { ...workflow }; ids.forEach(i => delete wfNew[i]); setWorkflow(wfNew);
    const { error } = await supabase.from("requests").delete().eq("workflow_group", groupKey);
    setBusy(`del:${groupKey}`, false);
    if (error) { setRequests(prev.req); setWorkflow(prev.wf); toast.error(`Couldn't delete group: ${error.message}`); return false; }
    toast.success(`Deleted ${ids.length} stages`);
    return true;
  };

  const onDeleteSingle = async (id) => {
    const ok = await confirm("Delete this request? This cannot be undone.", { danger: true, confirmLabel: "Delete" });
    if (ok) await deleteOne(id);
  };

  const onDeleteGroup = async (groupKey, stageId) => {
    const choice = await confirm(
      "This is part of a Pre-Owned workflow. What would you like to delete?",
      {
        title: "Delete Pre-Owned workflow",
        danger: true,
        buttons: [
          { value: "cancel", label: "Cancel" },
          { value: "stage", label: "This stage only", danger: true },
          { value: "group", label: "Entire group", danger: true },
        ],
      }
    );
    if (choice === "stage") await deleteOne(stageId);
    else if (choice === "group") await deleteGroup(groupKey);
  };

  const vehicleEntries = useMemo(() => {
    const entries = []; const seenGroups = new Set();
    for (const r of requests) {
      if (r.workflowGroup) {
        if (seenGroups.has(r.workflowGroup)) continue;
        seenGroups.add(r.workflowGroup);
        const items = requests.filter(x => x.workflowGroup === r.workflowGroup).sort((a, b) => a.workflowStep - b.workflowStep);
        const activeStep = items.find(x => { const s = workflow[x.id]?.status; return s && s !== "Completed" && s !== "Pending"; }) || items.find(x => workflow[x.id]?.status === "In Queue") || items[items.length - 1];
        const allCompleted = items.every(x => workflow[x.id]?.status === "Completed");
        const anyOverdue = items.some(x => isOverdue(x.eta, workflow[x.id]?.status));
        entries.push({ kind: "group", items, key: r.workflowGroup, stock: r.stock, vin: r.vin, priority: r.priority, eta: r.eta, overallStatus: allCompleted ? "Completed" : (activeStep ? workflow[activeStep.id]?.status : "In Queue"), anyOverdue, id: activeStep?.id || r.id, techs: items.map(x => workflow[x.id]?.technician).filter(Boolean).join(" "), wos: items.map(x => workflow[x.id]?.workOrder).filter(Boolean).join(" ") });
      } else {
        const w = workflow[r.id]; if (!w) continue;
        entries.push({ kind: "single", item: r, key: r.id, stock: r.stock, vin: r.vin, priority: r.priority, eta: r.eta, overallStatus: w.status, anyOverdue: isOverdue(r.eta, w.status), id: r.id, techs: w.technician || "", wos: w.workOrder || "" });
      }
    }
    return entries;
  }, [requests, workflow]);

  const filtered = useMemo(() => {
    let result = vehicleEntries;
    if (filter === "Active") result = result.filter(e => e.overallStatus !== "Completed");
    else if (filter !== "All") result = result.filter(e => e.overallStatus === filter);
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(e => e.stock.toLowerCase().includes(q) || e.vin.toLowerCase().includes(q) || e.techs.toLowerCase().includes(q) || e.wos.toLowerCase().includes(q));
    }
    return result;
  }, [vehicleEntries, filter, search]);

  const sorted = useMemo(() => [...filtered].sort((a, b) => {
    const odA = a.anyOverdue ? 0 : 1, odB = b.anyOverdue ? 0 : 1;
    if (odA !== odB) return odA - odB;
    const po = { High: 0, Medium: 1, Low: 2 };
    if (po[a.priority] !== po[b.priority]) return po[a.priority] - po[b.priority];
    if (a.eta && b.eta) return new Date(a.eta) - new Date(b.eta);
    return 0;
  }), [filtered]);

  const counts = useMemo(() => {
    const c = { All: vehicleEntries.length, Active: 0, "In Queue": 0, "In Progress": 0, "On Hold": 0, Completed: 0 };
    vehicleEntries.forEach(e => { if (e.overallStatus !== "Completed") c.Active++; if (c[e.overallStatus] !== undefined) c[e.overallStatus]++; });
    return c;
  }, [vehicleEntries]);

  // In drawer mode, override sorted to be just the one matching entry.
  const visible = isDrawer ? vehicleEntries.filter(e => e.key === singleEntryKey) : sorted;

  // Drawer auto-close: if the entry vanishes (user deleted it), notify parent.
  useEffect(() => {
    if (isDrawer && onEntryGone && !vehicleEntries.find(e => e.key === singleEntryKey)) {
      onEntryGone();
    }
  }, [isDrawer, singleEntryKey, vehicleEntries, onEntryGone]);

  const StepRow = ({ r, isLast, groupKey }) => {
    const w = workflow[r.id]; if (!w) return null;
    const isPending = w.status === "Pending";
    const sc = stColor(w.status, r.eta);
    const saving = busy.has(`wf:${r.id}`) || busy.has(`req:${r.id}`) || busy.has(`del:${r.id}`);
    return (
      <div style={{ padding: "10px 14px", background: isPending ? H.g100 : "transparent", borderBottom: isLast ? "none" : `1px solid ${H.g100}`, opacity: isPending ? 0.5 : 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: isPending ? 0 : 8, flexWrap: "wrap" }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: sc.dot, flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: isPending ? H.g400 : H.navy }}>{r.category}</span>
          <StatusBadge status={w.status} eta={r.eta} />
          {w.workOrder && <Badge bg={H.g100} color={H.g600} style={{ fontFamily: "monospace", fontSize: 10 }}>{w.workOrder}</Badge>}
          {w.startTime && w.completionTime && <span style={{ fontSize: 11, color: H.g400 }}>Time: <strong style={{ color: H.navy }}>{timeDiff(w.startTime, w.completionTime)}</strong></span>}
          {isPending && <span style={{ fontSize: 11, color: H.g400, fontStyle: "italic" }}>Waiting for previous stage</span>}
          {saving && <Spinner />}
        </div>
        {!isPending && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginLeft: 16 }}>
            <InlineSelect label="Status" value={w.status} options={STATUSES}
              onChange={ns => { if (canChangeStatus(r, ns)) updateStatus(r.id, ns); else toast.error("Complete the previous stage first."); }} />
            <InlineField label="Work Order #" value={w.workOrder} onChange={v => updateField(r.id, "workOrder", v)} placeholder="Auto on start" small readOnly={!!w.workOrder} />
            <TechSelect label="Technician" value={w.technician} onChange={v => updateField(r.id, "technician", v)} technicians={technicians} workflow={workflow} requests={requests} eta={r.eta} />
            {(w.startTime || w.completionTime) && (
              <div style={{ alignSelf: "flex-end", fontSize: 11, color: H.g400, paddingBottom: 6 }}>
                {w.startTime && <>Started: {fmt(w.startTime)}</>}
                {w.completionTime && <> · Done: {fmt(w.completionTime)}</>}
              </div>
            )}
            <div style={{ flex: "1 1 100%", marginTop: 6 }}>
              <InlineTextarea label="Service Notes" value={w.serviceNotes} placeholder="Add service team notes (saves on blur)…"
                onSave={v => updateField(r.id, "serviceNotes", v)} rows={2} />
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      {!isDrawer && (
        <>
          <div style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: H.navy, margin: 0 }}>Service Workflow Tracker</h2>
            <p style={{ fontSize: 13, color: H.g400, margin: "4px 0 0" }}>Manage and update service requests — grouped by vehicle</p>
          </div>
          <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
            <SearchBar value={search} onChange={setSearch} placeholder="Search by VIN, Stock #, Technician, Work Order..." />
          </div>
          <div style={{ display: "flex", gap: 4, background: H.g100, borderRadius: 8, padding: 3, marginBottom: 16, flexWrap: "wrap" }}>
            {["All", "Active", "In Queue", "In Progress", "On Hold", "Completed"].map(f => (
              <FilterPill key={f} active={filter === f} label={f} count={counts[f]} onClick={() => setFilter(f)} />
            ))}
          </div>
        </>
      )}

      {visible.length === 0 ? (
        !isDrawer && (
          <Card style={{ textAlign: "center", padding: 40, color: H.g400 }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
            <div style={{ fontWeight: 600 }}>No vehicles match{search ? ` "${search}"` : " the filter"}</div>
          </Card>
        )
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {visible.map(entry => {
            if (entry.kind === "single") {
              const r = entry.item, w = workflow[r.id]; if (!w) return null;
              const od = isOverdue(r.eta, w.status);
              const saving = busy.has(`wf:${r.id}`) || busy.has(`req:${r.id}`) || busy.has(`del:${r.id}`);
              const hl = false;
              return (
                <Card key={entry.key} id={`entry-${entry.key}`} style={{ padding: 0, borderLeft: `4px solid ${od ? H.red : stColor(w.status, r.eta).dot}`, position: "relative", outline: hl ? `3px solid ${H.accent}` : "none", transition: "outline 0.3s" }}>
                  <div style={{ padding: "14px 18px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 15, fontWeight: 700, color: H.navy }}>{r.stock}</span>
                      <Badge bg={H.g100} color={H.g600}>{r.category}</Badge>
                      <PriorityBadge priority={r.priority} />
                      <StatusBadge status={w.status} eta={r.eta} />
                      {w.workOrder && <Badge bg={H.g100} color={H.g600} style={{ fontFamily: "monospace", fontSize: 10 }}>{w.workOrder}</Badge>}
                      {saving && <Spinner />}
                      <button onClick={() => onDeleteSingle(r.id)} title="Delete request"
                        style={{ marginLeft: "auto", padding: "4px 10px", border: `1px solid ${H.red}`, background: H.redBg, color: H.red, borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                        Delete
                      </button>
                    </div>
                    <div style={{ fontSize: 12, color: H.g400, marginBottom: 10 }}>
                      VIN: <span style={{ fontFamily: "monospace", color: H.g600 }}>{r.vin}</span>
                      {r.eta && <> · Due: <span style={{ color: od ? H.red : H.g600, fontWeight: od ? 700 : 400 }}>{fmtDate(r.eta)}</span></>}
                      {r.eta && w.status !== "Completed" && <> · <span style={{ color: od ? H.red : H.blue, fontWeight: 600 }}>{timeRemaining(r.eta)}</span></>}
                    </div>
                    <div style={{ marginBottom: 10 }}>
                      <InlineTextarea label="Issue / Notes" value={r.notes} placeholder="Describe the issue (saves on blur)…"
                        onSave={v => updateRequest(r.id, "notes", v)} rows={2} />
                    </div>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                      <InlineSelect label="Status" value={w.status} options={STATUSES} onChange={ns => updateStatus(r.id, ns)} />
                      <InlineSelect label="Priority" value={r.priority} options={PRIORITIES} onChange={v => updateRequest(r.id, "priority", v)} />
                      <InlineSelect label="Category" value={r.category} options={CATEGORIES} onChange={v => updateRequest(r.id, "category", v)} />
                      <InlineField label="Work Order #" value={w.workOrder} onChange={v => updateField(r.id, "workOrder", v)} placeholder="Auto on start" small readOnly={!!w.workOrder} />
                      <div>
                        <label style={{ fontSize: 10, fontWeight: 600, color: H.g400, textTransform: "uppercase", display: "block", marginBottom: 2 }}>Due Date</label>
                        <input type="date" value={r.eta || ""} onChange={e => updateRequest(r.id, "eta", e.target.value || null)}
                          style={{ padding: "5px 8px", borderRadius: 6, border: `1px solid ${H.g200}`, fontSize: 12, background: H.white }} />
                      </div>
                      <TechSelect label="Technician" value={w.technician} onChange={v => updateField(r.id, "technician", v)} technicians={technicians} workflow={workflow} requests={requests} eta={r.eta} />
                    </div>
                    <div style={{ marginTop: 10 }}>
                      <InlineTextarea label="Service Notes" value={w.serviceNotes} placeholder="Service team notes (saves on blur)…"
                        onSave={v => updateField(r.id, "serviceNotes", v)} rows={2} />
                    </div>
                    {(w.startTime || w.completionTime) && (
                      <div style={{ fontSize: 11, color: H.g400, marginTop: 8 }}>
                        {w.startTime && <>Started: {fmt(w.startTime)}</>}
                        {w.completionTime && <> · Done: {fmt(w.completionTime)}</>}
                        {w.startTime && w.completionTime && <> · <strong style={{ color: H.navy }}>{timeDiff(w.startTime, w.completionTime)}</strong></>}
                      </div>
                    )}
                  </div>
                </Card>
              );
            }
            const first = entry.items[0]; const od = entry.anyOverdue;
            const allDone = entry.items.every(x => workflow[x.id]?.status === "Completed");
            const groupSaving = busy.has(`del:${entry.key}`);
            const hl = highlightKey === entry.key;
            return (
              <Card key={entry.key} id={`entry-${entry.key}`} style={{ padding: 0, borderLeft: `4px solid ${allDone ? H.green : od ? H.red : H.blue}`, position: "relative", outline: hl ? `3px solid ${H.accent}` : "none", transition: "outline 0.3s" }}>
                <div style={{ padding: "14px 18px 10px", borderBottom: `1px solid ${H.g100}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: H.navy }}>{first.stock}</span>
                    <Badge bg={H.blueBg} color={H.steel}>Pre-Owned Workflow</Badge>
                    <PriorityBadge priority={first.priority} />
                    {allDone && <Badge bg={H.greenBg} color={H.green}>All Complete</Badge>}
                    {od && !allDone && <Badge bg={H.redBg} color={H.red}>OVERDUE</Badge>}
                    {groupSaving && <Spinner />}
                    <button onClick={() => onDeleteGroup(entry.key, entry.items[0].id)} title="Delete group or stage"
                      style={{ marginLeft: "auto", padding: "4px 10px", border: `1px solid ${H.red}`, background: H.redBg, color: H.red, borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                      Delete…
                    </button>
                  </div>
                  <div style={{ fontSize: 12, color: H.g400 }}>
                    VIN: <span style={{ fontFamily: "monospace", color: H.g600 }}>{first.vin}</span>
                    {first.eta && <> · Due: <span style={{ color: od ? H.red : H.g600, fontWeight: od ? 700 : 400 }}>{fmtDate(first.eta)}</span></>}
                    {first.eta && !allDone && <> · <span style={{ color: od ? H.red : H.blue, fontWeight: 600 }}>{timeRemaining(first.eta)}</span></>}
                  </div>
                  <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                    <InlineSelect label="Priority" value={first.priority} options={PRIORITIES} onChange={v => { entry.items.forEach(r => updateRequest(r.id, "priority", v)); }} />
                    <div>
                      <label style={{ fontSize: 10, fontWeight: 600, color: H.g400, textTransform: "uppercase", display: "block", marginBottom: 2 }}>Due Date</label>
                      <input type="date" value={first.eta || ""} onChange={e => { const val = e.target.value || null; entry.items.forEach(r => updateRequest(r.id, "eta", val)); }}
                        style={{ padding: "5px 8px", borderRadius: 6, border: `1px solid ${H.g200}`, fontSize: 12, background: H.white }} />
                    </div>
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <InlineTextarea label="Vehicle Notes" value={first.notes} placeholder="Notes shared across all stages (saves on blur)…"
                      onSave={v => updateRequest(first.id, "notes", v)} rows={2} />
                  </div>
                  <div style={{ display: "flex", gap: 4, marginTop: 10 }}>
                    {entry.items.map((r, i) => {
                      const w = workflow[r.id]; const bgc = w?.status === "Completed" ? H.green : w?.status === "In Progress" ? H.blue : w?.status === "On Hold" ? H.yellow : w?.status === "In Queue" ? H.g400 : H.g200;
                      return (<div key={r.id} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                        <div style={{ width: "100%", height: 6, borderRadius: 3, background: bgc }} />
                        <span style={{ fontSize: 10, fontWeight: 600, color: stColor(w?.status || "Pending", r.eta).text }}>{["Recon", "Safety", "Delivery"][i]}</span>
                      </div>);
                    })}
                  </div>
                </div>
                {entry.items.map((r, i) => <StepRow key={r.id} r={r} groupKey={entry.key} isLast={i === entry.items.length - 1} />)}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════
//
// Vehicle-grouped view: Pre-Owned vehicles render as ONE row (with mini stage
// strip and X/3 progress) instead of three separate rows. Single requests
// render as one row each. Type column distinguishes New / Pre-Owned / Demo /
// General Service. Aging badge flags work that's been "In Progress" too long.
// Pre-Owned funnel + Tech utilization replace the old Priority/Stages cards.
// Click any row → jumps to that vehicle in the Workflow tab.
function Dashboard({ requests, workflow, technicians, onOpenDrawer }) {
  const [search, setSearch] = useState("");
  const [dashFilter, setDashFilter] = useState({ status: "All", priority: "All", technician: "All", type: "All" });

  // ── Build vehicle-grouped entries (one row per vehicle, not per stage) ──
  const entries = useMemo(() => {
    const out = []; const seen = new Set();
    for (const r of requests) {
      if (r.workflowGroup) {
        if (seen.has(r.workflowGroup)) continue;
        seen.add(r.workflowGroup);
        const items = requests
          .filter(x => x.workflowGroup === r.workflowGroup)
          .sort((a, b) => a.workflowStep - b.workflowStep);
        const completed = items.filter(x => workflow[x.id]?.status === "Completed").length;
        const allDone = completed === items.length;
        const active = items.find(x => { const s = workflow[x.id]?.status; return s && s !== "Completed" && s !== "Pending"; })
                    || items.find(x => workflow[x.id]?.status === "In Queue")
                    || items[items.length - 1];
        const activeWf = workflow[active.id] || {};
        const anyOverdue = items.some(x => isOverdue(x.eta, workflow[x.id]?.status));
        out.push({
          kind: "group", key: r.workflowGroup, jumpKey: r.workflowGroup,
          type: r.type, stock: r.stock, vin: r.vin, priority: r.priority, eta: r.eta,
          stageItems: items, completed, allDone,
          activeStage: active.category,
          status: allDone ? "Completed" : (activeWf.status || "In Queue"),
          technician: activeWf.technician || "",
          workOrder: activeWf.workOrder || "",
          startTime: activeWf.startTime,
          anyOverdue,
        });
      } else {
        const w = workflow[r.id]; if (!w) continue;
        out.push({
          kind: "single", key: r.id, jumpKey: r.id,
          type: r.type, stock: r.stock, vin: r.vin, priority: r.priority, eta: r.eta,
          category: r.category,
          status: w.status,
          technician: w.technician || "",
          workOrder: w.workOrder || "",
          startTime: w.startTime,
          anyOverdue: isOverdue(r.eta, w.status),
        });
      }
    }
    return out;
  }, [requests, workflow]);

  // Active = anything not completed AND not just sitting in Pending limbo
  const active = entries.filter(e => e.status !== "Completed" && e.status !== "Pending");

  // ── Vehicle-grouped metrics ──
  const total = active.length;
  const inQueue = active.filter(e => e.status === "In Queue").length;
  const inProgress = active.filter(e => e.status === "In Progress").length;
  const onHold = active.filter(e => e.status === "On Hold").length;
  const overdueCount = active.filter(e => e.anyOverdue).length;
  // Done Today: count any individual stage completion today (per-record event)
  const today = new Date().toDateString();
  const completedToday = requests.filter(r => {
    const w = workflow[r.id];
    return w?.status === "Completed" && w.completionTime && new Date(w.completionTime).toDateString() === today;
  }).length;

  // ── Pre-Owned funnel (active vehicles by current stage) ──
  const funnel = useMemo(() => {
    const c = { "Reconditioning": 0, "Safety": 0, "Delivery Preparation": 0 };
    active.forEach(e => { if (e.kind === "group" && c[e.activeStage] !== undefined) c[e.activeStage]++; });
    return c;
  }, [active]);
  const funnelMax = Math.max(funnel["Reconditioning"], funnel["Safety"], funnel["Delivery Preparation"], 1);

  // ── Technician utilization ──
  const techUtil = useMemo(() => {
    const wl = {};
    (technicians || []).forEach(t => { wl[t.name] = { count: 0, available: t.available }; });
    requests.forEach(r => {
      const w = workflow[r.id];
      if (w?.technician && wl[w.technician] !== undefined && (w.status === "In Progress" || w.status === "In Queue" || w.status === "On Hold")) {
        wl[w.technician].count++;
      }
    });
    const sorted = Object.entries(wl)
      .filter(([, v]) => v.available)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 3);
    const onDuty = (technicians || []).filter(t => t.available).length;
    const offDuty = (technicians || []).filter(t => !t.available).length;
    return { top: sorted, onDuty, offDuty };
  }, [technicians, requests, workflow]);

  // ── Filters + sort ──
  const techList = [...new Set(active.map(e => e.technician).filter(Boolean))];
  const filtered = active.filter(e => {
    if (dashFilter.status !== "All" && e.status !== dashFilter.status) return false;
    if (dashFilter.priority !== "All" && e.priority !== dashFilter.priority) return false;
    if (dashFilter.technician !== "All" && e.technician !== dashFilter.technician) return false;
    if (dashFilter.type !== "All" && e.type !== dashFilter.type) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      if (!e.stock.toLowerCase().includes(q) && !e.vin.toLowerCase().includes(q) && !(e.technician || "").toLowerCase().includes(q) && !(e.workOrder || "").toLowerCase().includes(q)) return false;
    }
    return true;
  });
  const sorted = [...filtered].sort((a, b) => {
    const odA = a.anyOverdue ? 0 : 1, odB = b.anyOverdue ? 0 : 1;
    if (odA !== odB) return odA - odB;
    const po = { High: 0, Medium: 1, Low: 2 };
    if (po[a.priority] !== po[b.priority]) return po[a.priority] - po[b.priority];
    if (a.eta && b.eta) return new Date(a.eta) - new Date(b.eta);
    if (a.eta) return -1; if (b.eta) return 1; return 0;
  });

  // ── CSV export of currently visible (filtered + sorted) rows ──
  const exportCsv = () => {
    if (sorted.length === 0) return;
    const rows = sorted.map(e => ({
      "Stock #": e.stock,
      "Type": e.type,
      "VIN": e.vin,
      "Category / Stage": e.kind === "group" ? `${e.activeStage} (${e.completed}/${e.stageItems.length})` : e.category,
      "Status": e.status,
      "Priority": e.priority,
      "Technician": e.technician || "",
      "Work Order #": e.workOrder || "",
      "ETA": e.eta || "",
      "Overdue": e.anyOverdue ? "YES" : "NO",
    }));
    const escape = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const headers = Object.keys(rows[0]);
    const csv = [headers.join(","), ...rows.map(r => headers.map(h => escape(r[h])).join(","))].join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `service-tracker-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Aging helper: returns hours since startTime ──
  const ageHours = (start) => start ? (Date.now() - new Date(start).getTime()) / 3600000 : null;
  const isAging = (e) => {
    const h = ageHours(e.startTime);
    if (h === null) return false;
    if (e.status === "In Progress" && h > 24) return h;
    if (e.status === "On Hold" && h > 12) return h;
    return false;
  };
  const fmtAge = (h) => h >= 24 ? `${Math.floor(h / 24)}d ${Math.floor(h % 24)}h` : `${Math.floor(h)}h`;

  // ── Mini stage strip for Pre-Owned rows ──
  const StageStrip = ({ items }) => (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
      {items.map((it, i) => {
        const s = workflow[it.id]?.status;
        const dot = s === "Completed" ? H.green
          : s === "In Progress" ? H.blue
          : s === "On Hold" ? H.yellow
          : s === "In Queue" ? H.g400 : H.g200;
        return (
          <React.Fragment key={it.id}>
            <span title={`${["Recon","Safety","Delivery"][i]}: ${s || "Pending"}`} style={{
              width: 10, height: 10, borderRadius: 3, background: dot, display: "inline-block",
            }} />
            {i < items.length - 1 && <span style={{ width: 6, height: 1, background: H.g200 }} />}
          </React.Fragment>
        );
      })}
    </div>
  );

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: H.navy, margin: 0 }}>Live Dashboard</h2>
        <p style={{ fontSize: 13, color: H.g400, margin: "4px 0 0" }}>Real-time overview · vehicles grouped (one row per Pre-Owned)</p>
      </div>

      {/* Metric cards */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
        <MetricCard label="Total Active" value={total} color={H.navy} />
        <MetricCard label="In Queue" value={inQueue} color={H.g400} />
        <MetricCard label="In Progress" value={inProgress} color={H.blue} />
        <MetricCard label="On Hold" value={onHold} color={H.yellow} />
        <MetricCard label="Done Today" value={completedToday} color={H.green} />
        <MetricCard label="Overdue" value={overdueCount} color={H.red} />
      </div>

      {/* Pre-Owned Funnel + Tech Utilization */}
      <div className="dash-charts" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }}>
        <Card>
          <div style={{ fontSize: 13, fontWeight: 700, color: H.navy, marginBottom: 4 }}>Pre-Owned Funnel</div>
          <div style={{ fontSize: 11, color: H.g400, marginBottom: 12 }}>Vehicles currently at each stage</div>
          {[
            { label: "Reconditioning", count: funnel["Reconditioning"], color: H.blue, icon: "🔧" },
            { label: "Safety", count: funnel["Safety"], color: H.lightBlue, icon: "🛡️" },
            { label: "Delivery Prep", count: funnel["Delivery Preparation"], color: H.accent, icon: "🚗" },
          ].map(s => (
            <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: H.g600, width: 110, display: "flex", alignItems: "center", gap: 4 }}>{s.icon} {s.label}</span>
              <div style={{ flex: 1, height: 22, background: H.g100, borderRadius: 11, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${(s.count / funnelMax) * 100}%`, background: s.color, borderRadius: 11, minWidth: s.count > 0 ? 22 : 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {s.count > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: H.white }}>{s.count}</span>}
                </div>
              </div>
            </div>
          ))}
          {funnel["Reconditioning"] + funnel["Safety"] + funnel["Delivery Preparation"] === 0 && (
            <div style={{ fontSize: 11, color: H.g400, textAlign: "center", padding: "8px 0" }}>No active Pre-Owned vehicles</div>
          )}
        </Card>
        <Card>
          <div style={{ fontSize: 13, fontWeight: 700, color: H.navy, marginBottom: 4 }}>Technician Utilization</div>
          <div style={{ fontSize: 11, color: H.g400, marginBottom: 12 }}>
            {techUtil.onDuty} on duty · {techUtil.offDuty} off duty
          </div>
          {techUtil.top.length === 0 ? (
            <div style={{ fontSize: 11, color: H.g400, textAlign: "center", padding: "8px 0" }}>No technicians on duty</div>
          ) : techUtil.top.map(([name, v]) => {
            const load = v.count;
            const tone = load === 0 ? H.green : load <= 2 ? H.blue : load <= 4 ? H.yellow : H.red;
            return (
              <div key={name} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: tone, flexShrink: 0 }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: H.g800, flex: 1 }}>{name}</span>
                <span style={{ fontSize: 11, color: H.g600, fontWeight: 600 }}>{load} job{load === 1 ? "" : "s"}</span>
              </div>
            );
          })}
        </Card>
      </div>

      {/* Filter bar */}
      <Card style={{ marginBottom: 14, padding: "12px 16px" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: H.navy }}>Filter:</span>
          <select value={dashFilter.type} onChange={e => setDashFilter(f => ({ ...f, type: e.target.value }))} style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${H.g200}`, fontSize: 12 }}>
            <option value="All">All Types</option>{REQUEST_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={dashFilter.status} onChange={e => setDashFilter(f => ({ ...f, status: e.target.value }))} style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${H.g200}`, fontSize: 12 }}>
            <option value="All">All Statuses</option>{STATUSES.filter(s => s !== "Completed").map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={dashFilter.priority} onChange={e => setDashFilter(f => ({ ...f, priority: e.target.value }))} style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${H.g200}`, fontSize: 12 }}>
            <option value="All">All Priorities</option>{PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          {techList.length > 0 && <select value={dashFilter.technician} onChange={e => setDashFilter(f => ({ ...f, technician: e.target.value }))} style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${H.g200}`, fontSize: 12 }}>
            <option value="All">All Technicians</option>{techList.map(t => <option key={t} value={t}>{t}</option>)}
          </select>}
          <SearchBar value={search} onChange={setSearch} placeholder="Search VIN, Stock #, Tech, W.O.#..." />
        </div>
      </Card>

      {/* Active Requests table */}
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${H.g100}`, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: H.navy }}>Active Requests</span>
          <span style={{ fontSize: 12, color: H.g400 }}>({sorted.length})</span>
          <span style={{ fontSize: 11, color: H.g400, marginLeft: "auto" }}>Click a row to view & edit details</span>
          <button onClick={exportCsv} disabled={sorted.length === 0} title="Download visible rows as CSV"
            style={{
              padding: "5px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600,
              cursor: sorted.length === 0 ? "not-allowed" : "pointer",
              background: H.white, color: H.navy, border: `1px solid ${H.g200}`,
              display: "inline-flex", alignItems: "center", gap: 4,
              opacity: sorted.length === 0 ? 0.5 : 1,
            }}>↓ Export CSV</button>
        </div>
        {sorted.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: H.g400, fontSize: 13 }}>{search ? `No results for "${search}"` : "No active requests"}</div>
        ) : (
          <div className="dashboard-table-wrap" style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: H.offWhite }}>
                  {["Stock #", "Type", "VIN", "Category / Stage", "Status", "Priority", "Technician", "W.O.#", "ETA", "Remaining"].map(h => (
                    <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontWeight: 700, color: H.g600, fontSize: 11, textTransform: "uppercase", borderBottom: `1px solid ${H.g100}`, whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map(e => {
                  const od = e.anyOverdue;
                  const aging = isAging(e);
                  return (
                    <tr key={e.key}
                      onClick={() => onOpenDrawer && onOpenDrawer(e.jumpKey)}
                      style={{ background: od ? "#FFF5F5" : "transparent", borderBottom: `1px solid ${H.g100}`, cursor: "pointer" }}
                      onMouseEnter={ev => ev.currentTarget.style.background = od ? "#FFEBEB" : H.offWhite}
                      onMouseLeave={ev => ev.currentTarget.style.background = od ? "#FFF5F5" : "transparent"}
                    >
                      <td style={{ padding: "10px 12px", fontWeight: 600, color: H.navy, whiteSpace: "nowrap" }}>{e.stock}</td>
                      <td style={{ padding: "10px 12px" }}>
                        <Badge bg={e.type === "Pre-Owned" ? H.blueBg : H.g100} color={e.type === "Pre-Owned" ? H.steel : H.g600}>
                          {e.type}
                        </Badge>
                      </td>
                      <td style={{ padding: "10px 12px", fontFamily: "monospace", fontSize: 11, color: H.g600 }}>{e.vin}</td>
                      <td style={{ padding: "10px 12px" }}>
                        {e.kind === "group" ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <StageStrip items={e.stageItems} />
                            <span style={{ fontSize: 11, color: H.g600, fontWeight: 600 }}>{e.completed}/{e.stageItems.length}</span>
                            <Badge bg={H.g100} color={H.g600} style={{ fontSize: 10 }}>{e.activeStage}</Badge>
                          </div>
                        ) : (
                          <Badge bg={H.g100} color={H.g600}>{e.category}</Badge>
                        )}
                      </td>
                      <td style={{ padding: "10px 12px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <StatusBadge status={e.status} eta={e.eta} />
                          {aging && <Badge bg={H.yellowBg} color="#E68A00" style={{ fontSize: 10 }}>⏱ {fmtAge(aging)}</Badge>}
                        </div>
                      </td>
                      <td style={{ padding: "10px 12px" }}><PriorityBadge priority={e.priority} /></td>
                      <td style={{ padding: "10px 12px", color: H.g600 }}>{e.technician || "—"}</td>
                      <td style={{ padding: "10px 12px", fontFamily: "monospace", fontSize: 11, color: H.g600 }}>{e.workOrder || "—"}</td>
                      <td style={{ padding: "10px 12px", color: od ? H.red : H.g600, fontWeight: od ? 700 : 400, whiteSpace: "nowrap" }}>{fmtDate(e.eta)}</td>
                      <td style={{ padding: "10px 12px", fontWeight: 600, color: od ? H.red : H.blue, whiteSpace: "nowrap" }}>{e.eta ? timeRemaining(e.eta) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ════════════════════════════════════════
// MAIN APP
// ════════════════════════════════════════
// ─── Tab routing via URL hash (so browser back/forward works) ───
const TABS = ["dashboard", "entry", "tracker", "techs"];
const getTabFromHash = () => {
  if (typeof window === "undefined") return "dashboard";
  const h = window.location.hash.replace(/^#/, "");
  return TABS.includes(h) ? h : "dashboard";
};

function AppInner() {
  const [tab, setTabRaw] = useState(getTabFromHash);
  const [requests, setRequests] = useState([]);
  const [workflow, setWorkflow] = useState({});
  const [technicians, setTechnicians] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusyState] = useState(() => new Set());
  const [drawerKey, setDrawerKey] = useState(null); // open detail drawer for this entry key
  const [realtimeStatus, setRealtimeStatus] = useState("connecting"); // 'connecting' | 'live' | 'down'
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const setTab = useCallback((newTab) => {
    setTabRaw(newTab);
    if (typeof window !== "undefined" && window.location.hash !== `#${newTab}`) {
      window.history.pushState({}, "", `#${newTab}`);
    }
  }, []);

  // Sync tab state when user uses browser back/forward.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPop = () => setTabRaw(getTabFromHash());
    // Ensure URL hash matches initial tab
    if (window.location.hash === "" || !TABS.includes(window.location.hash.replace(/^#/, ""))) {
      window.history.replaceState({}, "", `#${tab}`);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openDrawer = useCallback((entryKey) => setDrawerKey(entryKey), []);
  const closeDrawer = useCallback(() => setDrawerKey(null), []);

  // Esc to close the drawer.
  useEffect(() => {
    if (!drawerKey) return;
    const onKey = (e) => { if (e.key === "Escape") setDrawerKey(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerKey]);

  const setBusy = useCallback((key, on) => {
    setBusyState((s) => {
      const next = new Set(s);
      if (on) next.add(key); else next.delete(key);
      return next;
    });
  }, []);
  const loadingApi = useMemo(() => ({ busy, setBusy }), [busy, setBusy]);

  const fetchAll = useCallback(async () => {
    const [reqRes, wfRes, techRes] = await Promise.all([
      supabase.from("requests").select("*"),
      supabase.from("workflow").select("*"),
      supabase.from("technicians").select("*").order("name"),
    ]);
    if (reqRes.error) throw reqRes.error;
    if (wfRes.error) throw wfRes.error;
    if (techRes.error) throw techRes.error;
    const reqs = (reqRes.data || []).map(reqFromRow);
    const wfMap = {};
    (wfRes.data || []).forEach((row) => { wfMap[row.request_id] = wfFromRow(row); });
    setRequests(reqs);
    setWorkflow(wfMap);
    setTechnicians((techRes.data || []).map((t) => ({ name: t.name, available: t.available })));
  }, []);

  useEffect(() => {
    (async () => {
      try { await fetchAll(); }
      catch (e) { toast.error(`Couldn't load data: ${e.message || e}`); }
      finally { setLoading(false); }
    })();
  }, [fetchAll, toast]);

  // Realtime: keep local state in sync with DB changes from any client.
  // Idempotent merges — re-applying our own optimistic-update echo is a no-op.
  useEffect(() => {
    const channel = supabase
      .channel("service-tracker-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "requests" }, (payload) => {
        if (payload.eventType === "INSERT") {
          const r = reqFromRow(payload.new);
          setRequests((prev) => prev.find((x) => x.id === r.id) ? prev.map((x) => x.id === r.id ? r : x) : [...prev, r]);
        } else if (payload.eventType === "UPDATE") {
          const r = reqFromRow(payload.new);
          setRequests((prev) => prev.map((x) => x.id === r.id ? r : x));
        } else if (payload.eventType === "DELETE") {
          const oldId = payload.old.id;
          setRequests((prev) => prev.filter((x) => x.id !== oldId));
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "workflow" }, (payload) => {
        if (payload.eventType === "INSERT" || payload.eventType === "UPDATE") {
          const w = wfFromRow(payload.new);
          const reqId = payload.new.request_id;
          setWorkflow((prev) => ({ ...prev, [reqId]: w }));
        } else if (payload.eventType === "DELETE") {
          // REPLICA IDENTITY FULL gives us request_id in payload.old
          const reqId = payload.old.request_id;
          if (reqId) {
            setWorkflow((prev) => { const next = { ...prev }; delete next[reqId]; return next; });
          }
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "technicians" }, (payload) => {
        if (payload.eventType === "INSERT") {
          const t = { name: payload.new.name, available: payload.new.available };
          setTechnicians((prev) => prev.find((x) => x.name === t.name) ? prev.map((x) => x.name === t.name ? t : x) : [...prev, t]);
        } else if (payload.eventType === "UPDATE") {
          const t = { name: payload.new.name, available: payload.new.available };
          setTechnicians((prev) => prev.map((x) => x.name === t.name ? t : x));
        } else if (payload.eventType === "DELETE") {
          // REPLICA IDENTITY FULL gives us name in payload.old
          const oldName = payload.old.name;
          if (oldName) {
            setTechnicians((prev) => prev.filter((x) => x.name !== oldName));
          }
        }
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setRealtimeStatus("live");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") setRealtimeStatus("down");
        else setRealtimeStatus("connecting");
      });
    return () => { supabase.removeChannel(channel); };
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    try { await fetchAll(); toast.success("Data refreshed"); }
    catch (e) { toast.error(`Refresh failed: ${e.message || e}`); }
    finally { setRefreshing(false); }
  };

  // (Reset button intentionally removed — wipe-all-data should not be a UI
  // action available to anonymous visitors. Run a `truncate` from the Supabase
  // SQL editor when an admin reset is needed.)

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: H.offWhite }}>
      <div style={{ textAlign: "center" }}><div style={{ fontSize: 32, marginBottom: 12 }}>🚗</div><div style={{ fontWeight: 700, color: H.navy }}>Loading Service Tracker...</div></div>
    </div>
  );

  return (
    <ConfirmCtx.Provider value={{ confirm }}>
      <LoadingCtx.Provider value={loadingApi}>
        <div style={{ minHeight: "100vh", background: H.offWhite, fontFamily: "'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif" }}>
          <div className="app-header" style={{
            background: `linear-gradient(135deg, ${H.navy} 0%, ${H.steel} 100%)`,
            padding: "14px 24px", display: "flex", alignItems: "center", justifyContent: "space-between",
            boxShadow: "0 2px 8px rgba(0,44,95,.15)", position: "sticky", top: 0, zIndex: 100, flexWrap: "wrap", gap: 10,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: "rgba(255,255,255,.12)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🔧</div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 800, color: H.white, letterSpacing: 0.5 }}>Service Request System</div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,.55)", fontWeight: 500 }}>Dealership Operations</div>
              </div>
            </div>
            <div className="nav-tabs" style={{ display: "flex", gap: 4, background: "rgba(255,255,255,.08)", borderRadius: 10, padding: 4, flexWrap: "wrap" }}>
              <Tab active={tab === "dashboard"} label="Dashboard" icon="📊" onClick={() => setTab("dashboard")} />
              <Tab active={tab === "entry"} label="Requests" icon="📝" onClick={() => setTab("entry")} />
              <Tab active={tab === "tracker"} label="Workflow" icon="⚙️" onClick={() => setTab("tracker")} />
              <Tab active={tab === "techs"} label="Technicians" icon="👨‍🔧" onClick={() => setTab("techs")} />
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span title={realtimeStatus === "live" ? "Connected — changes from other users appear instantly" : realtimeStatus === "connecting" ? "Connecting to Supabase Realtime…" : "Realtime disconnected — manual refresh needed"}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  padding: "4px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
                  background: "rgba(255,255,255,.08)",
                  color: realtimeStatus === "live" ? "#7FE3A8" : realtimeStatus === "down" ? "#FFB3B3" : "rgba(255,255,255,.55)",
                }}>
                <span style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: realtimeStatus === "live" ? "#3DCC78" : realtimeStatus === "down" ? H.red : H.yellow,
                  boxShadow: realtimeStatus === "live" ? "0 0 6px #3DCC78" : "none",
                }} />
                {realtimeStatus === "live" ? "LIVE" : realtimeStatus === "down" ? "OFFLINE" : "…"}
              </span>
              <button onClick={refresh} disabled={refreshing} title="Refresh data from Supabase" style={{
                background: "rgba(255,255,255,.1)", border: "none", color: H.white,
                padding: "6px 12px", borderRadius: 6, fontSize: 11, cursor: refreshing ? "wait" : "pointer", fontWeight: 600,
                display: "inline-flex", alignItems: "center", gap: 6, opacity: refreshing ? 0.7 : 1,
              }}>{refreshing ? <Spinner /> : "↻"} Refresh</button>
            </div>
          </div>
          <div className="app-main" style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
            {tab === "dashboard" && <Dashboard requests={requests} workflow={workflow} technicians={technicians} onOpenDrawer={openDrawer} />}
            {tab === "entry" && <RequestEntryForm requests={requests} setRequests={setRequests} workflow={workflow} setWorkflow={setWorkflow} />}
            {tab === "tracker" && <WorkflowTracker requests={requests} setRequests={setRequests} workflow={workflow} setWorkflow={setWorkflow} technicians={technicians} />}
            {tab === "techs" && <TechManager technicians={technicians} setTechnicians={setTechnicians} workflow={workflow} requests={requests} />}
          </div>
          {/* Detail drawer (slide-in from right) — replaces the old "click row → switch tab" behavior */}
          {drawerKey && (
            <div onClick={closeDrawer} className="drawer-backdrop"
              style={{
                position: "fixed", inset: 0, background: "rgba(0,44,95,.4)", zIndex: 200,
                display: "flex", justifyContent: "flex-end",
              }}>
              <div onClick={(e) => e.stopPropagation()} className="drawer-panel"
                style={{
                  background: H.offWhite, width: "min(720px, 95vw)", height: "100%",
                  overflowY: "auto", boxShadow: "-12px 0 32px rgba(0,44,95,.18)",
                }}>
                <div style={{
                  position: "sticky", top: 0,
                  background: `linear-gradient(135deg, ${H.navy} 0%, ${H.steel} 100%)`, color: H.white,
                  padding: "12px 16px", display: "flex", alignItems: "center",
                  justifyContent: "space-between", zIndex: 1,
                }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>Vehicle Detail</span>
                  <button onClick={closeDrawer} title="Close (Esc)"
                    style={{
                      background: "rgba(255,255,255,.12)", border: "none", color: H.white,
                      padding: "6px 12px", borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: "pointer",
                    }}>✕ Close</button>
                </div>
                <div style={{ padding: 16 }}>
                  <WorkflowTracker
                    requests={requests} setRequests={setRequests}
                    workflow={workflow} setWorkflow={setWorkflow}
                    technicians={technicians}
                    singleEntryKey={drawerKey}
                    onEntryGone={closeDrawer}
                  />
                </div>
              </div>
            </div>
          )}
          {confirmDialog}
        </div>
      </LoadingCtx.Provider>
    </ConfirmCtx.Provider>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}
