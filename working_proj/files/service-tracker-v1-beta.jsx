import React, { useState, useEffect, useMemo } from "react";

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
const SK = { requests: "hyundai-srv-req-v3", workflow: "hyundai-srv-wf-v3", technicians: "hyundai-srv-techs-v3", woCounter: "hyundai-srv-wo-v3" };

// ─── VIN Validation ───
// Real VIN rules: 17 chars, no I/O/Q, position 9 is check digit
const VIN_CHARS = "0123456789ABCDEFGHJKLMNPRSTUVWXYZ";
const VIN_VALUES = {};
"0123456789".split("").forEach((c, i) => VIN_VALUES[c] = i);
"ABCDEFGH".split("").forEach((c, i) => VIN_VALUES[c] = i + 1);
VIN_VALUES["J"] = 1; VIN_VALUES["K"] = 2; VIN_VALUES["L"] = 3; VIN_VALUES["M"] = 4;
VIN_VALUES["N"] = 5; VIN_VALUES["P"] = 7; VIN_VALUES["R"] = 9;
"STUVWXYZ".split("").forEach((c, i) => VIN_VALUES[c] = i + 2);
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

function validateVIN(vin) {
  const v = vin.replace(/\s/g, "").toUpperCase();
  if (v.length !== 17) return { valid: false, error: "VIN must be exactly 17 characters" };
  if (/[IOQ]/.test(v)) return { valid: false, error: "VIN cannot contain I, O, or Q" };
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return { valid: false, error: "VIN contains invalid characters" };
  
  // Check digit validation (position 9)
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    if (i === 8) continue; // skip check digit position
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

// Auto Work Order: WO-YYYYMMDD-NNN
async function generateWorkOrder() {
  let counter = 1;
  try {
    const r = await load(SK.woCounter);
    if (r) {
      const today = new Date().toISOString().slice(0, 10);
      if (r.date === today) counter = r.count + 1;
    }
  } catch {}
  const today = new Date().toISOString().slice(0, 10);
  await save(SK.woCounter, { date: today, count: counter });
  return `WO-${today.replace(/-/g, "")}-${String(counter).padStart(3, "0")}`;
}

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

// ─── Storage ───
async function load(key) { try { const r = await window.storage.get(key); return r ? JSON.parse(r.value) : null; } catch { return null; } }
async function save(key, val) { try { await window.storage.set(key, JSON.stringify(val), true); } catch (e) { console.error("Save:", e); } }

// ─── Shared Components ───
const Badge = ({ children, bg, color, style }) => (
  <span style={{ display: "inline-flex", alignItems: "center", padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, letterSpacing: 0.3, background: bg, color, whiteSpace: "nowrap", ...style }}>{children}</span>
);
const StatusBadge = ({ status, eta }) => { const c = stColor(status, eta); const od = isOverdue(eta, status); return <Badge bg={c.bg} color={c.text}><span style={{ width: 6, height: 6, borderRadius: "50%", background: c.dot, marginRight: 6, display: "inline-block" }} />{od ? "OVERDUE" : status}</Badge>; };
const PriorityBadge = ({ priority }) => { const c = prColor(priority); return <Badge bg={c.bg} color={c.text}>{priority}</Badge>; };

const Card = ({ children, style }) => (
  <div style={{ background: H.white, borderRadius: 12, padding: 20, boxShadow: "0 1px 4px rgba(0,44,95,.07)", border: `1px solid ${H.g100}`, ...style }}>{children}</div>
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

// ─── Technician Select with workload ───
const TechSelect = ({ label, value, onChange, technicians, workflow, requests }) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = React.useRef(null);
  const inputRef = React.useRef(null);
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setQ(""); } };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);
  useEffect(() => { if (open && inputRef.current) inputRef.current.focus(); }, [open]);
  const allTechs = technicians || [];
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
              <div style={{ padding: "4px 12px", fontSize: 10, fontWeight: 700, color: H.g400, textTransform: "uppercase", borderTop: `1px solid ${H.g100}`, background: H.offWhite }}>Off Duty</div>
              {off.map(t => (
                <div key={t.name} style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, fontSize: 12, opacity: 0.5 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: H.g400 }} /><span style={{ color: H.g400 }}>{t.name}</span>
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

  const addTech = async () => {
    const name = newName.trim();
    if (!name || technicians.find(t => t.name.toLowerCase() === name.toLowerCase())) return;
    const updated = [...technicians, { name, available: true }];
    setTechnicians(updated);
    await save(SK.technicians, updated);
    setNewName("");
  };

  const toggleAvail = async (name) => {
    const updated = technicians.map(t => t.name === name ? { ...t, available: !t.available } : t);
    setTechnicians(updated);
    await save(SK.technicians, updated);
  };

  const removeTech = async (name) => {
    if (!confirm(`Remove ${name} from the technician list?`)) return;
    const updated = technicians.filter(t => t.name !== name);
    setTechnicians(updated);
    await save(SK.technicians, updated);
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

      {/* Add Technician */}
      <Card style={{ marginBottom: 16, padding: "14px 18px" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: H.g600, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4 }}>Add Technician</label>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Technician name..."
              onKeyDown={e => e.key === "Enter" && addTech()}
              style={{ width: "100%", padding: "9px 12px", border: `1.5px solid ${H.g200}`, borderRadius: 8, fontSize: 14, color: H.g800, background: H.white, outline: "none", boxSizing: "border-box" }} />
          </div>
          <button onClick={addTech} style={{
            padding: "10px 20px", background: H.navy, color: H.white, border: "none", borderRadius: 8,
            fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap",
          }}>+ Add</button>
        </div>
      </Card>

      {/* Technician List */}
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
            return (
              <Card key={t.name} style={{ padding: "14px 18px", borderLeft: `4px solid ${t.available ? (totalActive > 3 ? H.yellow : H.green) : H.g400}` }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 36, height: 36, borderRadius: "50%", background: t.available ? H.blueBg : H.g100, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 700, color: t.available ? H.navy : H.g400 }}>
                      {t.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: t.available ? H.navy : H.g400 }}>{t.name}</div>
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
                    <button onClick={() => toggleAvail(t.name)} style={{
                      padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer",
                      background: t.available ? H.greenBg : H.g100, color: t.available ? H.green : H.g600,
                      border: `1px solid ${t.available ? H.green : H.g200}`,
                    }}>{t.available ? "On Duty" : "Off Duty"}</button>
                    <button onClick={() => removeTech(t.name)} style={{
                      padding: "5px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer",
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
  const [success, setSuccess] = useState("");
  const [vinWarning, setVinWarning] = useState("");

  // Live VIN feedback
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
    if (!form.vin.trim()) { e.vin = "Required"; }
    else {
      const vinResult = validateVIN(form.vin);
      if (!vinResult.valid) e.vin = vinResult.error;
    }
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

    let newRequests = [...requests];
    let newWorkflow = { ...workflow };

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
        newWorkflow[id] = { workOrder: "", status: i === 0 ? "In Queue" : "Pending", technician: "", startTime: null, completionTime: null, serviceNotes: "" };
      }
      setSuccess("Pre-Owned workflow created — Reconditioning → Safety → Delivery Prep");
    } else {
      const id = genId();
      newRequests.push({
        id, type: form.type, stock: form.stock.trim(), vin: cleanVin,
        category: form.category, priority: form.priority,
        notes: form.notes, created: now(), eta: form.eta || null,
        workflowGroup: null, workflowStep: null,
      });
      newWorkflow[id] = { workOrder: "", status: "In Queue", technician: "", startTime: null, completionTime: null, serviceNotes: "" };
      setSuccess("Request submitted successfully");
    }

    setRequests(newRequests); setWorkflow(newWorkflow);
    await save(SK.requests, newRequests); await save(SK.workflow, newWorkflow);
    setForm({ type: "", stock: "", vin: "", category: "", priority: "", notes: "", eta: "" });
    setErrors({}); setVinWarning("");
    setTimeout(() => setSuccess(""), 4000);
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
      {success && <div style={{ padding: "12px 16px", background: H.greenBg, border: `1px solid ${H.green}`, borderRadius: 8, marginBottom: 16, color: H.green, fontWeight: 600, fontSize: 13 }}>✓ {success}</div>}
      <Card>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
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
        <button onClick={submit} style={{ width: "100%", padding: "12px", background: H.navy, color: H.white, border: "none", borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: "pointer" }}
          onMouseEnter={e => e.target.style.background = H.steel} onMouseLeave={e => e.target.style.background = H.navy}>
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
function WorkflowTracker({ requests, setRequests, workflow, setWorkflow, technicians }) {
  const [filter, setFilter] = useState("Active");
  const [search, setSearch] = useState("");

  // Update request-level fields (priority, eta, category, notes)
  const updateRequest = async (id, field, value) => {
    const updated = requests.map(r => r.id === id ? { ...r, [field]: value } : r);
    setRequests(updated);
    await save(SK.requests, updated);
  };

  const canChangeStatus = (req, newStatus) => {
    if (!req.workflowGroup) return true;
    if (newStatus === "Pending") return false;
    const group = requests.filter(r => r.workflowGroup === req.workflowGroup).sort((a, b) => a.workflowStep - b.workflowStep);
    const myIdx = group.findIndex(r => r.id === req.id);
    if (myIdx === 0) return true;
    return workflow[group[myIdx - 1].id]?.status === "Completed";
  };

  const updateStatus = async (id, newStatus) => {
    const updated = { ...workflow };
    const entry = { ...updated[id] };
    if (newStatus === "In Progress" && !entry.startTime) {
      entry.startTime = now();
      // Auto-generate Work Order if empty
      if (!entry.workOrder) entry.workOrder = await generateWorkOrder();
    }
    if (newStatus === "Completed") {
      entry.completionTime = now();
      if (!entry.startTime) entry.startTime = entry.completionTime;
      const req = requests.find(r => r.id === id);
      if (req?.workflowGroup) {
        const group = requests.filter(r => r.workflowGroup === req.workflowGroup).sort((a, b) => a.workflowStep - b.workflowStep);
        const myIdx = group.findIndex(r => r.id === id);
        if (myIdx < group.length - 1) {
          const next = group[myIdx + 1];
          if (updated[next.id]?.status === "Pending") updated[next.id] = { ...updated[next.id], status: "In Queue" };
        }
      }
    }
    entry.status = newStatus;
    updated[id] = entry;
    setWorkflow(updated);
    await save(SK.workflow, updated);
  };

  const updateField = async (id, field, value) => {
    const updated = { ...workflow, [id]: { ...workflow[id], [field]: value } };
    setWorkflow(updated);
    await save(SK.workflow, updated);
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

  const StepRow = ({ r, isLast }) => {
    const w = workflow[r.id]; if (!w) return null;
    const isPending = w.status === "Pending";
    const sc = stColor(w.status, r.eta);
    return (
      <div style={{ padding: "10px 14px", background: isPending ? H.g100 : "transparent", borderBottom: isLast ? "none" : `1px solid ${H.g100}`, opacity: isPending ? 0.5 : 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: isPending ? 0 : 8, flexWrap: "wrap" }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: sc.dot, flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: isPending ? H.g400 : H.navy }}>{r.category}</span>
          <StatusBadge status={w.status} eta={r.eta} />
          {w.workOrder && <Badge bg={H.g100} color={H.g600} style={{ fontFamily: "monospace", fontSize: 10 }}>{w.workOrder}</Badge>}
          {w.startTime && w.completionTime && <span style={{ fontSize: 11, color: H.g400 }}>Time: <strong style={{ color: H.navy }}>{timeDiff(w.startTime, w.completionTime)}</strong></span>}
          {isPending && <span style={{ fontSize: 11, color: H.g400, fontStyle: "italic" }}>Waiting for previous stage</span>}
        </div>
        {!isPending && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginLeft: 16 }}>
            <InlineSelect label="Status" value={w.status} options={STATUSES}
              onChange={ns => { if (canChangeStatus(r, ns)) updateStatus(r.id, ns); else alert("Complete the previous stage first."); }} />
            <InlineField label="Work Order #" value={w.workOrder} onChange={v => updateField(r.id, "workOrder", v)} placeholder="Auto on start" small readOnly={!!w.workOrder} />
            <TechSelect label="Technician" value={w.technician} onChange={v => updateField(r.id, "technician", v)} technicians={technicians} workflow={workflow} requests={requests} />
            {(w.startTime || w.completionTime) && (
              <div style={{ alignSelf: "flex-end", fontSize: 11, color: H.g400, paddingBottom: 6 }}>
                {w.startTime && <>Started: {fmt(w.startTime)}</>}
                {w.completionTime && <> · Done: {fmt(w.completionTime)}</>}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
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

      {sorted.length === 0 ? (
        <Card style={{ textAlign: "center", padding: 40, color: H.g400 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
          <div style={{ fontWeight: 600 }}>No vehicles match{search ? ` "${search}"` : " the filter"}</div>
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {sorted.map(entry => {
            if (entry.kind === "single") {
              const r = entry.item, w = workflow[r.id]; if (!w) return null;
              const od = isOverdue(r.eta, w.status);
              return (
                <Card key={entry.key} style={{ padding: 0, borderLeft: `4px solid ${od ? H.red : stColor(w.status, r.eta).dot}`, position: "relative" }}>
                  <div style={{ padding: "14px 18px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 15, fontWeight: 700, color: H.navy }}>{r.stock}</span>
                      <Badge bg={H.g100} color={H.g600}>{r.category}</Badge>
                      <PriorityBadge priority={r.priority} />
                      <StatusBadge status={w.status} eta={r.eta} />
                      {w.workOrder && <Badge bg={H.g100} color={H.g600} style={{ fontFamily: "monospace", fontSize: 10 }}>{w.workOrder}</Badge>}
                    </div>
                    <div style={{ fontSize: 12, color: H.g400, marginBottom: 10 }}>
                      VIN: <span style={{ fontFamily: "monospace", color: H.g600 }}>{r.vin}</span>
                      {r.eta && <> · Due: <span style={{ color: od ? H.red : H.g600, fontWeight: od ? 700 : 400 }}>{fmtDate(r.eta)}</span></>}
                      {r.eta && w.status !== "Completed" && <> · <span style={{ color: od ? H.red : H.blue, fontWeight: 600 }}>{timeRemaining(r.eta)}</span></>}
                    </div>
                    {r.notes && <div style={{ fontSize: 12, color: H.g600, marginBottom: 10 }}>{r.notes}</div>}
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
                      <TechSelect label="Technician" value={w.technician} onChange={v => updateField(r.id, "technician", v)} technicians={technicians} workflow={workflow} requests={requests} />
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
            // Grouped Pre-Owned
            const first = entry.items[0]; const od = entry.anyOverdue;
            const allDone = entry.items.every(x => workflow[x.id]?.status === "Completed");
            return (
              <Card key={entry.key} style={{ padding: 0, borderLeft: `4px solid ${allDone ? H.green : od ? H.red : H.blue}`, position: "relative" }}>
                <div style={{ padding: "14px 18px 10px", borderBottom: `1px solid ${H.g100}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: H.navy }}>{first.stock}</span>
                    <Badge bg={H.blueBg} color={H.steel}>Pre-Owned Workflow</Badge>
                    <PriorityBadge priority={first.priority} />
                    {allDone && <Badge bg={H.greenBg} color={H.green}>All Complete</Badge>}
                    {od && !allDone && <Badge bg={H.redBg} color={H.red}>OVERDUE</Badge>}
                  </div>
                  <div style={{ fontSize: 12, color: H.g400 }}>
                    VIN: <span style={{ fontFamily: "monospace", color: H.g600 }}>{first.vin}</span>
                    {first.eta && <> · Due: <span style={{ color: od ? H.red : H.g600, fontWeight: od ? 700 : 400 }}>{fmtDate(first.eta)}</span></>}
                    {first.eta && !allDone && <> · <span style={{ color: od ? H.red : H.blue, fontWeight: 600 }}>{timeRemaining(first.eta)}</span></>}
                  </div>
                  {/* Editable group-level fields */}
                  <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                    <InlineSelect label="Priority" value={first.priority} options={PRIORITIES} onChange={v => { entry.items.forEach(r => updateRequest(r.id, "priority", v)); }} />
                    <div>
                      <label style={{ fontSize: 10, fontWeight: 600, color: H.g400, textTransform: "uppercase", display: "block", marginBottom: 2 }}>Due Date</label>
                      <input type="date" value={first.eta || ""} onChange={e => { const val = e.target.value || null; entry.items.forEach(r => updateRequest(r.id, "eta", val)); }}
                        style={{ padding: "5px 8px", borderRadius: 6, border: `1px solid ${H.g200}`, fontSize: 12, background: H.white }} />
                    </div>
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
                {entry.items.map((r, i) => <StepRow key={r.id} r={r} isLast={i === entry.items.length - 1} />)}
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
function Dashboard({ requests, workflow }) {
  const [search, setSearch] = useState("");
  const [dashFilter, setDashFilter] = useState({ status: "All", priority: "All", technician: "All" });
  const active = requests.filter(r => { const w = workflow[r.id]; return w && w.status !== "Pending"; });
  const total = active.length;
  const inQueue = active.filter(r => workflow[r.id]?.status === "In Queue").length;
  const inProgress = active.filter(r => workflow[r.id]?.status === "In Progress").length;
  const onHold = active.filter(r => workflow[r.id]?.status === "On Hold").length;
  const today = new Date().toDateString();
  const completedToday = active.filter(r => { const w = workflow[r.id]; return w?.status === "Completed" && w.completionTime && new Date(w.completionTime).toDateString() === today; }).length;
  const overdueCount = active.filter(r => isOverdue(r.eta, workflow[r.id]?.status)).length;
  const high = active.filter(r => r.priority === "High" && workflow[r.id]?.status !== "Completed").length;
  const med = active.filter(r => r.priority === "Medium" && workflow[r.id]?.status !== "Completed").length;
  const low = active.filter(r => r.priority === "Low" && workflow[r.id]?.status !== "Completed").length;
  const reconP = active.filter(r => r.category === "Reconditioning" && workflow[r.id]?.status !== "Completed").length;
  const safetyP = active.filter(r => r.category === "Safety" && workflow[r.id]?.status !== "Completed").length;
  const delivP = active.filter(r => r.category === "Delivery Preparation" && workflow[r.id]?.status !== "Completed").length;
  const technicians = [...new Set(active.map(r => workflow[r.id]?.technician).filter(Boolean))];
  const sorted = sortItems(active.filter(r => workflow[r.id]?.status !== "Completed"), workflow);
  const filteredSorted = sorted.filter(r => {
    const w = workflow[r.id];
    if (dashFilter.status !== "All" && w?.status !== dashFilter.status) return false;
    if (dashFilter.priority !== "All" && r.priority !== dashFilter.priority) return false;
    if (dashFilter.technician !== "All" && w?.technician !== dashFilter.technician) return false;
    if (search.trim()) { const q = search.toLowerCase(); if (!r.stock.toLowerCase().includes(q) && !r.vin.toLowerCase().includes(q) && !(w?.technician || "").toLowerCase().includes(q) && !(w?.workOrder || "").toLowerCase().includes(q)) return false; }
    return true;
  });

  return (
    <div>
      <div style={{ marginBottom: 20 }}><h2 style={{ fontSize: 20, fontWeight: 700, color: H.navy, margin: 0 }}>Live Dashboard</h2><p style={{ fontSize: 13, color: H.g400, margin: "4px 0 0" }}>Real-time overview of all service operations</p></div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
        <MetricCard label="Total Requests" value={total} color={H.navy} /><MetricCard label="In Queue" value={inQueue} color={H.g400} /><MetricCard label="In Progress" value={inProgress} color={H.blue} /><MetricCard label="On Hold" value={onHold} color={H.yellow} /><MetricCard label="Done Today" value={completedToday} color={H.green} /><MetricCard label="Overdue" value={overdueCount} color={H.red} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }}>
        <Card>
          <div style={{ fontSize: 13, fontWeight: 700, color: H.navy, marginBottom: 12 }}>Priority Breakdown</div>
          {[{ label: "High", count: high, color: H.red }, { label: "Medium", count: med, color: "#E68A00" }, { label: "Low", count: low, color: H.green }].map(p => (
            <div key={p.label} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: p.color, width: 55 }}>{p.label}</span>
              <div style={{ flex: 1, height: 22, background: H.g100, borderRadius: 11, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.max(high, med, low, 1) > 0 ? (p.count / Math.max(high, med, low, 1)) * 100 : 0}%`, background: p.color, borderRadius: 11, minWidth: p.count > 0 ? 22 : 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {p.count > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: H.white }}>{p.count}</span>}
                </div>
              </div>
            </div>
          ))}
        </Card>
        <Card>
          <div style={{ fontSize: 13, fontWeight: 700, color: H.navy, marginBottom: 12 }}>Workflow Stages Pending</div>
          {[{ label: "Reconditioning", count: reconP, icon: "🔧" }, { label: "Safety", count: safetyP, icon: "🛡️" }, { label: "Delivery Prep", count: delivP, icon: "🚗" }].map(s => (
            <div key={s.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: H.g600, display: "flex", alignItems: "center", gap: 6 }}>{s.icon} {s.label}</span>
              <span style={{ fontSize: 18, fontWeight: 800, color: H.navy }}>{s.count}</span>
            </div>
          ))}
        </Card>
      </div>
      <Card style={{ marginBottom: 14, padding: "12px 16px" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: H.navy }}>Filter:</span>
          <select value={dashFilter.status} onChange={e => setDashFilter(f => ({ ...f, status: e.target.value }))} style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${H.g200}`, fontSize: 12 }}>
            <option value="All">All Statuses</option>{STATUSES.filter(s => s !== "Completed").map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={dashFilter.priority} onChange={e => setDashFilter(f => ({ ...f, priority: e.target.value }))} style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${H.g200}`, fontSize: 12 }}>
            <option value="All">All Priorities</option>{PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          {technicians.length > 0 && <select value={dashFilter.technician} onChange={e => setDashFilter(f => ({ ...f, technician: e.target.value }))} style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${H.g200}`, fontSize: 12 }}>
            <option value="All">All Technicians</option>{technicians.map(t => <option key={t} value={t}>{t}</option>)}
          </select>}
          <SearchBar value={search} onChange={setSearch} placeholder="Search VIN, Stock #, Tech, W.O.#..." />
        </div>
      </Card>
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${H.g100}` }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: H.navy }}>Active Requests</span><span style={{ fontSize: 12, color: H.g400, marginLeft: 8 }}>({filteredSorted.length})</span>
        </div>
        {filteredSorted.length === 0 ? <div style={{ padding: 30, textAlign: "center", color: H.g400, fontSize: 13 }}>{search ? `No results for "${search}"` : "No active requests"}</div> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr style={{ background: H.offWhite }}>
                {["Stock #", "VIN", "Category", "Status", "Priority", "Technician", "W.O.#", "ETA", "Remaining"].map(h => (
                  <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontWeight: 700, color: H.g600, fontSize: 11, textTransform: "uppercase", borderBottom: `1px solid ${H.g100}` }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {filteredSorted.map(r => {
                  const w = workflow[r.id]; const od = isOverdue(r.eta, w?.status);
                  return (<tr key={r.id} style={{ background: od ? "#FFF5F5" : "transparent", borderBottom: `1px solid ${H.g100}` }}>
                    <td style={{ padding: "10px 12px", fontWeight: 600, color: H.navy }}>{r.stock}</td>
                    <td style={{ padding: "10px 12px", fontFamily: "monospace", fontSize: 11, color: H.g600 }}>{r.vin}</td>
                    <td style={{ padding: "10px 12px" }}><Badge bg={H.g100} color={H.g600}>{r.category}</Badge></td>
                    <td style={{ padding: "10px 12px" }}><StatusBadge status={w?.status} eta={r.eta} /></td>
                    <td style={{ padding: "10px 12px" }}><PriorityBadge priority={r.priority} /></td>
                    <td style={{ padding: "10px 12px", color: H.g600 }}>{w?.technician || "—"}</td>
                    <td style={{ padding: "10px 12px", fontFamily: "monospace", fontSize: 11, color: H.g600 }}>{w?.workOrder || "—"}</td>
                    <td style={{ padding: "10px 12px", color: od ? H.red : H.g600, fontWeight: od ? 700 : 400 }}>{fmtDate(r.eta)}</td>
                    <td style={{ padding: "10px 12px", fontWeight: 600, color: od ? H.red : H.blue }}>{r.eta ? timeRemaining(r.eta) : "—"}</td>
                  </tr>);
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
export default function App() {
  const [tab, setTab] = useState("dashboard");
  const [requests, setRequests] = useState([]);
  const [workflow, setWorkflow] = useState({});
  const [technicians, setTechnicians] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const r = await load(SK.requests); const w = await load(SK.workflow); const t = await load(SK.technicians);
      if (r) setRequests(r); if (w) setWorkflow(w); if (t) setTechnicians(t);
      setLoading(false);
    })();
  }, []);

  const resetData = async () => {
    if (confirm("Clear ALL data? This cannot be undone.")) {
      setRequests([]); setWorkflow({}); setTechnicians([]);
      try { await window.storage.delete(SK.requests, true); await window.storage.delete(SK.workflow, true); await window.storage.delete(SK.technicians, true); await window.storage.delete(SK.woCounter, true); } catch {}
    }
  };

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: H.offWhite }}>
      <div style={{ textAlign: "center" }}><div style={{ fontSize: 32, marginBottom: 12 }}>🚗</div><div style={{ fontWeight: 700, color: H.navy }}>Loading Service Tracker...</div></div>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: H.offWhite, fontFamily: "'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif" }}>
      <div style={{
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
        <div style={{ display: "flex", gap: 4, background: "rgba(255,255,255,.08)", borderRadius: 10, padding: 4, flexWrap: "wrap" }}>
          <Tab active={tab === "dashboard"} label="Dashboard" icon="📊" onClick={() => setTab("dashboard")} />
          <Tab active={tab === "entry"} label="Requests" icon="📝" onClick={() => setTab("entry")} />
          <Tab active={tab === "tracker"} label="Workflow" icon="⚙️" onClick={() => setTab("tracker")} />
          <Tab active={tab === "techs"} label="Technicians" icon="👨‍🔧" onClick={() => setTab("techs")} />
        </div>
        <button onClick={resetData} title="Reset all data" style={{
          background: "rgba(255,255,255,.08)", border: "none", color: "rgba(255,255,255,.45)",
          padding: "6px 12px", borderRadius: 6, fontSize: 11, cursor: "pointer", fontWeight: 600,
        }}>Reset</button>
      </div>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
        {tab === "dashboard" && <Dashboard requests={requests} workflow={workflow} />}
        {tab === "entry" && <RequestEntryForm requests={requests} setRequests={setRequests} workflow={workflow} setWorkflow={setWorkflow} />}
        {tab === "tracker" && <WorkflowTracker requests={requests} setRequests={setRequests} workflow={workflow} setWorkflow={setWorkflow} technicians={technicians} />}
        {tab === "techs" && <TechManager technicians={technicians} setTechnicians={setTechnicians} workflow={workflow} requests={requests} />}
      </div>
    </div>
  );
}
