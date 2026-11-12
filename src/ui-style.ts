export const uiCss = `
:root { color-scheme: light; --paper:#f6f5f0; --ink:#202e2c; --muted:#53635f; --line:#bdc8c1; --accent:#155b49; --surface:#fff; font:16px/1.55 system-ui,sans-serif; color:var(--ink); background:var(--paper); }
* { box-sizing:border-box; }
body { margin:0; }
a { color:var(--accent); text-underline-offset:.2em; overflow-wrap:anywhere; }
a:hover { text-decoration-thickness:2px; }
::selection { background:#c6e7d8; color:#102f26; }
:focus-visible { outline:3px solid #176c93; outline-offset:3px; }
header { display:flex; justify-content:space-between; align-items:center; gap:1rem; padding:1.1rem clamp(1rem,4vw,4rem); border-bottom:1px solid var(--line); background:var(--surface); }
.brand { color:var(--ink); text-decoration:none; font-weight:750; font-size:1.2rem; }
nav { display:flex; gap:1.5rem; flex-wrap:wrap; }
nav span, .muted, .revision { color:var(--muted); }
main { max-width:1280px; margin:auto; padding:1.5rem clamp(1rem,4vw,4rem) 4rem; }
h1 { font-size:clamp(1.8rem,3vw,2.6rem); line-height:1.15; max-width:32ch; margin:2rem 0 1rem; letter-spacing:-.025em; text-wrap:balance; }
h2 { font-size:1.5rem; line-height:1.25; margin:0 0 1rem; }
h3 { font-size:1.08rem; line-height:1.4; margin:0 0 .6rem; }
h4 { font-size:1rem; margin:1.2rem 0 .3rem; }
p { margin:.5rem 0 1rem; }
section { margin-top:3rem; padding-top:1.5rem; border-top:1px solid var(--line); scroll-margin-top:1rem; }
article { padding:1.2rem 0; }
article + article, .plan-tasks > li + li { border-top:1px solid var(--line); }
.feature-row { display:grid; grid-template-columns:minmax(0,2fr) minmax(240px,1fr); gap:2rem; }
.task-row { overflow-wrap:anywhere; }
.prose, blockquote { max-width:75ch; white-space:pre-wrap; overflow-wrap:anywhere; }
blockquote { margin:1rem 0; padding:1.2rem; background:#e9efea; font-size:1.1rem; }
.notice { display:flex; flex-wrap:wrap; justify-content:space-between; gap:.4rem 1rem; color:var(--muted); font-size:.85rem; }
#page-state { padding:.75rem 0; font-size:.9rem; }
.section-nav { margin:1.5rem 0; font-size:.9rem; }
.editor { margin:.8rem 0; }
summary { cursor:pointer; font-weight:650; color:var(--accent); padding:.45rem 0; }
form { padding:1rem; background:var(--surface); border:1px solid var(--line); max-width:75ch; }
label { display:block; font-weight:600; font-size:.9rem; margin:0 0 1rem; }
input,textarea,select { display:block; width:100%; font:inherit; color:var(--ink); background:var(--surface); border:1px solid #7b8b83; border-radius:4px; padding:.65rem; margin-top:.35rem; caret-color:var(--accent); }
textarea { resize:vertical; min-height:5rem; }
input[type=number] { max-width:10rem; font-variant-numeric:tabular-nums; }
.form-actions { display:flex; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
button { font:inherit; font-weight:600; background:var(--accent); color:white; border:0; border-radius:4px; min-height:44px; padding:.6rem 1rem; cursor:pointer; }
button:hover { background:#0b4435; }
button:disabled { background:#d5dfd9; color:#42574e; cursor:wait; }
output { flex:1; min-width:12rem; font-size:.9rem; }
pre { white-space:pre-wrap; overflow-wrap:anywhere; padding:1rem; background:#e9efea; font: .9rem/1.6 ui-monospace,monospace; max-width:100%; }
.identifier { overflow-wrap:anywhere; }
.state { font-weight:650; }
.plan-tasks { padding-left:1.4rem; }
.plan-tasks > li { padding:1rem 0; }
footer { border-top:1px solid var(--line); padding:1.5rem clamp(1rem,4vw,4rem); color:var(--muted); font-size:.9rem; }
.skip { position:absolute; left:1rem; top:-5rem; background:white; padding:.8rem; }
.skip:focus { top:1rem; }
@media (max-width:760px) { header { align-items:flex-start; flex-direction:column; } .feature-row { grid-template-columns:minmax(0,1fr); gap:.5rem; } nav { gap:.7rem 1.2rem; } form { padding:.75rem; } h1 { max-width:100%; } }
@media (prefers-reduced-motion:no-preference) { details[open] form { animation:reveal .16s ease-out; } @keyframes reveal { from { clip-path:inset(0 0 8%); } to { clip-path:inset(0); } } }
`;
