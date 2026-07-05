'use client';

import { useState, useRef, useEffect, useCallback } from "react";
import GerberViewer from './gerber-viewer';
import LayerPanel from './layer-panel';
import PanelConfigPanel from './panel-config';
import ExportPanel from './export-panel';
import { Button } from './ui/button';
import { Layers, LayoutGrid, FileText, Download, Cpu, ChevronLeft, ChevronRight } from 'lucide-react';
import { useAppStore } from '../lib/store';
import JSZip from 'jszip';
import { analyzeGerberSet, GerberQuoteAnalysis } from '../lib/gerber-analysis';
import type { PcbQuoteBreakdownV2 } from '../lib/pricing-engine';
import { toast } from '@/hooks/use-toast';
import { useSession, signOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';


// ─── DESIGN TOKENS ────────────────────────────────────────────────────────────
const C = {
  bg0:      "#020d1f",   // deepest background
  bg1:      "#061628",   // page background
  bg2:      "#0a1e38",   // card background
  bg3:      "#0f2848",   // elevated card
  bg4:      "#162f52",   // hover state
  border:   "#1a3a5c",   // subtle border
  border2:  "#234d78",   // active border
  accent:   "#0ea5e9",   // primary accent (sky blue)
  accent2:  "#38bdf8",   // lighter accent
  accentDim:"rgba(14,165,233,0.12)",
  accentGlow:"rgba(14,165,233,0.25)",
  gold:     "#f59e0b",   // highlight gold
  green:    "#10b981",   // success
  red:      "#ef4444",
  text0:    "#f0f8ff",   // primary text
  text1:    "#94b8d4",   // secondary text
  text2:    "#4a6f94",   // muted text
  text3:    "#2a4a6a",   // very muted
};

const NAV_ITEMS: { key: string; label: string; href?: string }[] = [
  { key:"home",  label:"Home" },
  { key:"order", label:"PCB Order" },
  { key:"panel", label:"Panelization" },
  { key:"assembly", label:"Assembly" },
  { key:"shop",  label:"Shop" },
  { key:"blog",  label:"Blog" },
  { key:"capabilities", label:"Fab Capabilities", href:"/fab-capabilities" },
];

const PCB_SPECS = {
  layers:  ["1","2","4","6","8"],
  qty:     ["5","10","25","50","100","250","500"],
  finish:  ["HASL (Lead-free)","Leaded HASL","ENIG","OSP","Immersion Silver","Hard Gold"],
  color:   ["Green","Black","Blue","Red","White","Yellow"],
  copper:  ["1 oz","2 oz","3 oz"],
  thickness:["0.8mm","1.0mm","1.2mm","1.6mm","2.0mm"],
};

// Real solder-mask swatch colors, keyed off PCB_SPECS.color — selecting a
// color pill fills it with the actual color instead of the generic accent.
const SOLDER_MASK_SWATCH: Record<string, { bg: string; text: string }> = {
  Green:  { bg:"#1f7a3d", text:"#ffffff" },
  Black:  { bg:"#1a1a1a", text:"#ffffff" },
  Blue:   { bg:"#1857a4", text:"#ffffff" },
  Red:    { bg:"#b3261e", text:"#ffffff" },
  White:  { bg:"#e8e6df", text:"#1a1a1a" },
  Yellow: { bg:"#d9a91a", text:"#1a1a1a" },
};

const PRODUCTS = [
  { name:"ESP32-S3 DevKit Pro",     price:"₹849",  tag:"In Stock", cat:"Microcontroller", icon:"🔲" },
  { name:"RP2040 Nano Board",       price:"₹399",  tag:"In Stock", cat:"Microcontroller", icon:"🔳" },
  { name:"STM32F4 Breakout Shield", price:"₹1,199",tag:"Low Stock",cat:"Microcontroller", icon:"◼" },
  { name:"CAN Bus Transceiver Mod", price:"₹649",  tag:"In Stock", cat:"Interface",       icon:"◻" },
  { name:"2.4GHz RF Transceiver",   price:"₹299",  tag:"In Stock", cat:"RF / Wireless",  icon:"◈" },
  { name:"LiPo Charge Controller",  price:"₹549",  tag:"In Stock", cat:"Power",           icon:"⬡" },
  { name:"BME280 Sensor Board",     price:"₹349",  tag:"In Stock", cat:"Sensors",         icon:"◉" },
  { name:"0.96″ OLED Display",      price:"₹199",  tag:"Low Stock",cat:"Displays",        icon:"▣" },
];

const BLOG_POSTS = [
  { title:"4-layer PCB stack-up design for EMC compliance",       date:"May 8, 2026",  tag:"Design Tips",    mins:7 },
  { title:"PCB panelization best practices for SMT reflow",       date:"Apr 29, 2026", tag:"Manufacturing",  mins:5 },
  { title:"Choosing the right surface finish for your board",     date:"Apr 14, 2026", tag:"Materials",      mins:4 },
  { title:"Gerber file formats: RS-274X vs. Gerber X2 explained", date:"Mar 31, 2026", tag:"Basics",         mins:6 },
  { title:"Impedance control in high-speed PCB design",           date:"Mar 18, 2026", tag:"Advanced",       mins:9 },
  { title:"How we achieve 99.4% first-pass yield at ProEmbSys",   date:"Mar 5, 2026",  tag:"Case Study",     mins:6 },
];

// ─── SHARED UI COMPONENTS ─────────────────────────────────────────────────────

function Btn({ children, variant="primary", onClick, style={}, full=false, disabled=false }: { children: React.ReactNode; variant?: "primary" | "outline" | "ghost" | "dark" | "gold"; onClick?: any; style?: React.CSSProperties; full?: boolean; disabled?: boolean }) {
  const base = { border:"none", borderRadius:8, cursor: disabled?"not-allowed":"pointer", fontFamily:"'DM Sans',sans-serif", fontWeight:700, fontSize:14, transition:"all 0.18s", display:"inline-flex", alignItems:"center", justifyContent:"center", gap:6, width: full?"100%":"auto", opacity: disabled?0.55:1 };
  const variants = {
    primary:  { background: C.accent, color:"#fff", padding:"11px 24px", boxShadow:`0 0 20px ${C.accentGlow}` },
    outline:  { background:"transparent", color:C.accent, border:`1.5px solid ${C.border2}`, padding:"10px 22px" },
    ghost:    { background:"transparent", color:C.text1, border:`1px solid ${C.border}`, padding:"9px 18px" },
    dark:     { background:C.bg3, color:C.accent2, border:`1px solid ${C.border2}`, padding:"11px 24px" },
    gold:     { background:C.gold, color:"#020d1f", padding:"12px 28px", fontWeight:800 },
  };
  return <button onClick={onClick} disabled={disabled} style={{...base,...variants[variant],...style}}>{children}</button>;
}

function Tag({ children, color="blue" }) {
  const colors = {
    blue:  { bg:"rgba(14,165,233,0.12)", text:C.accent2 },
    green: { bg:"rgba(16,185,129,0.12)", text:C.green },
    gold:  { bg:"rgba(245,158,11,0.12)", text:C.gold },
    red:   { bg:"rgba(239,68,68,0.12)",  text:C.red },
    gray:  { bg:"rgba(148,184,212,0.08)",text:C.text1 },
  };
  const c = colors[color] || colors.blue;
  return <span style={{ background:c.bg, color:c.text, fontSize:11, fontWeight:700, padding:"3px 10px", borderRadius:20, letterSpacing:0.6, fontFamily:"'DM Sans',sans-serif" }}>{children}</span>;
}

function Card({ children, style={}, glow=false }) {
  return (
    <div style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:14, ...style, ...(glow?{boxShadow:`0 0 32px ${C.accentGlow}`}:{}) }}>
      {children}
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
      <div style={{ width:24, height:1.5, background:C.accent }}/>
      <span style={{ fontSize:11, fontWeight:700, color:C.accent, letterSpacing:2, fontFamily:"'DM Mono',monospace" }}>{children}</span>
    </div>
  );
}

function CircuitBg({ opacity=0.04 }) {
  return (
    <svg style={{ position:"absolute", inset:0, width:"100%", height:"100%", pointerEvents:"none" }} viewBox="0 0 900 500" preserveAspectRatio="xMidYMid slice">
      {Array.from({length:8}).map((_,r)=>Array.from({length:12}).map((_,c)=>(
        <g key={`${r}-${c}`} opacity={opacity*25}>
          <rect x={c*80+5} y={r*64+5} width={55} height={54} rx={3} fill="none" stroke={C.accent} strokeWidth={0.4}/>
          {(r+c)%4===0&&<circle cx={c*80+32} cy={r*64+32} r={4} fill="none" stroke={C.accent} strokeWidth={0.6}/>}
          {(r+c)%3===0&&<line x1={c*80+60} y1={r*64+32} x2={c*80+80} y2={r*64+32} stroke={C.accent} strokeWidth={0.5}/>}
          {(r+c)%5===0&&<line x1={c*80+32} y1={r*64+59} x2={c*80+32} y2={r*64+70} stroke={C.accent} strokeWidth={0.5}/>}
        </g>
      )))}</svg>
  );
}

// ─── NAVBAR ──────────────────────────────────────────────────────────────────

function Navbar({ page, setPage, cartCount }) {
  const { data: session, status } = useSession();
  const router = useRouter();
  return (
    <nav style={{ background:`${C.bg0}ee`, backdropFilter:"blur(16px)", borderBottom:`1px solid ${C.border}`, position:"sticky", top:0, zIndex:200 }}>
      <div style={{ maxWidth:1100, margin:"0 auto", padding:"0 28px", height:62, display:"flex", alignItems:"center", gap:0 }}>
        {/* Logo */}
        <div onClick={()=>setPage("home")} style={{ display:"flex", alignItems:"center", gap:10, marginRight:36, cursor:"pointer", flexShrink:0 }}>
          <div style={{ width:36, height:36, background:`linear-gradient(135deg, ${C.accent} 0%, #0369a1 100%)`, borderRadius:9, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:`0 0 14px ${C.accentGlow}` }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <polygon points="12,2 20,7 20,17 12,22 4,17 4,7" fill="none" stroke="white" strokeWidth="1.5"/>
              <circle cx="12" cy="12" r="3" fill="white"/>
              <line x1="12" y1="2" x2="12" y2="9" stroke="white" strokeWidth="1.2"/>
              <line x1="12" y1="15" x2="12" y2="22" stroke="white" strokeWidth="1.2"/>
            </svg>
          </div>
          <div>
            <div style={{ fontFamily:"'DM Sans',sans-serif", fontSize:20, fontWeight:800, color:C.text0, lineHeight:1, letterSpacing:"-0.5px" }}>
              Pro<span style={{ color:C.accent }}>PCB</span>
            </div>
            <div style={{ fontSize:8.5, color:C.text3, letterSpacing:1.8, fontFamily:"'DM Mono',monospace", marginTop:1 }}>PROEMBSYS TECHNOLOGIES</div>
          </div>
        </div>

        {/* Nav links */}
        <div style={{ display:"flex", gap:2, flex:1 }}>
          {NAV_ITEMS.map(({key,label,href}) => href ? (
            <Link key={key} href={href} style={{ background:"transparent", padding:"7px 14px", borderRadius:8, fontSize:13.5, textDecoration:"none", fontFamily:"'DM Sans',sans-serif", color:C.text1, fontWeight:400, transition:"all 0.15s" }}
              onMouseEnter={e=>{ e.currentTarget.style.background=C.bg3; e.currentTarget.style.color=C.text0; }}
              onMouseLeave={e=>{ e.currentTarget.style.background="transparent"; e.currentTarget.style.color=C.text1; }}>
              {label}
            </Link>
          ) : (
            <button key={key} onClick={()=>setPage(key)} style={{ background: page===key ? C.accentDim : "transparent", border:"none", padding:"7px 14px", borderRadius:8, fontSize:13.5, cursor:"pointer", fontFamily:"'DM Sans',sans-serif", color: page===key ? C.accent2 : C.text1, fontWeight: page===key ? 700 : 400, transition:"all 0.15s" }}
              onMouseEnter={e=>{ if(page!==key){ e.currentTarget.style.background=C.bg3; e.currentTarget.style.color=C.text0; }}}
              onMouseLeave={e=>{ if(page!==key){ e.currentTarget.style.background="transparent"; e.currentTarget.style.color=C.text1; }}}>
              {label}
            </button>
          ))}
        </div>

        {/* Right actions */}
        <div style={{ display:"flex", gap:10, alignItems:"center", flexShrink:0 }}>
          {cartCount>0 && (
            <div onClick={()=>setPage("shop")} style={{ cursor:"pointer", background:C.accentDim, border:`1px solid ${C.border2}`, borderRadius:8, padding:"7px 14px", fontSize:13, color:C.accent2, fontFamily:"'DM Sans',sans-serif", fontWeight:700 }}>
              🛒 {cartCount}
            </div>
          )}
          {status === "authenticated" ? (
            <>
              <Link href="/orders" style={{ fontSize:13, color:C.text1, fontFamily:"'DM Sans',sans-serif", textDecoration:"none" }}>
                {session.user?.name || session.user?.email}
              </Link>
              <Btn variant="ghost" onClick={()=>signOut({ callbackUrl: "/" })} style={{ fontSize:13, padding:"7px 16px" }}>Sign out</Btn>
            </>
          ) : (
            <Btn variant="ghost" onClick={()=>router.push("/login")} style={{ fontSize:13, padding:"7px 16px" }}>Sign in</Btn>
          )}
          <Btn variant="primary" onClick={()=>setPage("order")} style={{ fontSize:13, padding:"8px 18px" }}>Get Quote →</Btn>
        </div>
      </div>
    </nav>
  );
}

// ─── HOME PAGE (REDESIGNED) ───────────────────────────────────────────────────

// Animated PCB schematic SVG for hero visual
function PCBSchematic() {
  return (
    <svg viewBox="0 0 420 340" fill="none" xmlns="http://www.w3.org/2000/svg"
      style={{ width:"100%", height:"100%", opacity:0.92 }}>
      {/* Board outline */}
      <rect x="12" y="12" width="396" height="316" rx="8" stroke="#1a3a5c" strokeWidth="1.5"/>
      <rect x="20" y="20" width="380" height="300" rx="6" fill="#071424"/>

      {/* Copper traces - horizontal */}
      <line x1="40" y1="80" x2="180" y2="80" stroke="#0ea5e9" strokeWidth="1.2" strokeLinecap="round" className="trace"/>
      <line x1="40" y1="110" x2="130" y2="110" stroke="#0ea5e9" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="200" y1="80" x2="380" y2="80" stroke="#0ea5e9" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="250" y1="160" x2="380" y2="160" stroke="#0ea5e9" strokeWidth="0.8" strokeLinecap="round"/>
      <line x1="40" y1="240" x2="200" y2="240" stroke="#0ea5e9" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="220" y1="240" x2="380" y2="240" stroke="#38bdf8" strokeWidth="0.8" strokeLinecap="round"/>
      <line x1="40" y1="270" x2="160" y2="270" stroke="#0ea5e9" strokeWidth="0.8"/>

      {/* Copper traces - vertical */}
      <line x1="180" y1="80" x2="180" y2="180" stroke="#0ea5e9" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="130" y1="110" x2="130" y2="170" stroke="#0ea5e9" strokeWidth="1.2"/>
      <line x1="200" y1="80" x2="200" y2="240" stroke="#38bdf8" strokeWidth="0.8"/>
      <line x1="310" y1="80" x2="310" y2="160" stroke="#0ea5e9" strokeWidth="1.2"/>
      <line x1="160" y1="240" x2="160" y2="270" stroke="#0ea5e9" strokeWidth="0.8"/>
      <line x1="310" y1="160" x2="310" y2="280" stroke="#0ea5e9" strokeWidth="0.8"/>

      {/* IC chip — large */}
      <rect x="56" y="130" width="88" height="72" rx="4" fill="#0a1e38" stroke="#234d78" strokeWidth="1.2"/>
      <rect x="60" y="134" width="80" height="64" rx="3" fill="#061628"/>
      <text x="100" y="168" textAnchor="middle" fill="#38bdf8" fontSize="9" fontFamily="'DM Mono',monospace" fontWeight="700">MCU</text>
      <text x="100" y="180" textAnchor="middle" fill="#2a4a6a" fontSize="7" fontFamily="'DM Mono',monospace">STM32F4</text>
      {/* IC pins */}
      {[0,1,2,3].map(i=><line key={`l${i}`} x1="56" y1={143+i*14} x2="40" y2={143+i*14} stroke="#0ea5e9" strokeWidth="1.5" strokeLinecap="round"/>)}
      {[0,1,2,3].map(i=><line key={`r${i}`} x1="144" y1={143+i*14} x2="160" y2={143+i*14} stroke="#0ea5e9" strokeWidth="1.5" strokeLinecap="round"/>)}
      {[0,1,2].map(i=><line key={`t${i}`} x1={72+i*22} y1="130" x2={72+i*22} y2="114" stroke="#0ea5e9" strokeWidth="1.5" strokeLinecap="round"/>)}
      {[0,1,2].map(i=><line key={`b${i}`} x1={72+i*22} y1="202" x2={72+i*22} y2="218" stroke="#0ea5e9" strokeWidth="1.5" strokeLinecap="round"/>)}

      {/* IC chip — small left */}
      <rect x="40" y="50" width="52" height="36" rx="3" fill="#0a1e38" stroke="#1a3a5c" strokeWidth="1"/>
      <text x="66" y="72" textAnchor="middle" fill="#4a6f94" fontSize="7" fontFamily="'DM Mono',monospace">PWR</text>

      {/* IC chip — right */}
      <rect x="240" y="96" width="72" height="56" rx="4" fill="#0a1e38" stroke="#234d78" strokeWidth="1.2"/>
      <rect x="244" y="100" width="64" height="48" rx="2" fill="#061628"/>
      <text x="276" y="127" textAnchor="middle" fill="#38bdf8" fontSize="8" fontFamily="'DM Mono',monospace" fontWeight="700">FPGA</text>
      {[0,1,2].map(i=><line key={`fr${i}`} x1="312" y1={106+i*14} x2="328" y2={106+i*14} stroke="#0ea5e9" strokeWidth="1.2"/>)}
      {[0,1,2].map(i=><line key={`fl${i}`} x1="240" y1={106+i*14} x2="224" y2={106+i*14} stroke="#0ea5e9" strokeWidth="1.2"/>)}

      {/* Capacitors */}
      {[[260,210],[290,210],[320,210]].map(([x,y],i)=>(
        <g key={i}>
          <rect x={x-6} y={y-10} width="12" height="20" rx="2" fill="#0a1e38" stroke="#234d78" strokeWidth="0.8"/>
          <line x1={x} y1={y-10} x2={x} y2={y-18} stroke="#0ea5e9" strokeWidth="0.8"/>
          <line x1={x} y1={y+10} x2={x} y2={y+18} stroke="#0ea5e9" strokeWidth="0.8"/>
        </g>
      ))}

      {/* Resistors */}
      {[[60,230],[88,230],[116,230]].map(([x,y],i)=>(
        <g key={i}>
          <rect x={x-8} y={y-5} width="16" height="10" rx="2" fill="#0f2848" stroke="#1a3a5c" strokeWidth="0.8"/>
          <line x1={x-8} y1={y} x2={x-16} y2={y} stroke="#0ea5e9" strokeWidth="0.8"/>
          <line x1={x+8} y1={y} x2={x+16} y2={y} stroke="#0ea5e9" strokeWidth="0.8"/>
        </g>
      ))}

      {/* Via holes */}
      {[[180,80],[200,160],[310,160],[160,240],[200,240]].map(([x,y],i)=>(
        <g key={i}>
          <circle cx={x} cy={y} r="4.5" fill="#071424" stroke="#234d78" strokeWidth="1"/>
          <circle cx={x} cy={y} r="2" fill="#0ea5e9" opacity="0.6"/>
        </g>
      ))}

      {/* Mounting holes */}
      {[[32,32],[388,32],[32,308],[388,308]].map(([x,y],i)=>(
        <g key={i}>
          <circle cx={x} cy={y} r="7" fill="#071424" stroke="#1a3a5c" strokeWidth="1"/>
          <circle cx={x} cy={y} r="3.5" fill="#020d1f"/>
        </g>
      ))}

      {/* Connector — bottom */}
      <rect x="230" y="272" width="100" height="28" rx="3" fill="#0a1e38" stroke="#234d78" strokeWidth="1"/>
      {[0,1,2,3,4,5,6].map(i=>(
        <g key={i}>
          <rect x={235+i*13} y="276" width="9" height="8" rx="1" fill="#020d1f" stroke="#0ea5e9" strokeWidth="0.5"/>
          <line x1={239+i*13} y1="284" x2={239+i*13} y2="300" stroke="#0ea5e9" strokeWidth="0.6"/>
        </g>
      ))}

      {/* Signal traces decoration */}
      <path d="M180 180 Q180 218 160 218 Q116 218 116 240" stroke="#0ea5e9" strokeWidth="0.8" fill="none" strokeDasharray="3 2"/>
      <path d="M130 170 Q130 200 88 200 Q88 220 88 230" stroke="#38bdf8" strokeWidth="0.6" fill="none"/>
      <path d="M310 280 Q310 290 280 290 Q255 290 255 290" stroke="#0ea5e9" strokeWidth="0.8" fill="none"/>

      {/* Fiducial marks */}
      {[[60,290],[360,290]].map(([x,y],i)=>(
        <g key={i}>
          <circle cx={x} cy={y} r="6" fill="none" stroke="#234d78" strokeWidth="1" strokeDasharray="2 2"/>
          <circle cx={x} cy={y} r="2.5" fill="#0ea5e9" opacity="0.5"/>
        </g>
      ))}

      {/* Silkscreen text */}
      <text x="330" y="46" fill="#1a3a5c" fontSize="8" fontFamily="'DM Mono',monospace">ProEmbSys v2.1</text>
      <text x="330" y="56" fill="#1a3a5c" fontSize="7" fontFamily="'DM Mono',monospace">PCB-2026-REV-A</text>
    </svg>
  );
}

function HomePage({ setPage }) {
  const [activeService, setActiveService] = useState(0);
  const [tick, setTick] = useState(0);

  // Animate stat counters on mount
  useEffect(()=>{
    const t = setInterval(()=> setTick(n => n < 60 ? n+1 : n), 22);
    return ()=>clearInterval(t);
  },[]);

  const ease = (t) => t < 1 ? t*t*(3-2*t) : 1;
  const prog = ease(Math.min(tick/60,1));

  const stats = [
    { val: Math.round(50000 * prog), suffix:"K+", label:"Boards Delivered", display: v => (v/1000).toFixed(0)+"K+" },
    { val: Math.round(994 * prog)/10, suffix:"%", label:"First-pass Yield", display: v => (v/10).toFixed(1)+"%" },
    { val: Math.round(48 * prog), suffix:" hr", label:"Express Turnaround", display: v => v+" hr" },
    { val: Math.round(500 * prog), suffix:"+", label:"Clients Served", display: v => v+"+" },
  ];

  const services = [
    {
      key:"order", num:"01",
      headline:"PCB Fabrication",
      sub:"Instant Gerber-to-board",
      detail:"Upload Gerber files and watch pricing update live. 1–8 layer boards, multiple surface finishes, express 48-hour manufacturing from our Bangalore facility.",
      specs:["1–8 layers","HASL · ENIG · OSP · Immersion Silver","0.8 mm – 2.0 mm thickness","IPC-A-600 Class II/III"],
      badge:"48-hr EXPRESS",
      color: C.accent,
    },
    {
      key:"panel", num:"02",
      headline:"CAM Panelization",
      sub:"Proprietary Node.js engine",
      detail:"Our in-house panelization CAM tool handles V-score, tab routing, fiducials, custom borders and mousebites — fully automated, production-ready Gerber output.",
      specs:["V-Score · Tab+Route · Mousebite","Auto fiducials & rails","Custom row × col arrays","Download ready in seconds"],
      badge:"PROPRIETARY TOOL",
      color: C.gold,
    },
    {
      key:"assembly", num:"03",
      headline:"PCB Assembly",
      sub:"Turnkey PCBA service",
      detail:"Full turnkey PCBA — we source components, run SMT reflow and THT wave solder, automated optical inspection, X-ray for BGA, and functional testing.",
      specs:["SMT + THT assembly","AOI + X-Ray inspection","BOM sourcing & cross-ref","Conformal coating (opt.)"],
      badge:"TURNKEY PCBA",
      color: C.green,
    },
    {
      key:"shop", num:"04",
      headline:"Electronics Shop",
      sub:"Made in-house, ready to ship",
      detail:"ProEmbSys-designed and manufactured dev boards, sensor modules, RF transceivers, power management ICs — tested, documented, and dispatched pan-India.",
      specs:["ESP32 · RP2040 · STM32","RF · Sensor · Power modules","GST invoice included","Express pan-India shipping"],
      badge:"MADE IN INDIA",
      color:"#a78bfa",
    },
  ];

  const sv = services[activeService];

  return (
    <div style={{ fontFamily:"'DM Sans',sans-serif" }}>
      <style>{`
        @keyframes fadeUp { from { opacity:0; transform:translateY(24px);} to { opacity:1; transform:none;} }
        @keyframes fadeIn { from { opacity:0;} to { opacity:1;} }
        @keyframes scanline { from { transform:translateY(-100%);} to { transform:translateY(100vh);} }
        @keyframes pulse { 0%,100%{ opacity:.4; } 50%{ opacity:1; } }
        @keyframes traceOn { from{ stroke-dashoffset:200; } to{ stroke-dashoffset:0; } }
        @keyframes floatY { 0%,100%{ transform:translateY(0);} 50%{ transform:translateY(-10px);} }
        .hero-h1 { animation: fadeUp 0.7s ease both; }
        .hero-sub { animation: fadeUp 0.7s 0.12s ease both; }
        .hero-cta { animation: fadeUp 0.7s 0.22s ease both; }
        .hero-board { animation: fadeIn 0.9s 0.3s ease both, floatY 6s 1s ease-in-out infinite; }
        .stat-card { animation: fadeUp 0.5s ease both; }
        .ticker-badge { animation: pulse 2.5s ease-in-out infinite; }
      `}</style>

      {/* ═══════════════════════════════════════════════════
          HERO — asymmetric split layout
      ═══════════════════════════════════════════════════ */}
      <section style={{
        position:"relative", overflow:"hidden",
        background:`linear-gradient(160deg, ${C.bg0} 0%, #050f22 55%, #081828 100%)`,
        minHeight:640,
      }}>
        {/* Deep grid background */}
        <svg style={{ position:"absolute", inset:0, width:"100%", height:"100%", opacity:0.035, pointerEvents:"none" }}
          viewBox="0 0 1100 640" preserveAspectRatio="xMidYMid slice">
          {Array.from({length:16}).map((_,c)=>
            <line key={`vc${c}`} x1={c*72} y1="0" x2={c*72} y2="640" stroke="#38bdf8" strokeWidth="0.5"/>)}
          {Array.from({length:10}).map((_,r)=>
            <line key={`hr${r}`} x1="0" y1={r*72} x2="1100" y2={r*72} stroke="#38bdf8" strokeWidth="0.5"/>)}
          {Array.from({length:6}).map((_,r)=>Array.from({length:9}).map((_,c)=>(
            (r+c)%3===0 && <circle key={`d${r}${c}`} cx={c*144+72} cy={r*108+54} r="2" fill="#38bdf8"/>
          )))}
        </svg>

        {/* Large radial glow left */}
        <div style={{ position:"absolute", top:"-10%", left:"-5%", width:700, height:700,
          background:`radial-gradient(ellipse, rgba(14,165,233,0.13) 0%, transparent 65%)`,
          pointerEvents:"none" }}/>
        {/* Subtle scan line */}
        <div style={{ position:"absolute", inset:0, overflow:"hidden", pointerEvents:"none", opacity:0.04 }}>
          <div style={{ position:"absolute", left:0, right:0, height:2, background:`linear-gradient(90deg, transparent, ${C.accent}, transparent)`, animation:"scanline 4s linear infinite" }}/>
        </div>

        {/* Diagonal accent stripe */}
        <div style={{ position:"absolute", top:0, right:0, width:480, height:"100%",
          background:`linear-gradient(135deg, transparent 40%, rgba(14,165,233,0.035) 100%)`,
          borderLeft:`1px solid ${C.border}`, pointerEvents:"none" }}/>

        <div style={{ maxWidth:1100, margin:"0 auto", padding:"0 48px",
          display:"grid", gridTemplateColumns:"1fr 440px", gap:0, alignItems:"center", minHeight:640 }}>

          {/* LEFT — copy */}
          <div style={{ paddingTop:72, paddingBottom:72, paddingRight:56, zIndex:2 }}>
            {/* Company badge */}
            <div style={{ display:"inline-flex", alignItems:"center", gap:10, marginBottom:28,
              background:"rgba(14,165,233,0.08)", border:`1px solid ${C.border2}`,
              borderRadius:4, padding:"6px 14px" }}>
              <div style={{ width:6, height:6, borderRadius:"50%", background:C.green, boxShadow:`0 0 8px ${C.green}` }} className="ticker-badge"/>
              <span style={{ fontSize:11, fontWeight:700, color:C.text1, letterSpacing:2.5, fontFamily:"'DM Mono',monospace" }}>
                PROEMBSYS TECHNOLOGIES PVT LTD
              </span>
            </div>

            <h1 className="hero-h1" style={{
              fontSize:60, fontWeight:800, lineHeight:1.05, letterSpacing:"-2px",
              color:C.text0, margin:"0 0 10px",
            }}>
              Precision
            </h1>
            <h1 style={{
              fontSize:60, fontWeight:800, lineHeight:1.05, letterSpacing:"-2px",
              margin:"0 0 10px",
              background:`linear-gradient(90deg, ${C.accent} 0%, #7dd3fc 100%)`,
              WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent",
              animation:"fadeUp 0.7s 0.07s ease both",
            }}>
              PCB Manufacturing
            </h1>
            <h1 style={{
              fontSize:60, fontWeight:800, lineHeight:1.05, letterSpacing:"-2px",
              color:C.text0, margin:"0 0 32px",
              animation:"fadeUp 0.7s 0.14s ease both",
            }}>
              for Engineers.
            </h1>

            <p className="hero-sub" style={{ fontSize:17, color:C.text1, lineHeight:1.8,
              maxWidth:480, margin:"0 0 40px" }}>
              From single prototypes to volume production — fabrication, assembly, panelization, and electronics manufacturing under one roof in Bangalore.
            </p>

            <div className="hero-cta" style={{ display:"flex", gap:12, flexWrap:"wrap" }}>
              <button onClick={()=>setPage("order")} style={{
                background:`linear-gradient(135deg, ${C.gold} 0%, #fbbf24 100%)`,
                color:"#020d1f", border:"none", padding:"13px 32px", borderRadius:8,
                fontSize:15, fontWeight:800, cursor:"pointer", letterSpacing:0.3,
                boxShadow:`0 4px 24px rgba(245,158,11,0.35)`,
                transition:"all 0.2s",
              }}
                onMouseEnter={e=>{ e.currentTarget.style.transform="translateY(-2px)"; e.currentTarget.style.boxShadow="0 8px 32px rgba(245,158,11,0.5)"; }}
                onMouseLeave={e=>{ e.currentTarget.style.transform="none"; e.currentTarget.style.boxShadow="0 4px 24px rgba(245,158,11,0.35)"; }}>
                Order PCBs →
              </button>
              <button onClick={()=>setPage("panel")} style={{
                background:"transparent", color:C.accent2,
                border:`1.5px solid ${C.border2}`, padding:"13px 28px",
                borderRadius:8, fontSize:15, cursor:"pointer",
                transition:"all 0.2s",
              }}
                onMouseEnter={e=>{ e.currentTarget.style.background=C.accentDim; e.currentTarget.style.borderColor=C.accent; }}
                onMouseLeave={e=>{ e.currentTarget.style.background="transparent"; e.currentTarget.style.borderColor=C.border2; }}>
                Try CAM Tool
              </button>
              <button onClick={()=>setPage("assembly")} style={{
                background:"transparent", color:C.text1,
                border:`1px solid ${C.border}`, padding:"13px 24px",
                borderRadius:8, fontSize:15, cursor:"pointer",
                transition:"all 0.2s",
              }}
                onMouseEnter={e=>{ e.currentTarget.style.color=C.text0; e.currentTarget.style.borderColor=C.border2; }}
                onMouseLeave={e=>{ e.currentTarget.style.color=C.text1; e.currentTarget.style.borderColor=C.border; }}>
                Assembly Quote
              </button>
            </div>

            {/* Micro-trust row */}
            <div style={{ marginTop:36, display:"flex", alignItems:"center", gap:20, flexWrap:"wrap" }}>
              {[["✓ ISO 9001 Certified"],["✓ 99.4% First-pass Yield"],["✓ GST 29AAHCP7519H1Z0"]].map((t,i)=>(
                <span key={i} style={{ fontSize:12, color:C.text2, fontFamily:"'DM Mono',monospace", letterSpacing:0.4 }}>{t}</span>
              ))}
            </div>
          </div>

          {/* RIGHT — PCB schematic visual */}
          <div className="hero-board" style={{ position:"relative", height:420, zIndex:2 }}>
            {/* Glow halo */}
            <div style={{ position:"absolute", inset:-40,
              background:`radial-gradient(ellipse, rgba(14,165,233,0.12) 0%, transparent 70%)`,
              pointerEvents:"none" }}/>
            {/* Board card */}
            <div style={{
              position:"absolute", inset:0,
              background:"#050f20", borderRadius:16,
              border:`1px solid ${C.border2}`,
              boxShadow:`0 0 0 1px ${C.border}, 0 24px 64px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.04)`,
              overflow:"hidden",
            }}>
              {/* Board header bar */}
              <div style={{ height:32, background:C.bg3, borderBottom:`1px solid ${C.border}`,
                display:"flex", alignItems:"center", padding:"0 14px", gap:8 }}>
                {[C.red,"#f59e0b",C.green].map((c,i)=><div key={i} style={{ width:9, height:9, borderRadius:"50%", background:c, opacity:0.8 }}/>)}
                <span style={{ marginLeft:8, fontSize:10, color:C.text3, fontFamily:"'DM Mono',monospace", letterSpacing:1 }}>
                  ProEmbSys_v2.1_REV-A.gbr
                </span>
              </div>
              <div style={{ padding:12, height:"calc(100% - 32px)" }}>
                <PCBSchematic/>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom fade */}
        <div style={{ position:"absolute", bottom:0, left:0, right:0, height:80,
          background:`linear-gradient(transparent, ${C.bg1})`, pointerEvents:"none" }}/>
      </section>

      {/* ═══════════════════════════════════════════════════
          ANIMATED STAT COUNTERS
      ═══════════════════════════════════════════════════ */}
      <section style={{ background:C.bg1, borderBottom:`1px solid ${C.border}` }}>
        <div style={{ maxWidth:1100, margin:"0 auto", padding:"0 48px",
          display:"grid", gridTemplateColumns:"repeat(4,1fr)" }}>
          {stats.map((s,i)=>(
            <div key={i} className="stat-card" style={{
              animationDelay:`${i*0.1}s`,
              padding:"36px 24px", borderRight: i<3 ? `1px solid ${C.border}` : "none",
              position:"relative",
            }}>
              <div style={{ position:"absolute", top:0, left:0, right:0, height:2,
                background:i===0?C.accent:i===1?C.green:i===2?C.gold:"#a78bfa",
                borderRadius:"0 0 2px 2px" }}/>
              <div style={{ fontFamily:"'DM Mono',monospace", fontSize:38, fontWeight:700,
                color:C.text0, lineHeight:1, marginBottom:8, letterSpacing:"-1px" }}>
                {s.display(s.val * 10)}
              </div>
              <div style={{ fontSize:12, color:C.text2, letterSpacing:0.5 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          SERVICES — interactive left-nav + right-detail
      ═══════════════════════════════════════════════════ */}
      <section style={{ background:C.bg0, borderBottom:`1px solid ${C.border}`, padding:"80px 0" }}>
        <div style={{ maxWidth:1100, margin:"0 auto", padding:"0 48px" }}>
          {/* Header */}
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end", marginBottom:52 }}>
            <div>
              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
                <div style={{ width:28, height:1.5, background:C.accent }}/>
                <span style={{ fontSize:11, fontWeight:700, color:C.accent, letterSpacing:2.5, fontFamily:"'DM Mono',monospace" }}>
                  OUR SERVICES
                </span>
              </div>
              <h2 style={{ fontFamily:"'DM Sans',sans-serif", fontSize:40, fontWeight:800,
                color:C.text0, margin:0, letterSpacing:"-1px", lineHeight:1.1 }}>
                End-to-end electronics<br/>manufacturing
              </h2>
            </div>
            <p style={{ fontSize:14, color:C.text2, maxWidth:280, textAlign:"right", lineHeight:1.6 }}>
              ProEmbSys Technologies Pvt Ltd<br/>Bangalore, Karnataka
            </p>
          </div>

          {/* Two-column layout */}
          <div style={{ display:"grid", gridTemplateColumns:"280px 1fr", gap:0,
            border:`1px solid ${C.border}`, borderRadius:16, overflow:"hidden" }}>

            {/* Left: service selector */}
            <div style={{ background:C.bg1, borderRight:`1px solid ${C.border}` }}>
              {services.map((s,i)=>(
                <div key={s.key} onClick={()=>setActiveService(i)}
                  style={{
                    padding:"24px 28px", cursor:"pointer",
                    borderBottom: i<3?`1px solid ${C.border}`:"none",
                    background: activeService===i ? C.bg2 : "transparent",
                    borderLeft: activeService===i ? `3px solid ${s.color}` : "3px solid transparent",
                    transition:"all 0.18s",
                    position:"relative",
                  }}>
                  <div style={{ fontSize:10, fontFamily:"'DM Mono',monospace", color: activeService===i ? s.color : C.text3,
                    letterSpacing:1.5, marginBottom:6, fontWeight:700 }}>{s.num}</div>
                  <div style={{ fontSize:16, fontWeight:700, color: activeService===i ? C.text0 : C.text1,
                    marginBottom:4, fontFamily:"'DM Sans',sans-serif" }}>{s.headline}</div>
                  <div style={{ fontSize:12, color: activeService===i ? C.text2 : C.text3 }}>{s.sub}</div>
                  {activeService===i && (
                    <div style={{ position:"absolute", right:16, top:"50%", transform:"translateY(-50%)",
                      fontSize:16, color:s.color }}>→</div>
                  )}
                </div>
              ))}
            </div>

            {/* Right: service detail */}
            <div style={{ background:C.bg2, padding:"44px 48px", position:"relative", overflow:"hidden" }}>
              {/* Background accent */}
              <div style={{ position:"absolute", top:-60, right:-60, width:300, height:300,
                background:`radial-gradient(circle, ${sv.color}18 0%, transparent 65%)`,
                pointerEvents:"none" }}/>

              <div style={{ position:"relative" }}>
                <div style={{ display:"inline-block", background:`${sv.color}18`,
                  border:`1px solid ${sv.color}40`, borderRadius:4, padding:"4px 12px",
                  fontSize:11, fontWeight:700, color:sv.color, letterSpacing:2,
                  fontFamily:"'DM Mono',monospace", marginBottom:20 }}>
                  {sv.badge}
                </div>

                <h3 style={{ fontFamily:"'DM Sans',sans-serif", fontSize:32, fontWeight:800,
                  color:C.text0, margin:"0 0 16px", letterSpacing:"-0.5px" }}>
                  {sv.headline}
                </h3>

                <p style={{ fontSize:15, color:C.text1, lineHeight:1.8,
                  maxWidth:520, margin:"0 0 36px" }}>
                  {sv.detail}
                </p>

                {/* Spec grid */}
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:40 }}>
                  {sv.specs.map((spec,i)=>(
                    <div key={i} style={{ display:"flex", alignItems:"center", gap:10,
                      padding:"10px 14px", background:C.bg3, borderRadius:8,
                      border:`1px solid ${C.border}` }}>
                      <div style={{ width:6, height:6, borderRadius:"50%",
                        background:sv.color, flexShrink:0 }}/>
                      <span style={{ fontSize:12, color:C.text1, fontFamily:"'DM Mono',monospace" }}>{spec}</span>
                    </div>
                  ))}
                </div>

                <button onClick={()=>setPage(sv.key)} style={{
                  background:sv.color, color: sv.color===C.gold?"#020d1f":"#fff",
                  border:"none", padding:"13px 28px", borderRadius:8,
                  fontSize:14, fontWeight:800, cursor:"pointer", letterSpacing:0.3,
                  boxShadow:`0 4px 20px ${sv.color}40`, transition:"all 0.2s",
                }}
                  onMouseEnter={e=>{ e.currentTarget.style.transform="translateY(-2px)"; }}
                  onMouseLeave={e=>{ e.currentTarget.style.transform="none"; }}>
                  Explore {sv.headline} →
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          PROCESS TIMELINE — horizontal numbered steps
      ═══════════════════════════════════════════════════ */}
      <section style={{ background:C.bg1, padding:"80px 48px", borderBottom:`1px solid ${C.border}` }}>
        <div style={{ maxWidth:1100, margin:"0 auto" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12 }}>
            <div style={{ width:28, height:1.5, background:C.accent }}/>
            <span style={{ fontSize:11, fontWeight:700, color:C.accent, letterSpacing:2.5, fontFamily:"'DM Mono',monospace" }}>
              HOW IT WORKS
            </span>
          </div>
          <h2 style={{ fontFamily:"'DM Sans',sans-serif", fontSize:36, fontWeight:800,
            color:C.text0, margin:"0 0 56px", letterSpacing:"-0.8px" }}>
            From file to finished board
          </h2>

          <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:0, position:"relative" }}>
            {/* connector line */}
            <div style={{ position:"absolute", top:28, left:"10%", right:"10%", height:1,
              background:`linear-gradient(90deg, ${C.accent}, ${C.border2}, ${C.accent})`,
              opacity:0.3 }}/>

            {[
              ["01","Upload","Drop your Gerber, BoM or design files into our secure portal"],
              ["02","Configure","Choose layers, finish, quantity, lead time and service type"],
              ["03","Instant Quote","Live pricing engine runs DRC checks on your files in seconds"],
              ["04","Manufacture","Fabricated & assembled at our Bangalore facility with AOI"],
              ["05","Delivered","Quality-checked, GST-invoiced, dispatched pan-India or globally"],
            ].map(([n,t,d],i)=>(
              <div key={i} style={{ padding:"0 20px 0", textAlign:"center", position:"relative" }}>
                {/* Number circle */}
                <div style={{
                  width:56, height:56, borderRadius:"50%", margin:"0 auto 20px",
                  background: C.bg0,
                  border:`1.5px solid ${i<2 ? C.accent : C.border2}`,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontFamily:"'DM Mono',monospace", fontSize:14, fontWeight:700,
                  color: i<2 ? C.accent : C.text2,
                  boxShadow: i<2 ? `0 0 20px ${C.accentGlow}` : "none",
                  position:"relative", zIndex:1,
                }}>
                  {n}
                </div>
                <div style={{ fontFamily:"'DM Sans',sans-serif", fontWeight:700, fontSize:15,
                  color:C.text0, marginBottom:8 }}>{t}</div>
                <div style={{ fontSize:12, color:C.text2, lineHeight:1.6 }}>{d}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          SHOP TEASER — editorial card layout
      ═══════════════════════════════════════════════════ */}
      <section style={{ background:C.bg0, padding:"80px 48px", borderBottom:`1px solid ${C.border}` }}>
        <div style={{ maxWidth:1100, margin:"0 auto" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end", marginBottom:40 }}>
            <div>
              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
                <div style={{ width:28, height:1.5, background:"#a78bfa" }}/>
                <span style={{ fontSize:11, fontWeight:700, color:"#a78bfa", letterSpacing:2.5, fontFamily:"'DM Mono',monospace" }}>
                  ELECTRONICS SHOP
                </span>
              </div>
              <h2 style={{ fontFamily:"'DM Sans',sans-serif", fontSize:36, fontWeight:800,
                color:C.text0, margin:0, letterSpacing:"-0.8px" }}>
                In-house manufactured modules
              </h2>
            </div>
            <button onClick={()=>setPage("shop")} style={{ background:"transparent", color:"#a78bfa",
              border:`1.5px solid #4c2f8a`, padding:"10px 22px", borderRadius:8,
              fontSize:13, cursor:"pointer", fontWeight:700, transition:"all 0.2s",
              fontFamily:"'DM Sans',sans-serif" }}
              onMouseEnter={e=>{ e.currentTarget.style.background="rgba(167,139,250,0.1)"; }}
              onMouseLeave={e=>{ e.currentTarget.style.background="transparent"; }}>
              View all products →
            </button>
          </div>

          {/* Featured + grid layout */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:16 }}>
            {PRODUCTS.slice(0,4).map((p,i)=>(
              <div key={i} onClick={()=>setPage("shop")}
                style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:14,
                  overflow:"hidden", cursor:"pointer", transition:"all 0.2s",
                  ...(i===0 ? { gridColumn:"span 2" } : {}),
                }}
                onMouseEnter={e=>{ e.currentTarget.style.borderColor="#a78bfa"; e.currentTarget.style.boxShadow="0 4px 24px rgba(167,139,250,0.15)"; e.currentTarget.style.transform="translateY(-3px)"; }}
                onMouseLeave={e=>{ e.currentTarget.style.borderColor=C.border; e.currentTarget.style.boxShadow="none"; e.currentTarget.style.transform="none"; }}>
                <div style={{ height: i===0?160:110, background:C.bg3,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontSize: i===0?64:44, position:"relative" }}>
                  {p.icon}
                  <span style={{ position:"absolute", top:10, right:10 }}>
                    <span style={{ fontSize:10, fontWeight:700,
                      background: p.tag==="In Stock"?"rgba(16,185,129,0.15)":"rgba(245,158,11,0.15)",
                      color: p.tag==="In Stock"?C.green:C.gold,
                      padding:"3px 9px", borderRadius:20, fontFamily:"'DM Mono',monospace", letterSpacing:0.5 }}>
                      {p.tag}
                    </span>
                  </span>
                </div>
                <div style={{ padding:"14px 18px" }}>
                  <div style={{ fontSize:10, color:C.text3, fontWeight:700,
                    fontFamily:"'DM Mono',monospace", marginBottom:5, letterSpacing:1 }}>
                    {p.cat.toUpperCase()}
                  </div>
                  <div style={{ fontSize: i===0?16:13, fontWeight:600, color:C.text0,
                    marginBottom:10, lineHeight:1.35, fontFamily:"'DM Sans',sans-serif" }}>
                    {p.name}
                  </div>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <span style={{ fontSize: i===0?20:16, fontWeight:800, color:"#a78bfa",
                      fontFamily:"'DM Sans',sans-serif" }}>{p.price}</span>
                    <span style={{ fontSize:12, color:"#a78bfa", fontWeight:600 }}>Add →</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          BLOG — large editorial feature + side list
      ═══════════════════════════════════════════════════ */}
      <section style={{ background:C.bg1, padding:"80px 48px", borderBottom:`1px solid ${C.border}` }}>
        <div style={{ maxWidth:1100, margin:"0 auto" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end", marginBottom:40 }}>
            <div>
              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
                <div style={{ width:28, height:1.5, background:C.gold }}/>
                <span style={{ fontSize:11, fontWeight:700, color:C.gold, letterSpacing:2.5, fontFamily:"'DM Mono',monospace" }}>
                  TECHNICAL BLOG
                </span>
              </div>
              <h2 style={{ fontFamily:"'DM Sans',sans-serif", fontSize:36, fontWeight:800,
                color:C.text0, margin:0, letterSpacing:"-0.8px" }}>
                Knowledge from the factory floor
              </h2>
            </div>
            <button onClick={()=>setPage("blog")} style={{ background:"transparent", color:C.gold,
              border:`1.5px solid rgba(245,158,11,0.35)`, padding:"10px 22px", borderRadius:8,
              fontSize:13, cursor:"pointer", fontWeight:700, fontFamily:"'DM Sans',sans-serif",
              transition:"all 0.2s" }}
              onMouseEnter={e=>{ e.currentTarget.style.background="rgba(245,158,11,0.08)"; }}
              onMouseLeave={e=>{ e.currentTarget.style.background="transparent"; }}>
              All articles →
            </button>
          </div>

          <div style={{ display:"grid", gridTemplateColumns:"1fr 340px", gap:20 }}>
            {/* Featured post */}
            <div style={{ background:C.bg0, border:`1px solid ${C.border2}`, borderRadius:16,
              padding:"36px 40px", position:"relative", overflow:"hidden", cursor:"pointer" }}
              onMouseEnter={e=>{ e.currentTarget.style.borderColor=C.gold; }}
              onMouseLeave={e=>{ e.currentTarget.style.borderColor=C.border2; }}>
              <div style={{ position:"absolute", top:0, left:0, right:0, height:3,
                background:`linear-gradient(90deg, ${C.gold}, ${C.accent})` }}/>
              <CircuitBg opacity={0.025}/>
              <div style={{ position:"relative" }}>
                <div style={{ display:"inline-block", background:"rgba(245,158,11,0.12)",
                  border:"1px solid rgba(245,158,11,0.25)", borderRadius:4,
                  padding:"3px 12px", fontSize:11, fontWeight:700, color:C.gold,
                  letterSpacing:2, fontFamily:"'DM Mono',monospace", marginBottom:20 }}>
                  FEATURED
                </div>
                <h3 style={{ fontFamily:"'DM Sans',sans-serif", fontSize:26, fontWeight:800,
                  color:C.text0, margin:"0 0 16px", lineHeight:1.3, letterSpacing:"-0.5px" }}>
                  The complete guide to PCB impedance control for high-speed designs
                </h3>
                <p style={{ fontSize:14, color:C.text1, lineHeight:1.75, margin:"0 0 28px", maxWidth:520 }}>
                  At GHz frequencies, trace geometry becomes as critical as component selection. From microstrip to stripline, our RF engineers explain it all.
                </p>
                <div style={{ display:"flex", alignItems:"center", gap:16 }}>
                  <span style={{ fontSize:12, color:C.text3, fontFamily:"'DM Mono',monospace" }}>May 10, 2026 · 12 min read</span>
                  <button onClick={()=>setPage("blog")} style={{
                    background:"transparent", color:C.gold,
                    border:`1px solid rgba(245,158,11,0.35)`,
                    padding:"7px 16px", borderRadius:6, fontSize:12,
                    cursor:"pointer", fontWeight:700, fontFamily:"'DM Sans',sans-serif",
                  }}>Read →</button>
                </div>
              </div>
            </div>

            {/* Side post list */}
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              {BLOG_POSTS.slice(0,4).map((p,i)=>(
                <div key={i} onClick={()=>setPage("blog")}
                  style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:12,
                    padding:"16px 18px", cursor:"pointer", transition:"all 0.2s",
                    display:"flex", gap:14, alignItems:"flex-start",
                    borderLeft:`3px solid ${[C.accent,C.gold,C.green,"#a78bfa"][i]}`,
                  }}
                  onMouseEnter={e=>{ e.currentTarget.style.background=C.bg3; }}
                  onMouseLeave={e=>{ e.currentTarget.style.background=C.bg2; }}>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:10, fontWeight:700, fontFamily:"'DM Mono',monospace",
                      color:[C.accent,C.gold,C.green,"#a78bfa"][i], letterSpacing:1, marginBottom:5 }}>
                      {p.tag.toUpperCase()}
                    </div>
                    <div style={{ fontSize:13, fontWeight:600, color:C.text0,
                      lineHeight:1.4, marginBottom:5, fontFamily:"'DM Sans',sans-serif" }}>
                      {p.title}
                    </div>
                    <div style={{ fontSize:11, color:C.text3, fontFamily:"'DM Mono',monospace" }}>
                      {p.date} · {p.mins} min
                    </div>
                  </div>
                  <span style={{ fontSize:14, color:C.text3, flexShrink:0, paddingTop:2 }}>→</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          TRUST BAND — dark bar with capability badges
      ═══════════════════════════════════════════════════ */}
      <section style={{ background:C.bg0, padding:"48px 48px", borderBottom:`1px solid ${C.border}` }}>
        <div style={{ maxWidth:1100, margin:"0 auto" }}>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:0 }}>
            {[
              { icon:"🏭", title:"Bangalore Factory",   desc:"In-house fab & assembly" },
              { icon:"🔬", title:"AOI + X-Ray",          desc:"Automated optical inspection" },
              { icon:"📦", title:"Pan-India Shipping",   desc:"Express logistics partners" },
              { icon:"🛡️", title:"ISO 9001 Quality",    desc:"Certified manufacturing" },
              { icon:"💬", title:"Engineer Support",     desc:"Design review & DRC help" },
            ].map((item,i)=>(
              <div key={i} style={{ padding:"24px 20px", textAlign:"center",
                borderRight: i<4 ? `1px solid ${C.border}` : "none" }}>
                <div style={{ fontSize:28, marginBottom:10 }}>{item.icon}</div>
                <div style={{ fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:700,
                  color:C.text0, marginBottom:5 }}>{item.title}</div>
                <div style={{ fontSize:11, color:C.text2, lineHeight:1.5 }}>{item.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          CTA BANNER — full-width conversion section
      ═══════════════════════════════════════════════════ */}
      <section style={{ background:C.bg1, padding:"80px 48px" }}>
        <div style={{ maxWidth:1100, margin:"0 auto" }}>
          <div style={{ background:`linear-gradient(135deg, ${C.bg0} 0%, #0a1e38 100%)`,
            border:`1px solid ${C.border2}`, borderRadius:20, padding:"64px 72px",
            position:"relative", overflow:"hidden", textAlign:"center" }}>
            {/* Glow */}
            <div style={{ position:"absolute", top:"-30%", left:"50%", transform:"translateX(-50%)",
              width:600, height:400, pointerEvents:"none",
              background:`radial-gradient(ellipse, ${C.accentGlow} 0%, transparent 65%)` }}/>
            <CircuitBg opacity={0.03}/>
            <div style={{ position:"relative", zIndex:1 }}>
              <div style={{ display:"inline-block", background:C.accentDim,
                border:`1px solid ${C.border2}`, borderRadius:4, padding:"4px 14px",
                fontSize:11, fontWeight:700, color:C.accent2, letterSpacing:2.5,
                fontFamily:"'DM Mono',monospace", marginBottom:24 }}>
                READY TO START?
              </div>
              <h2 style={{ fontFamily:"'DM Sans',sans-serif", fontSize:44, fontWeight:800,
                color:C.text0, margin:"0 0 16px", letterSpacing:"-1px" }}>
                Build your next board with ProPCB
              </h2>
              <p style={{ fontSize:16, color:C.text1, lineHeight:1.75,
                maxWidth:520, margin:"0 auto 40px" }}>
                Upload your Gerbers and get an instant quote in under 60 seconds. No account required to start.
              </p>
              <div style={{ display:"flex", gap:14, justifyContent:"center", flexWrap:"wrap" }}>
                <button onClick={()=>setPage("order")} style={{
                  background:`linear-gradient(135deg, ${C.gold} 0%, #fbbf24 100%)`,
                  color:"#020d1f", border:"none", padding:"16px 40px",
                  borderRadius:10, fontSize:16, fontWeight:800, cursor:"pointer",
                  boxShadow:"0 4px 28px rgba(245,158,11,0.4)", letterSpacing:0.3,
                  transition:"all 0.2s",
                }}
                  onMouseEnter={e=>{ e.currentTarget.style.transform="translateY(-2px)"; e.currentTarget.style.boxShadow="0 8px 36px rgba(245,158,11,0.55)"; }}
                  onMouseLeave={e=>{ e.currentTarget.style.transform="none"; e.currentTarget.style.boxShadow="0 4px 28px rgba(245,158,11,0.4)"; }}>
                  Get Instant Quote →
                </button>
                <button onClick={()=>setPage("assembly")} style={{
                  background:"transparent", color:C.accent2,
                  border:`1.5px solid ${C.border2}`, padding:"16px 32px",
                  borderRadius:10, fontSize:16, cursor:"pointer", fontWeight:700,
                  transition:"all 0.2s",
                }}
                  onMouseEnter={e=>{ e.currentTarget.style.background=C.accentDim; }}
                  onMouseLeave={e=>{ e.currentTarget.style.background="transparent"; }}>
                  Assembly Quote
                </button>
              </div>
              <div style={{ marginTop:28, fontSize:12, color:C.text3,
                fontFamily:"'DM Mono',monospace", letterSpacing:0.5 }}>
                ProEmbSys Technologies Pvt Ltd · GST 29AAHCP7519H1Z0 · Bangalore, India
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// ─── PCB ORDER PAGE ───────────────────────────────────────────────────────────

function PCBOrderPage() {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [specs, setSpecs] = useState({ layers:"2", qty:"10", finish:"HASL (Lead-free)", color:"Green", copper:"1 oz", thickness:"1.6mm" });
  const [step, setStep] = useState(1);
  const [express, setExpress] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<GerberQuoteAnalysis | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [dimsAutoFilled, setDimsAutoFilled] = useState(false);
  const [orderRef, setOrderRef] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const widthMm = parseFloat(width) || 0;
  const heightMm = parseFloat(height) || 0;
  const hasValidDims = widthMm > 0 && heightMm > 0;

  const [quote, setQuote] = useState<PcbQuoteBreakdownV2 | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  // Pricing now lives server-side (admin-editable rates), so the quote is an
  // async round-trip — debounced so spec-button clicks don't fire a request
  // per keystroke/click.
  useEffect(() => {
    if (!hasValidDims) {
      setQuote(null);
      setQuoteLoading(false);
      return;
    }
    let cancelled = false;
    setQuoteLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            widthMm, heightMm,
            layers: specs.layers,
            qty: parseInt(specs.qty, 10) || 1,
            finish: specs.finish,
            copperWeight: specs.copper,
            thickness: specs.thickness,
            express,
          }),
        });
        if (!res.ok) throw new Error('Quote request failed');
        const data: PcbQuoteBreakdownV2 = await res.json();
        if (!cancelled) setQuote(data);
      } catch {
        if (!cancelled) setQuote(null);
      } finally {
        if (!cancelled) setQuoteLoading(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [hasValidDims, widthMm, heightMm, specs.layers, specs.qty, specs.finish, specs.copper, specs.thickness, express]);

  async function extractEntries(f: File): Promise<{ name: string; content: string }[]> {
    if (f.name.toLowerCase().endsWith('.zip')) {
      const zip = await JSZip.loadAsync(f);
      const entries: { name: string; content: string }[] = [];
      for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        entries.push({ name: path, content: await entry.async('string') });
      }
      return entries;
    }
    return [{ name: f.name, content: await f.text() }];
  }

  const handleFile = useCallback(async (f: File) => {
    setFile(f);
    setStep(2);
    setOrderRef(null);
    if (f.name.toLowerCase().endsWith('.rar')) {
      setAnalysis(null);
      setAnalysisError("RAR archives aren't analyzed automatically yet — enter board dimensions manually below.");
      return;
    }
    setAnalyzing(true);
    setAnalysisError(null);
    try {
      const entries = await extractEntries(f);
      const result = analyzeGerberSet(entries);
      setAnalysis(result);
      if (result.boardWidthMm && result.boardHeightMm) {
        setWidth(result.boardWidthMm.toFixed(2));
        setHeight(result.boardHeightMm.toFixed(2));
        setDimsAutoFilled(true);
      } else {
        setDimsAutoFilled(false);
      }
      if (result.copperLayerCount === 1 || result.copperLayerCount === 2) {
        setSpecs(s => ({ ...s, layers: String(result.copperLayerCount) }));
      }
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : 'Could not read this file.');
    } finally {
      setAnalyzing(false);
    }
  }, []);

  function handleDimsChange(axis: 'width' | 'height', value: string) {
    setDimsAutoFilled(false);
    if (axis === 'width') setWidth(value); else setHeight(value);
  }

  function resetToDetected() {
    if (!analysis?.boardWidthMm || !analysis?.boardHeightMm) return;
    setWidth(analysis.boardWidthMm.toFixed(2));
    setHeight(analysis.boardHeightMm.toFixed(2));
    setDimsAutoFilled(true);
  }

  const { status: sessionStatus } = useSession();
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  async function submitOrder(placeOrder: boolean) {
    if (sessionStatus !== "authenticated") {
      toast({ title: "Sign in required", description: "Create an account or sign in to save a quote or place an order." });
      router.push("/login?callbackUrl=/");
      return null;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file?.name ?? null,
          widthMm, heightMm,
          layers: specs.layers,
          qty: parseInt(specs.qty, 10) || 1,
          finish: specs.finish,
          color: specs.color,
          copperWeight: specs.copper,
          thickness: specs.thickness,
          express,
          placeOrder,
        }),
      });
      if (!res.ok) {
        toast({ title: "Something went wrong", description: "Could not save your order. Please try again." });
        return null;
      }
      return await res.json();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSaveQuote() {
    if (!quote) {
      toast({ title: "Quote not ready", description: "Wait for the price to finish calculating before saving." });
      return;
    }
    const order = await submitOrder(false);
    if (!order) return;
    toast({ title: "Quote saved", description: `Reference ${order.reference} — we'll follow up by email.` });
  }

  async function handlePlaceOrder() {
    if (!hasValidDims) {
      toast({ title: "Board dimensions needed", description: "Enter width and height (or upload Gerbers with an outline layer) before placing an order." });
      return;
    }
    if (!quote) {
      toast({ title: "Quote not ready", description: "Wait for the price to finish calculating before placing an order." });
      return;
    }
    const order = await submitOrder(true);
    if (!order) return;
    setOrderRef(order.reference);
    setStep(3);
    toast({ title: "Order request received", description: `Reference ${order.reference} — our team will verify DRC and send a payment link.` });
  }

  return (
    <div style={{ minHeight:"100vh", background:C.bg1, padding:"40px" }}>
      <div style={{ maxWidth:960, margin:"0 auto" }}>
        <div style={{ marginBottom:32 }}>
          <SectionLabel>PCB FABRICATION ORDER</SectionLabel>
          <h1 style={{ fontFamily:"'DM Sans',sans-serif", fontSize:36, fontWeight:800, color:C.text0, margin:"4px 0 8px", letterSpacing:"-0.5px" }}>Order Custom PCBs</h1>
          <p style={{ color:C.text1, fontSize:15, margin:0 }}>Upload Gerber files · Configure specs · Get instant quote from ProEmbSys Technologies</p>
        </div>

        {/* Step bar */}
        <div style={{ display:"flex", alignItems:"center", gap:0, marginBottom:36 }}>
          {[["1","Upload Gerbers"],["2","Configure Board"],["3","Review & Pay"]].map(([n,l],i)=>(
            <div key={i} style={{ display:"flex", alignItems:"center" }}>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <div style={{ width:34, height:34, borderRadius:"50%", background:step>=i+1?C.accent:C.bg3, border:`1.5px solid ${step>=i+1?C.accent:C.border}`, color:step>=i+1?"#fff":C.text2, display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:700, fontFamily:"'DM Mono',monospace", transition:"all 0.3s" }}>{n}</div>
                <span style={{ fontSize:13, color:step>=i+1?C.text0:C.text2, fontWeight:step===i+1?700:400, fontFamily:"'DM Sans',sans-serif" }}>{l}</span>
              </div>
              {i<2&&<div style={{ width:48, height:1.5, background:step>i+1?C.accent:C.border, margin:"0 14px", transition:"background 0.3s" }}/>}
            </div>
          ))}
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"1fr 310px", gap:24 }}>
          <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
            {/* Upload zone */}
            <Card style={{ padding:0, overflow:"hidden" }}>
              <div style={{ padding:"14px 20px", borderBottom:`1px solid ${C.border}`, display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ fontSize:13, fontWeight:700, color:C.text0, fontFamily:"'DM Sans',sans-serif" }}>Gerber Files</span>
                <Tag color="red">Required</Tag>
              </div>
              <div onDrop={e=>{ e.preventDefault(); setDragging(false); const f=e.dataTransfer.files?.[0]; if(f) handleFile(f); }}
                onDragOver={e=>{ e.preventDefault(); setDragging(true); }} onDragLeave={()=>setDragging(false)}
                onClick={()=>fileRef.current?.click()}
                style={{ border:`2px dashed ${dragging?C.accent:file?C.border2:C.border}`, margin:16, borderRadius:10, padding:"36px 24px", textAlign:"center", cursor:"pointer", background:dragging?C.accentDim:file?"rgba(14,165,233,0.06)":"transparent", transition:"all 0.2s" }}>
                <input ref={fileRef} type="file" accept=".gbr,.zip,.rar" style={{ display:"none" }} onChange={e=>{ const f=e.target.files?.[0]; if(f) handleFile(f); }}/>
                {file ? (
                  <div>
                    <div style={{ fontSize:32, marginBottom:10 }}>{analyzing ? "⏳" : "✅"}</div>
                    <div style={{ fontWeight:700, color:C.accent2, fontSize:15, fontFamily:"'DM Sans',sans-serif" }}>{file.name}</div>
                    <div style={{ fontSize:12, color:C.text2, marginTop:6 }}>{analyzing ? "Reading Gerber layers…" : "Click to replace file"}</div>
                  </div>
                ):(
                  <div>
                    <div style={{ fontSize:36, marginBottom:10, color:C.text3 }}>⬡</div>
                    <div style={{ fontWeight:700, color:C.text0, fontSize:15, marginBottom:6, fontFamily:"'DM Sans',sans-serif" }}>Drop Gerber files here</div>
                    <div style={{ fontSize:13, color:C.text2, marginBottom:16 }}>.gbr .zip .rar accepted · up to 200 MB</div>
                    <Btn variant="outline" style={{ fontSize:13 }}>Browse files</Btn>
                  </div>
                )}
              </div>
              {analysisError && (
                <div style={{ margin:"0 16px 16px", padding:"10px 14px", background:"rgba(239,68,68,0.08)", border:`1px solid ${C.red}40`, borderRadius:8, fontSize:12, color:"#fca5a5", fontFamily:"'DM Sans',sans-serif" }}>
                  {analysisError}
                </div>
              )}
              {analysis && !analyzing && (
                <div style={{ margin:"0 16px 16px", padding:"12px 14px", background:C.bg3, border:`1px solid ${C.border}`, borderRadius:8, display:"flex", flexWrap:"wrap", gap:16 }}>
                  <div style={{ fontSize:11.5, color:C.text1, fontFamily:"'DM Sans',sans-serif" }}>
                    <span style={{ color:C.text2 }}>Detected: </span>
                    {analysis.boardWidthMm && analysis.boardHeightMm
                      ? <strong style={{ color:C.text0 }}>{analysis.boardWidthMm.toFixed(1)} × {analysis.boardHeightMm.toFixed(1)} mm</strong>
                      : <span style={{ color:C.text2 }}>no outline layer found</span>}
                    {" · "}<strong style={{ color:C.text0 }}>{analysis.copperLayerCount || "?"} copper layer{analysis.copperLayerCount===1?"":"s"}</strong>
                    {analysis.holeCount > 0 && <>{" · "}<strong style={{ color:C.text0 }}>{analysis.holeCount} holes</strong></>}
                  </div>
                  {analysis.copperLayerCount === 2 && (specs.layers === "4" || specs.layers === "6" || specs.layers === "8") && (
                    <div style={{ fontSize:11, color:C.gold, fontFamily:"'DM Sans',sans-serif" }}>
                      Only outer copper is visible from Gerbers — inner layers of a {specs.layers}-layer stack-up can&apos;t be auto-detected, confirm the layer count below is correct.
                    </div>
                  )}
                </div>
              )}
            </Card>

            {/* Specs */}
            <Card style={{ padding:0, overflow:"hidden" }}>
              <div style={{ padding:"14px 20px", borderBottom:`1px solid ${C.border}` }}>
                <span style={{ fontSize:13, fontWeight:700, color:C.text0, fontFamily:"'DM Sans',sans-serif" }}>Board Specifications</span>
              </div>
              <div style={{ padding:"20px" }}>
                {/* Board dimensions — auto-filled from the Gerber outline, always editable */}
                <div style={{ marginBottom:20, paddingBottom:20, borderBottom:`1px solid ${C.border}` }}>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
                    <div style={{ fontSize:11, fontWeight:700, color:C.text2, letterSpacing:1, fontFamily:"'DM Mono',monospace" }}>BOARD DIMENSIONS (MM)</div>
                    {dimsAutoFilled ? (
                      <Tag color="blue">Auto-detected</Tag>
                    ) : analysis?.boardWidthMm ? (
                      <button onClick={resetToDetected} style={{ background:"transparent", border:"none", color:C.accent2, fontSize:11, cursor:"pointer", fontFamily:"'DM Sans',sans-serif", fontWeight:700 }}>Reset to detected</button>
                    ) : null}
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <input type="number" min="0" step="0.1" value={width} placeholder="Width"
                      onChange={e=>handleDimsChange('width', e.target.value)}
                      style={{ width:100, padding:"8px 10px", borderRadius:7, border:`1.5px solid ${C.border}`, background:C.bg3, color:C.text0, fontSize:13, fontFamily:"'DM Sans',sans-serif" }}/>
                    <span style={{ color:C.text3, fontSize:13 }}>×</span>
                    <input type="number" min="0" step="0.1" value={height} placeholder="Height"
                      onChange={e=>handleDimsChange('height', e.target.value)}
                      style={{ width:100, padding:"8px 10px", borderRadius:7, border:`1.5px solid ${C.border}`, background:C.bg3, color:C.text0, fontSize:13, fontFamily:"'DM Sans',sans-serif" }}/>
                    <span style={{ color:C.text2, fontSize:12 }}>mm</span>
                  </div>
                  {!hasValidDims && (
                    <div style={{ fontSize:11.5, color:C.text2, marginTop:8, fontFamily:"'DM Sans',sans-serif" }}>
                      Upload Gerbers with an outline/profile layer to auto-fill, or enter dimensions manually.
                    </div>
                  )}
                </div>

                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:20 }}>
                  {Object.entries(PCB_SPECS).map(([key,opts])=>(
                    <div key={key}>
                      <div style={{ fontSize:11, fontWeight:700, color:C.text2, letterSpacing:1, marginBottom:10, fontFamily:"'DM Mono',monospace" }}>{key.toUpperCase()}</div>
                      <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                        {opts.map(o=>{
                          const swatch = key === "color" ? SOLDER_MASK_SWATCH[o] : undefined;
                          const selected = specs[key] === o;
                          const style = swatch
                            ? { padding:"6px 13px", borderRadius:7, border:`1.5px solid ${selected ? swatch.bg : C.border}`, background: selected ? swatch.bg : C.bg3, color: selected ? swatch.text : C.text1, fontSize:12, cursor:"pointer", fontFamily:"'DM Sans',sans-serif", fontWeight: selected ? 700 : 400, transition:"all 0.15s", display:"inline-flex", alignItems:"center", gap:6 }
                            : { padding:"6px 13px", borderRadius:7, border:`1.5px solid ${selected?C.accent:C.border}`, background:selected?C.accentDim:C.bg3, color:selected?C.accent2:C.text1, fontSize:12, cursor:"pointer", fontFamily:"'DM Sans',sans-serif", fontWeight:selected?700:400, transition:"all 0.15s" };
                          return (
                            <button key={o} onClick={()=>setSpecs(s=>({...s,[key]:o}))} style={style}>
                              {swatch && !selected && (
                                <span style={{ width:10, height:10, borderRadius:"50%", background:swatch.bg, border:`1px solid ${C.border2}`, flexShrink:0 }}/>
                              )}
                              {o}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                {/* Express toggle */}
                <div style={{ marginTop:20, padding:"14px 16px", background:C.bg3, borderRadius:10, border:`1px solid ${C.border}`, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                  <div>
                    <div style={{ fontSize:13, fontWeight:700, color:C.text0, fontFamily:"'DM Sans',sans-serif" }}>Express manufacturing</div>
                    <div style={{ fontSize:12, color:C.text2, marginTop:2 }}>2–3 working days · +20% charge</div>
                  </div>
                  <div onClick={()=>setExpress(e=>!e)} style={{ width:46, height:26, borderRadius:13, background:express?C.accent:C.bg4, border:`1px solid ${express?C.accent:C.border}`, cursor:"pointer", position:"relative", transition:"all 0.2s" }}>
                    <div style={{ position:"absolute", top:3, left:express?22:3, width:20, height:20, borderRadius:"50%", background:"#fff", transition:"left 0.2s" }}/>
                  </div>
                </div>
              </div>
            </Card>
          </div>

          {/* Quote panel */}
          <div>
            <div style={{ background:C.bg0, border:`1px solid ${C.border2}`, borderRadius:16, padding:24, position:"sticky", top:80, boxShadow:`0 0 40px ${C.accentGlow}` }}>
              <div style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:C.text3, letterSpacing:2, marginBottom:8 }}>
                {!hasValidDims ? "QUOTE PENDING DIMENSIONS" : quoteLoading || !quote ? "RECALCULATING…" : "INSTANT QUOTE"}
              </div>
              {hasValidDims && quote ? (
                <>
                  <div style={{ fontFamily:"'DM Sans',sans-serif", fontSize:46, fontWeight:800, color:C.accent2, lineHeight:1, marginBottom:4, opacity:quoteLoading?0.5:1, transition:"opacity 0.15s" }}>₹{quote.total.toLocaleString()}</div>
                  <div style={{ fontSize:12, color:C.text2, marginBottom:24 }}>for {specs.qty} boards · excl. GST & shipping</div>
                </>
              ) : (
                <>
                  <div style={{ fontFamily:"'DM Sans',sans-serif", fontSize:32, fontWeight:800, color:C.text3, lineHeight:1, marginBottom:4 }}>
                    {hasValidDims ? "…" : "—"}
                  </div>
                  <div style={{ fontSize:12, color:C.text2, marginBottom:24 }}>
                    {hasValidDims ? "fetching latest pricing…" : "enter board dimensions to see pricing"}
                  </div>
                </>
              )}

              <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:18, marginBottom:18 }}>
                {[
                  ["Board size", hasValidDims ? `${widthMm.toFixed(1)} × ${heightMm.toFixed(1)} mm` : "—"],
                  ["Layers", specs.layers+" layers"],
                  ["Quantity", specs.qty+" pcs"],
                  ["Surface finish", specs.finish],
                  ["Solder mask", specs.color],
                  ["Copper weight", specs.copper],
                  ["Board thickness", specs.thickness],
                  ["Lead time", express?"2–3 days (Express)":"5–7 working days"],
                  ["Setup / tooling fee", quote ? `₹${quote.toolingCharge.toLocaleString()}` : "—"],
                  ["DRC check", "Manual review before production"],
                ].map(([k,v])=>(
                  <div key={k} style={{ display:"flex", justifyContent:"space-between", marginBottom:9, fontSize:12.5 }}>
                    <span style={{ color:C.text2, fontFamily:"'DM Sans',sans-serif" }}>{k}</span>
                    <span style={{ color:C.text0, fontWeight:600, fontFamily:"'DM Sans',sans-serif" }}>{v}</span>
                  </div>
                ))}
              </div>

              {orderRef ? (
                <div style={{ padding:"14px 16px", background:"rgba(16,185,129,0.1)", border:`1px solid ${C.green}40`, borderRadius:10, marginBottom:10 }}>
                  <div style={{ fontSize:13, fontWeight:700, color:C.green, marginBottom:4, fontFamily:"'DM Sans',sans-serif" }}>✓ Order request received</div>
                  <div style={{ fontSize:11.5, color:C.text1, fontFamily:"'DM Sans',sans-serif" }}>Reference <strong style={{ color:C.text0 }}>{orderRef}</strong> — we&apos;ll verify DRC and email a payment link within one business day.</div>
                </div>
              ) : (
                <>
                  <Btn variant="gold" full disabled={!quote || quoteLoading || submitting} style={{ fontSize:15, padding:"13px 0", marginBottom:10 }} onClick={handlePlaceOrder}>{submitting ? "Placing order…" : "Place Order →"}</Btn>
                  <Btn variant="ghost" full disabled={!quote || quoteLoading || submitting} style={{ fontSize:13, padding:"10px 0", marginBottom:16 }} onClick={handleSaveQuote}>{submitting ? "Saving…" : "Save Quote"}</Btn>
                </>
              )}

              <div style={{ padding:"12px 14px", background:C.accentDim, borderRadius:10, border:`1px solid ${C.border2}` }}>
                <div style={{ fontSize:11, fontWeight:700, color:C.accent2, marginBottom:5, fontFamily:"'DM Sans',sans-serif" }}>✓ What&apos;s included</div>
                {["Manual DRC review on all Gerber layers","IPC-A-600 quality standard","Electrical test (continuity)","UL-certified materials"].map(t=>(
                  <div key={t} style={{ fontSize:11, color:C.text2, marginBottom:3, fontFamily:"'DM Sans',sans-serif" }}>• {t}</div>
                ))}
              </div>

              <div style={{ marginTop:14, textAlign:"center", fontSize:11, color:C.text3, fontFamily:"'DM Mono',monospace" }}>
                GST: 29AAHCP7519H1Z0
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── PANELIZATION PAGE ────────────────────────────────────────────────────────

const SIDEBAR_MIN_W = 280;
const SIDEBAR_MAX_W = 600;

function getDefaultSidebarWidth() {
  if (typeof window === 'undefined') return 340;
  const vw = window.innerWidth;
  if (vw < 640) return vw * 0.85;      // Mobile: 85% of viewport
  if (vw < 1024) return vw * 0.4;      // Tablet: 40%
  if (vw < 1440) return 380;           // Small desktop
  return 420;                          // Large desktop
}

function PanelizationPage() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(340);
  const resizing = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);
  const activeTab = useAppStore(s => s.activeTab);
  const setActiveTab = useAppStore(s => s.setActiveTab);

  const onResizeStart = useCallback((e) => {
    e.preventDefault();
    resizing.current = true;
    startX.current = e.clientX;
    startW.current = sidebarWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [sidebarWidth]);

  // Set responsive sidebar width after hydration (client-side only)
  useEffect(() => {
    setSidebarWidth(getDefaultSidebarWidth());
  }, []);

  // Recalculate sidebar width on window resize (snap to responsive default if it exceeds viewport)
  useEffect(() => {
    const onWindowResize = () => {
      setSidebarWidth(prev => {
        const vw = window.innerWidth;
        const maxAllowed = vw < 640 ? vw * 0.85 : Math.min(SIDEBAR_MAX_W, vw * 0.55);
        return Math.min(prev, maxAllowed);
      });
    };
    window.addEventListener('resize', onWindowResize);
    return () => window.removeEventListener('resize', onWindowResize);
  }, []);

  useEffect(() => {
    const onMove = (e) => {
      if (!resizing.current) return;
      const delta = e.clientX - startX.current;
      const next = Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, startW.current + delta));
      setSidebarWidth(next);
    };
    const onUp = () => {
      if (!resizing.current) return;
      resizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  return (
    <div style={{ display:"flex", flexDirection:"column", background:C.bg0, color:C.text0, height:"calc(100vh - 62px)", overflow:"hidden" }}>
      {/* Sub Header for Panelizer */}
      <header style={{ height:48, borderBottom:`1px solid ${C.border}`, background:`${C.bg0}ee`, backdropFilter:"blur(16px)", display:"flex", alignItems:"center", padding:"0 16px", gap:12, flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <Cpu style={{ width:20, height:20, color:C.accent }} />
          <h2 style={{ fontSize:14, fontWeight:700, letterSpacing:"-0.3px", fontFamily:"'DM Sans',sans-serif", color:C.text0, margin:0 }}>
            CAM Panelization Tool
          </h2>
          <span style={{ fontSize:10, color:C.text3, background:C.bg3, padding:"2px 8px", borderRadius:4, fontFamily:"'DM Mono',monospace", letterSpacing:0.5 }}>
            v1.0
          </span>
        </div>

        {/* Tab buttons */}
        <div style={{ display:"flex", gap:4, marginLeft:24 }}>
          {[
            { key: 'layers' as const, icon: Layers, label: 'Layers' },
            { key: 'panel' as const, icon: LayoutGrid, label: 'Panel Config' },
            { key: 'export' as const, icon: Download, label: 'Info & Export' },
          ].map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              onClick={() => {
                setActiveTab(key);
                if (window.innerWidth < 768) setSidebarOpen(true);
              }}
              style={{
                display:"flex", alignItems:"center", gap:6, padding:"6px 12px", borderRadius:7, fontSize:12, cursor:"pointer", transition:"all 0.15s", fontFamily:"'DM Sans',sans-serif",
                background: activeTab === key ? C.accentDim : "transparent",
                color: activeTab === key ? C.accent2 : C.text2,
                border: activeTab === key ? `1px solid ${C.border2}` : "1px solid transparent",
                fontWeight: activeTab === key ? 700 : 400,
              }}
            >
              <Icon style={{ width:14, height:14 }} />
              <span>{label}</span>
            </button>
          ))}
        </div>

        {/* Sidebar toggle */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          style={{ marginLeft:"auto", background:"transparent", border:`1px solid ${C.border}`, borderRadius:6, padding:"4px 8px", cursor:"pointer", color:C.text2, display:"flex", alignItems:"center" }}
        >
          {sidebarOpen ? (
            <ChevronRight style={{ width:16, height:16 }} />
          ) : (
            <ChevronLeft style={{ width:16, height:16 }} />
          )}
        </button>
      </header>

      {/* Main workspace */}
      <div style={{ flex:1, display:"flex", overflow:"hidden", minHeight:0 }}>
        {/* Sidebar */}
        {sidebarOpen && (
          <aside
            style={{ borderRight:`1px solid ${C.border}`, background:`${C.bg1}cc`, flexShrink:0, display:"flex", flexDirection:"column", overflow:"hidden", position:"relative", width:sidebarWidth }}
          >
            <div style={{ flex:1, minHeight:0, overflowY:"auto" }}>
              <div style={{ padding:12, height:"100%" }}>
                {activeTab === 'layers' && <LayerPanel />}
                {activeTab === 'panel' && <PanelConfigPanel />}
                {activeTab === 'export' && <ExportPanel />}
              </div>
            </div>
            {/* Drag handle */}
            <div
              onMouseDown={onResizeStart}
              style={{ position:"absolute", top:0, right:0, width:8, height:"100%", cursor:"col-resize", zIndex:10 }}
              title="Drag to resize"
            >
              <div style={{ position:"absolute", left:"50%", top:"50%", transform:"translate(-50%,-50%)", width:2, height:32, borderRadius:2, background:C.border2, transition:"background 0.15s" }} />
            </div>
          </aside>
        )}

        {/* Canvas area */}
        <main style={{ flex:1, position:"relative", minHeight:0 }}>
          <GerberViewer />
        </main>
      </div>
    </div>
  );
}

// ─── ASSEMBLY PAGE ────────────────────────────────────────────────────────────

function AssemblyPage() {
  const [service, setService] = useState("turnkey");
  const [files, setFiles] = useState({});

  return (
    <div style={{ minHeight:"100vh", background:C.bg1, padding:"40px" }}>
      <div style={{ maxWidth:960, margin:"0 auto" }}>
        <div style={{ marginBottom:28 }}>
          <SectionLabel>PCB ASSEMBLY SERVICE</SectionLabel>
          <h1 style={{ fontFamily:"'DM Sans',sans-serif", fontSize:36, fontWeight:800, color:C.text0, margin:"4px 0 8px", letterSpacing:"-0.5px" }}>PCB Assembly (PCBA)</h1>
          <p style={{ color:C.text1, fontSize:15, margin:0 }}>Full turnkey or consignment assembly · SMT + THT · AOI inspection · Functional test</p>
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"1fr 290px", gap:24 }}>
          <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
            {/* Service type */}
            <Card style={{ padding:0, overflow:"hidden" }}>
              <div style={{ padding:"14px 20px", borderBottom:`1px solid ${C.border}`, fontSize:13, fontWeight:700, color:C.text0, fontFamily:"'DM Sans',sans-serif" }}>Assembly type</div>
              <div style={{ padding:20, display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12 }}>
                {[
                  ["turnkey","Turnkey","We source all components from verified suppliers","Best value"],
                  ["partial","Partial","You supply some, we source the rest","Flexible"],
                  ["consignment","Consignment","You supply all components","Fast turn"],
                ].map(([v,t,d,b])=>(
                  <div key={v} onClick={()=>setService(v)} style={{ border:`2px solid ${service===v?C.accent:C.border}`, borderRadius:12, padding:"16px 14px", cursor:"pointer", background:service===v?C.accentDim:C.bg3, textAlign:"center", transition:"all 0.2s" }}>
                    <div style={{ marginBottom:6 }}><Tag color={service===v?"blue":"gray"}>{b}</Tag></div>
                    <div style={{ fontFamily:"'DM Sans',sans-serif", fontWeight:700, fontSize:14, color:service===v?C.accent2:C.text0, margin:"8px 0 6px" }}>{t}</div>
                    <div style={{ fontSize:11, color:C.text2, lineHeight:1.4 }}>{d}</div>
                  </div>
                ))}
              </div>
            </Card>

            {/* File uploads */}
            <Card style={{ padding:0, overflow:"hidden" }}>
              <div style={{ padding:"14px 20px", borderBottom:`1px solid ${C.border}`, fontSize:13, fontWeight:700, color:C.text0, fontFamily:"'DM Sans',sans-serif" }}>Upload files</div>
              <div style={{ padding:20, display:"flex", flexDirection:"column", gap:10 }}>
                {[
                  ["gerber","Gerber Files","Required","PCB layout in Gerber RS-274X format (.zip)","🗂️"],
                  ["bom","Bill of Materials","Required","Component BOM in CSV or Excel format","📊"],
                  ["cpl","Component Placement","Optional","Pick-and-place file (centroid data)","📍"],
                  ["instructions","Assembly Instructions","Optional","Special notes, test points, markings","📝"],
                ].map(([key,lbl,req,hint,icon])=>(
                  <div key={key} onClick={()=>setFiles(f=>({...f,[key]:lbl+".zip"}))}
                    style={{ display:"flex", alignItems:"center", gap:14, padding:"13px 16px", border:`1.5px dashed ${files[key]?C.border2:C.border}`, borderRadius:10, cursor:"pointer", background:files[key]?C.accentDim:"transparent", transition:"all 0.2s" }}>
                    <div style={{ fontSize:22 }}>{files[key]?"✅":icon}</div>
                    <div style={{ flex:1 }}>
                      <div style={{ fontWeight:600, fontSize:14, color:C.text0, fontFamily:"'DM Sans',sans-serif" }}>{lbl} <Tag color={req==="Required"?"red":"gray"}>{req}</Tag></div>
                      <div style={{ fontSize:12, color:C.text2, marginTop:3 }}>{files[key]||hint}</div>
                    </div>
                    <div style={{ fontSize:12, color:C.accent, fontWeight:700, fontFamily:"'DM Sans',sans-serif" }}>{files[key]?"Replace":"Upload"}</div>
                  </div>
                ))}
              </div>
            </Card>

            {/* Board details */}
            <Card style={{ padding:0, overflow:"hidden" }}>
              <div style={{ padding:"14px 20px", borderBottom:`1px solid ${C.border}`, fontSize:13, fontWeight:700, color:C.text0, fontFamily:"'DM Sans',sans-serif" }}>Board details</div>
              <div style={{ padding:20, display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:14 }}>
                {[["Quantity (boards)","10"],["SMT components","48"],["Through-hole","12"],["Unique parts","18"],["Board size","100×80 mm"],["Test required","Functional"]].map(([l,v])=>(
                  <div key={l}>
                    <div style={{ fontSize:11, color:C.text2, marginBottom:6, fontWeight:700, fontFamily:"'DM Mono',monospace", letterSpacing:0.5 }}>{l.toUpperCase()}</div>
                    <input defaultValue={v} style={{ width:"100%", background:C.bg3, border:`1px solid ${C.border}`, borderRadius:8, padding:"9px 12px", fontSize:13, color:C.text0, fontFamily:"'DM Sans',sans-serif", boxSizing:"border-box", outline:"none" }}/>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* Quote sidebar */}
          <div>
            <div style={{ background:C.bg0, border:`1px solid ${C.border2}`, borderRadius:16, padding:22, position:"sticky", top:80, boxShadow:`0 0 40px ${C.accentGlow}` }}>
              <div style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:C.text3, letterSpacing:2, marginBottom:8 }}>ASSEMBLY QUOTE (EST.)</div>
              <div style={{ fontFamily:"'DM Sans',sans-serif", fontSize:38, fontWeight:800, color:C.accent2, lineHeight:1, marginBottom:4 }}>₹12,400</div>
              <div style={{ fontSize:12, color:C.text2, marginBottom:20 }}>for 10 boards · 5–7 working days</div>

              <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:16, marginBottom:16 }}>
                {[["PCB fabrication","₹3,500"],["Component cost","₹6,200"],["Assembly labor","₹1,800"],["AOI + Testing","₹900"],["Logistics (est.)","₹400"],["GST @ 18%","₹2,232"]].map(([k,v])=>(
                  <div key={k} style={{ display:"flex", justifyContent:"space-between", marginBottom:9, fontSize:12.5 }}>
                    <span style={{ color:C.text2, fontFamily:"'DM Sans',sans-serif" }}>{k}</span>
                    <span style={{ color:C.text0, fontFamily:"'DM Sans',sans-serif" }}>{v}</span>
                  </div>
                ))}
                <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:10, display:"flex", justifyContent:"space-between", fontSize:14, fontFamily:"'DM Sans',sans-serif" }}>
                  <span style={{ color:C.text1, fontWeight:700 }}>Total incl. GST</span>
                  <span style={{ color:C.accent2, fontWeight:800 }}>₹14,632</span>
                </div>
              </div>

              <Btn variant="gold" full style={{ fontSize:14, padding:"13px 0", marginBottom:10 }}>Submit for Final Quote →</Btn>
              <div style={{ fontSize:11, color:C.text3, textAlign:"center", lineHeight:1.5, fontFamily:"'DM Sans',sans-serif", marginBottom:16 }}>Our engineering team reviews files within 4 business hours</div>

              <div style={{ padding:"12px 14px", background:C.accentDim, borderRadius:10, border:`1px solid ${C.border2}` }}>
                <div style={{ fontSize:11, fontWeight:700, color:C.accent2, marginBottom:6, fontFamily:"'DM Sans',sans-serif" }}>Full service includes</div>
                {["✓ Automated BOM parsing & cross-ref","✓ SMT reflow + THT wave solder","✓ Automated Optical Inspection","✓ X-Ray for BGA (on request)","✓ Functional test jig setup","✓ Conformal coating (optional)","✓ GST invoice · GSTIN 29AAHCP7519H1Z0"].map(t=>(
                  <div key={t} style={{ fontSize:11, color:C.text1, marginBottom:3, fontFamily:"'DM Sans',sans-serif" }}>{t}</div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── SHOP PAGE ────────────────────────────────────────────────────────────────

function ShopPage() {
  const [cart, setCart] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState("All");
  const cats = ["All","Microcontroller","Interface","RF / Wireless","Power","Sensors","Displays"];

  const visible = PRODUCTS.filter(p=>filter==="All"||p.cat===filter);

  return (
    <div style={{ minHeight:"100vh", background:C.bg1, padding:"40px" }}>
      <div style={{ maxWidth:1000, margin:"0 auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end", marginBottom:28 }}>
          <div>
            <SectionLabel>ELECTRONICS SHOP</SectionLabel>
            <h1 style={{ fontFamily:"'DM Sans',sans-serif", fontSize:36, fontWeight:800, color:C.text0, margin:"4px 0 6px", letterSpacing:"-0.5px" }}>ProEmbSys Modules</h1>
            <p style={{ color:C.text1, fontSize:15, margin:0 }}>Manufactured in-house · Tested · Ready to ship pan-India</p>
          </div>
          <div style={{ background:C.bg2, border:`1px solid ${C.border2}`, borderRadius:10, padding:"10px 18px", fontFamily:"'DM Sans',sans-serif", fontSize:14, color:C.accent2, fontWeight:700 }}>
            🛒 Cart ({Object.values(cart).reduce((a,b)=>a+b,0)})
          </div>
        </div>

        {/* Category filter */}
        <div style={{ display:"flex", gap:8, marginBottom:28, flexWrap:"wrap" }}>
          {cats.map(c=>(
            <button key={c} onClick={()=>setFilter(c)} style={{ padding:"7px 18px", borderRadius:20, border:`1.5px solid ${filter===c?C.accent:C.border}`, background:filter===c?C.accentDim:C.bg2, color:filter===c?C.accent2:C.text1, fontSize:13, cursor:"pointer", fontWeight:filter===c?700:400, fontFamily:"'DM Sans',sans-serif", transition:"all 0.15s" }}>{c}</button>
          ))}
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(215px, 1fr))", gap:18 }}>
          {visible.map((p,i)=>{
            const idx = PRODUCTS.indexOf(p);
            return (
              <div key={i} style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:14, overflow:"hidden", transition:"all 0.2s" }}
                onMouseEnter={e=>{ e.currentTarget.style.borderColor=C.accent; e.currentTarget.style.boxShadow=`0 4px 24px ${C.accentGlow}`; e.currentTarget.style.transform="translateY(-3px)"; }}
                onMouseLeave={e=>{ e.currentTarget.style.borderColor=C.border; e.currentTarget.style.boxShadow="none"; e.currentTarget.style.transform="none"; }}>
                <div style={{ height:120, background:C.bg3, display:"flex", alignItems:"center", justifyContent:"center", fontSize:50, position:"relative" }}>
                  {p.icon}
                  <span style={{ position:"absolute", top:10, right:10 }}>
                    <Tag color={p.tag==="In Stock"?"green":"gold"}>{p.tag}</Tag>
                  </span>
                </div>
                <div style={{ padding:"14px 16px" }}>
                  <div style={{ fontSize:10, color:C.text3, fontWeight:700, fontFamily:"'DM Mono',monospace", marginBottom:6, letterSpacing:1 }}>{p.cat.toUpperCase()}</div>
                  <div style={{ fontSize:14, fontWeight:600, color:C.text0, marginBottom:12, lineHeight:1.4, fontFamily:"'DM Sans',sans-serif" }}>{p.name}</div>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <span style={{ fontSize:18, fontWeight:800, color:C.accent2, fontFamily:"'DM Sans',sans-serif" }}>{p.price}</span>
                    <button onClick={()=>setCart(c=>({...c,[idx]:(c[idx]||0)+1}))} style={{ background:cart[idx]?C.green:C.accentDim, color:cart[idx]?"#fff":C.accent2, border:`1.5px solid ${cart[idx]?C.green:C.border2}`, padding:"7px 14px", borderRadius:8, fontSize:13, cursor:"pointer", fontWeight:700, fontFamily:"'DM Sans',sans-serif", transition:"all 0.2s" }}>
                      {cart[idx]?`✓ ${cart[idx]} added`:"+ Add"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── BLOG PAGE ────────────────────────────────────────────────────────────────

function BlogPage() {
  const tagColors = { "Design Tips":"blue","Manufacturing":"green","Materials":"gold","Basics":"gray","Advanced":"blue","Case Study":"gold" };

  return (
    <div style={{ minHeight:"100vh", background:C.bg1, padding:"40px" }}>
      <div style={{ maxWidth:960, margin:"0 auto" }}>
        <div style={{ marginBottom:36 }}>
          <SectionLabel>TECHNICAL BLOG</SectionLabel>
          <h1 style={{ fontFamily:"'DM Sans',sans-serif", fontSize:36, fontWeight:800, color:C.text0, margin:"4px 0 8px", letterSpacing:"-0.5px" }}>PCB Knowledge Base</h1>
          <p style={{ color:C.text1, fontSize:15, margin:0 }}>Design guides · Manufacturing insights · Engineering tips from the ProEmbSys team</p>
        </div>

        {/* Featured */}
        <div style={{ background:C.bg0, border:`1px solid ${C.border2}`, borderRadius:18, padding:36, marginBottom:36, position:"relative", overflow:"hidden" }}>
          <CircuitBg opacity={0.03}/>
          <div style={{ position:"relative" }}>
            <div style={{ marginBottom:14 }}><Tag color="gold">FEATURED ARTICLE</Tag></div>
            <h2 style={{ fontFamily:"'DM Sans',sans-serif", fontSize:28, fontWeight:800, color:C.text0, margin:"0 0 14px", lineHeight:1.3, letterSpacing:"-0.5px" }}>
              The complete guide to PCB impedance control for high-speed designs
            </h2>
            <p style={{ color:C.text1, fontSize:15, lineHeight:1.7, margin:"0 0 24px", maxWidth:640 }}>
              At GHz frequencies, trace geometry becomes as critical as component selection. From microstrip to stripline, differential pairs to coplanar waveguide — our RF engineers explain it all.
            </p>
            <div style={{ display:"flex", alignItems:"center", gap:20 }}>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <div style={{ width:34, height:34, borderRadius:"50%", background:C.accentDim, border:`1px solid ${C.border2}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:14 }}>👨‍💻</div>
                <div>
                  <div style={{ fontSize:13, fontWeight:600, color:C.text0, fontFamily:"'DM Sans',sans-serif" }}>ProEmbSys Engineering Team</div>
                  <div style={{ fontSize:11, color:C.text2, fontFamily:"'DM Sans',sans-serif" }}>May 10, 2026 · 12 min read</div>
                </div>
              </div>
              <Btn variant="primary" style={{ fontSize:13, padding:"9px 20px" }}>Read Article →</Btn>
            </div>
          </div>
        </div>

        {/* Category filter */}
        <div style={{ display:"flex", gap:8, marginBottom:28, flexWrap:"wrap" }}>
          {["All","Design Tips","Manufacturing","Materials","Basics","Advanced","Case Study"].map(c=>(
            <span key={c} style={{ padding:"5px 16px", borderRadius:20, background:C.bg2, color:C.text1, fontSize:12, cursor:"pointer", fontWeight:500, border:`1px solid ${C.border}`, fontFamily:"'DM Sans',sans-serif" }}>{c}</span>
          ))}
        </div>

        {/* Post grid */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:18, marginBottom:32 }}>
          {BLOG_POSTS.map((p,i)=>(
            <div key={i} style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:14, padding:"22px", cursor:"pointer", transition:"all 0.2s" }}
              onMouseEnter={e=>{ e.currentTarget.style.borderColor=C.border2; e.currentTarget.style.transform="translateY(-2px)"; }}
              onMouseLeave={e=>{ e.currentTarget.style.borderColor=C.border; e.currentTarget.style.transform="none"; }}>
              <div style={{ height:3, background:[C.accent,C.gold,C.green,C.accent2,"#a78bfa",C.gold][i], borderRadius:2, marginBottom:16 }}/>
              <Tag color={tagColors[p.tag]||"blue"}>{p.tag}</Tag>
              <h3 style={{ fontFamily:"'DM Sans',sans-serif", fontSize:15, fontWeight:700, color:C.text0, margin:"12px 0 10px", lineHeight:1.4 }}>{p.title}</h3>
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:C.text3, fontFamily:"'DM Sans',sans-serif" }}>
                <span>{p.date}</span>
                <span>{p.mins} min read</span>
              </div>
            </div>
          ))}
        </div>

        <div style={{ textAlign:"center" }}>
          <Btn variant="outline" style={{ fontSize:14, padding:"12px 32px" }}>Load more articles</Btn>
        </div>
      </div>
    </div>
  );
}

// ─── FOOTER ───────────────────────────────────────────────────────────────────

function Footer({ setPage }) {
  return (
    <footer style={{ background:C.bg0, borderTop:`1px solid ${C.border}`, padding:"48px 40px 28px", fontFamily:"'DM Sans',sans-serif" }}>
      <div style={{ maxWidth:1000, margin:"0 auto" }}>
        <div style={{ display:"grid", gridTemplateColumns:"2.5fr 1fr 1fr 1fr", gap:32, marginBottom:40 }}>
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16 }}>
              <div style={{ width:32, height:32, background:`linear-gradient(135deg, ${C.accent} 0%, #0369a1 100%)`, borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center" }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <polygon points="12,2 20,7 20,17 12,22 4,17 4,7" fill="none" stroke="white" strokeWidth="1.5"/>
                  <circle cx="12" cy="12" r="3" fill="white"/>
                </svg>
              </div>
              <div>
                <div style={{ fontSize:18, fontWeight:800, color:C.text0 }}>Pro<span style={{ color:C.accent }}>PCB</span></div>
                <div style={{ fontSize:8, color:C.text3, letterSpacing:1.5, fontFamily:"'DM Mono',monospace" }}>BY PROEMBSYS TECHNOLOGIES</div>
              </div>
            </div>
            <p style={{ fontSize:13, lineHeight:1.7, color:C.text2, margin:"0 0 14px", maxWidth:280 }}>
              Precision PCB fabrication, assembly and electronics manufacturing. Proudly made in Bangalore, India.
            </p>
            <div style={{ fontSize:11, color:C.text3, fontFamily:"'DM Mono',monospace", lineHeight:1.8 }}>
              <div>ProEmbSys Technologies Pvt Ltd</div>
              <div>GST: 29AAHCP7519H1Z0</div>
              <div>CIN: U29299KA2024PTC000000</div>
              <div>Bangalore, Karnataka — 560001</div>
            </div>
          </div>
          {([
            ["Services",   [["order","PCB Fabrication"],["panel","Panelization CAM"],["assembly","PCB Assembly"],["shop","Electronics Shop"]]],
            ["Company",    [["home","About Us"],["blog","Blog"],["home","Careers"],["home","Contact"]]],
            ["Support",    [["home","Track Order"],["home","DRC Guidelines"],["home","Gerber Guide"],["home","FAQ"]]],
          ] as const).map(([title,links])=>(
            <div key={title}>
              <div style={{ fontSize:11, fontWeight:700, color:C.text2, letterSpacing:1.5, marginBottom:16, fontFamily:"'DM Mono',monospace" }}>{title.toUpperCase()}</div>
              {links.map((link) => {
                const page = link[0]
                const label = link[1]
                return (
                  <div key={label} onClick={()=>setPage(page)} style={{ fontSize:13, color:C.text2, marginBottom:9, cursor:"pointer", transition:"color 0.15s" }}
                    onMouseEnter={e=>e.currentTarget.style.color=C.accent2} onMouseLeave={e=>e.currentTarget.style.color=C.text2}>
                    {label}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:20, display:"flex", justifyContent:"space-between", alignItems:"center", fontSize:12, color:C.text3 }}>
          <span>© 2026 ProEmbSys Technologies Pvt Ltd. All rights reserved.</span>
          <div style={{ display:"flex", gap:16 }}>
            <span style={{ cursor:"pointer" }}>Privacy Policy</span>
            <span style={{ cursor:"pointer" }}>Terms of Use</span>
            <span style={{ cursor:"pointer" }}>Shipping Policy</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

// ─── ROOT APP ─────────────────────────────────────────────────────────────────

export default function App() {
  const [page, setPage] = useState("home");
  const [cart, setCart] = useState<Record<string, number>>({});
  const cartCount = Object.values(cart).reduce((a,b)=>a+b,0);

  useEffect(() => { window.scrollTo(0, 0); }, [page]);

  const pages = {
    home:     <HomePage setPage={setPage}/>,
    order:    <PCBOrderPage/>,
    panel:    <PanelizationPage/>,
    assembly: <AssemblyPage/>,
    shop:     <ShopPage/>,
    blog:     <BlogPage/>,
  };

  return (
    <div style={{ fontFamily:"'DM Sans', sans-serif", background:C.bg1, minHeight:"100vh", color:C.text0 }}>
      {/* Global styles are in index.css; fonts loaded from index.html */}
      <Navbar page={page} setPage={setPage} cartCount={cartCount}/>
      <main>{pages[page]}</main>
      <Footer setPage={setPage}/>
    </div>
  );
}
