"use strict";
/* MRC ZH: GPX -> branded route post, plus the captains' schedule.
   Layout per format: FORMATS. Map look: PALETTE / mapStyle(). Schedule: renderSchedule(). */

/* ---------- constants ---------- */
const FORMATS = {
  feed:   {w:1080, h:1350, box:[0.10,0.36,0.90,0.80], title:150, dist:300, beer:0.865, dateY:40},
  story:  {w:1080, h:1920, box:[0.10,0.33,0.90,0.72], title:270, dist:420, beer:0.78,  dateY:290},
  square: {w:1080, h:1080, box:[0.12,0.40,0.88,0.80], title:100, dist:240, beer:0.87,  dateY:36},
  route:  {w:1080, h:1920, box:[0.12,0.15,0.88,0.85], title:null}
};
const TEXT = "#141414";
/* Map look for posts. "classic" = like the hand-made posts (white water, grey motorways and rail, soft buildings,
   faint dashed paths). To go back to the previous look, set this to "grey". */
const POST_MAP = "classic";
const COLORS = ["#882c29", "#3584ba"];                   // MRC burgundy, MRC blue
const ADV_DEFAULTS = {width:10, simplify:8};
const NO_TRIM = {round:false, trimS:0, trimE:0};          // corner rounding and end trimming were removed from the app
/* Map data: OpenFreeMap vector tiles (OpenStreetMap, OpenMapTiles schema). No API key, no limits.
   ?source=<tilejson url> lets the offline test point at local data. */
const params = new URLSearchParams(location.search);
const MAP_SOURCE = params.get("source") || "https://tiles.openfreemap.org/planet";

/* ---------- state ---------- */
const S = {
  routes: [],        // [{name, pts:[{lat,lon}], cum:[m], total:m}] — one, or two when there are two route options
  fmt: "feed", color: COLORS[0], mapstyle: POST_MAP,   // the map look on posts and route pictures
  zoom: 1, ...ADV_DEFAULTS, ...NO_TRIM,
  pan: {x:0, y:0},   // mercator units
  items: {},         // per format: {title|dist|beer: {dx,dy,scale,rot}} once someone moves, turns or resizes them
};
const $ = id => document.getElementById(id);
const cv = $("cv"), ctx = cv.getContext("2d");

/* ---------- saved preference: route colour only ---------- */
function loadPrefs(){ try{ const p=JSON.parse(localStorage.getItem("mrc-poster")||"{}"); if(COLORS.includes(p.color)) S.color=p.color; }catch(e){} }
function savePrefs(){ try{ localStorage.setItem("mrc-poster", JSON.stringify({v:3, color:S.color})); }catch(e){} }

/* ---------- GPX ---------- */
function parseGPX(text){
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("That file doesn’t look like a GPX file.");
  let nodes = [...doc.getElementsByTagName("trkpt")];
  if (!nodes.length) nodes = [...doc.getElementsByTagName("rtept")];
  if (!nodes.length) nodes = [...doc.getElementsByTagName("wpt")];
  const pts = nodes.map(n => { const e=n.getElementsByTagName("ele")[0];
                     return {lat:parseFloat(n.getAttribute("lat")), lon:parseFloat(n.getAttribute("lon")), ele:e?parseFloat(e.textContent):NaN}; })
                   .filter(p => isFinite(p.lat) && isFinite(p.lon));
  if (pts.length < 2) throw new Error("No route points found in this GPX file.");
  const nm = doc.querySelector("metadata > name, trk > name, rte > name");
  return {pts, name: nm ? nm.textContent.trim() : ""};
}
function hav(a,b){
  const R=6371008.8, r=Math.PI/180;
  const dLat=(b.lat-a.lat)*r, dLon=(b.lon-a.lon)*r;
  const h=Math.sin(dLat/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
function cumulative(pts){
  const c=[0]; for(let i=1;i<pts.length;i++) c.push(c[i-1]+hav(pts[i-1],pts[i])); return c;
}

/* ---------- projection (Web Mercator, 0..1 units) ---------- */
function merc(p){
  const x=(p.lon+180)/360;
  const s=Math.sin(p.lat*Math.PI/180);
  const y=0.5-Math.log((1+s)/(1-s))/(4*Math.PI);
  return {x,y};
}
const metresPerUnit = lat => 40075016.686*Math.cos(lat*Math.PI/180);

/* ---------- geometry helpers ---------- */
function trimPoints(pts, cum, a, b){
  const total=cum[cum.length-1]; const lo=Math.min(a,total), hi=Math.max(lo, total-b);
  const out=[];
  const at=(d)=>{ let i=cum.findIndex(v=>v>=d); if(i<0) return pts[pts.length-1]; if(i===0) return pts[0];
    const t=(d-cum[i-1])/((cum[i]-cum[i-1])||1); return {lat:pts[i-1].lat+(pts[i].lat-pts[i-1].lat)*t, lon:pts[i-1].lon+(pts[i].lon-pts[i-1].lon)*t}; };
  out.push(at(lo));
  for(let i=0;i<pts.length;i++) if(cum[i]>lo && cum[i]<hi) out.push(pts[i]);
  out.push(at(hi));
  return out;
}
function douglasPeucker(p, eps){
  if (p.length<3 || eps<=0) return p.slice();
  const keep=new Uint8Array(p.length); keep[0]=keep[p.length-1]=1;
  const stack=[[0,p.length-1]];
  while(stack.length){
    const [a,b]=stack.pop(); let md=0, mi=-1;
    const ax=p[a].x, ay=p[a].y, dx=p[b].x-ax, dy=p[b].y-ay, L=dx*dx+dy*dy;
    for(let i=a+1;i<b;i++){
      let t=L?((p[i].x-ax)*dx+(p[i].y-ay)*dy)/L:0; t=Math.max(0,Math.min(1,t));
      const ex=ax+t*dx-p[i].x, ey=ay+t*dy-p[i].y, d=ex*ex+ey*ey;
      if(d>md){md=d;mi=i;}
    }
    if(mi>0 && md>eps*eps){keep[mi]=1; stack.push([a,mi],[mi,b]);}
  }
  return p.filter((_,i)=>keep[i]);
}
function chaikin(p, n){
  let q=p; for(let k=0;k<n;k++){ if(q.length<3) break; const r=[q[0]];
    for(let i=0;i<q.length-1;i++){const a=q[i],b=q[i+1]; r.push({x:.75*a.x+.25*b.x,y:.75*a.y+.25*b.y},{x:.25*a.x+.75*b.x,y:.25*a.y+.75*b.y});}
    r.push(q[q.length-1]); q=r;} return q;
}

/* ---------- view ---------- */
/* "Transparent": a tight crop around the route (plus a small margin), longest side 1500 px, so it works as a sticker. */
function routeOnlyFormat(){
  const m=S.mpts; let minx=1e9,miny=1e9,maxx=-1e9,maxy=-1e9;
  for(const p of m){minx=Math.min(minx,p.x);maxx=Math.max(maxx,p.x);miny=Math.min(miny,p.y);maxy=Math.max(maxy,p.y);}
  const L=1500, a=Math.max(maxx-minx,1e-9)/Math.max(maxy-miny,1e-9);
  let w=a>=1?L:Math.round(L*a), h=a>=1?Math.round(L/a):L;
  w=Math.max(w,420); h=Math.max(h,420);                      // very thin routes still get some room
  const pad=48+S.width;                                       // margin so the line's ends and corners aren't cut
  return {w, h, box:[pad/w, pad/h, 1-pad/w, 1-pad/h], fixed:true, title:null};
}
function computeView(F, W, H){
  const m=S.mpts; let minx=1e9,miny=1e9,maxx=-1e9,maxy=-1e9;
  for(const p of m){minx=Math.min(minx,p.x);maxx=Math.max(maxx,p.x);miny=Math.min(miny,p.y);maxy=Math.max(maxy,p.y);}
  const [bx0,by0,bx1,by1]=F.box; const bw=(bx1-bx0)*W, bh=(by1-by0)*H;
  const rw=Math.max(maxx-minx,1e-9), rh=Math.max(maxy-miny,1e-9);
  const zoom=F.fixed?1:S.zoom, pan=F.fixed?{x:0,y:0}:S.pan;   // "Transparent" is always the whole route
  const scale=Math.min(bw/rw, bh/rh)*zoom;            // px per mercator unit
  const cx=(minx+maxx)/2 - pan.x, cy=(miny+maxy)/2 - pan.y;
  const ox=(bx0+bx1)/2*W, oy=(by0+by1)/2*H;
  return {scale, cx, cy, ox, oy, toPx:(p)=>({x:ox+(p.x-cx)*scale, y:oy+(p.y-cy)*scale})};
}

/* ---------- map (MapLibre, drawn off-screen, copied into the post) ---------- */
const PALETTE = {
  classic:{bg:"#eef0f0", park:"#e7eae7", water:"#ffffff", building:"#e2e4e5", road:"#ffffff", minor:"#fafafa", rail:"#cfd2d3", major:"#d6d9da", path:"#dfe2e3",
           calm:true},   // calm: less detail, like the hand-made posts (no driveways/yards, buildings and paths only when zoomed far in)
  grey:  {bg:"#eef0f0", park:"#e8ebe8", water:"#dde2e4", building:"#e6e8e8", road:"#ffffff", minor:"#fbfbfb", rail:"#dfe1e1"},   // light, like the hand-made posts
  night: {bg:"#2a2622", park:"#2b2a22", water:"#24262a", building:"#312c27", road:"#463f37", minor:"#3a342e", rail:"#352f29"}   // map pictures in the dark themes
};
/* The dark theme gets dark (warm) map pictures */
function darkUI(){ const t=document.documentElement.getAttribute("data-theme"); return t ? t.startsWith("dark") : matchMedia("(prefers-color-scheme: dark)").matches; }
function mapStyle(name){
  const c=PALETTE[name]||PALETTE.grey;
  const w=(base)=>["interpolate",["exponential",1.6],["zoom"],10,base*0.25,14,base,18,base*9];
  const roads=[
    ["path",   ["path","track"],                          0.9, c.path||c.minor, c.path?[2,2]:null, c.calm?15.5:0],
    ["minor",  c.calm?["minor"]:["minor","service"],      1.6, c.minor],
    ["street", ["tertiary","secondary"],                  2.6, c.road],
    ["major",  ["primary","trunk"],                       3.4, c.road],
    ["motorway",["motorway"],                             3.8, c.major||c.road],   // classic: grey bands, like the hand-made posts
  ];
  return {
    version:8,
    sources:{omt:{type:"vector", url:MAP_SOURCE}},
    layers:[
      {id:"bg", type:"background", paint:{"background-color":c.bg}},
      {id:"park", type:"fill", source:"omt", "source-layer":"park", paint:{"fill-color":c.park}},
      {id:"landcover", type:"fill", source:"omt", "source-layer":"landcover", filter:["in",["get","class"],["literal",["grass","wood","farmland"]]], paint:{"fill-color":c.park}},
      {id:"water", type:"fill", source:"omt", "source-layer":"water", paint:{"fill-color":c.water}},
      {id:"waterway", type:"line", source:"omt", "source-layer":"waterway", paint:{"line-color":c.water, "line-width":w(1.5)}},
      {id:"building", type:"fill", source:"omt", "source-layer":"building", minzoom:c.calm?15.5:14, paint:{"fill-color":c.building}},
      {id:"rail", type:"line", source:"omt", "source-layer":"transportation",
        filter:c.calm?["all",["==",["get","class"],"rail"],["!",["has","service"]]]:["==",["get","class"],"rail"],   // calm: main lines, not yards and sidings
        paint:{"line-color":c.rail, "line-width":w(c.major?2.2:1)}},
      ...roads.map(([id,cls,width,color,dash,minz])=>({id:"road-"+id, type:"line", source:"omt", "source-layer":"transportation", ...(minz?{minzoom:minz}:{}),
        filter:["all",["in",["get","class"],["literal",cls]],["!=",["get","brunnel"],"tunnel"]],
        layout:{"line-cap":dash?"butt":"round","line-join":"round"}, paint:{"line-color":color, "line-width":w(width), ...(dash?{"line-dasharray":dash}:{})}})),
    ]
  };
}
const M = {map:null, style:null, w:0, h:0, ready:false, error:false, idle:true};
function ensureMap(W,H){
  if(typeof maplibregl==="undefined"){ M.error=true; return null; }
  const box=$("mapbox");
  if(!M.map){
    box.style.width=W+"px"; box.style.height=H+"px"; M.w=W; M.h=H;
    M.style=S.mapstyle;
    M.map=new maplibregl.Map({container:box, style:mapStyle(S.mapstyle), interactive:false, attributionControl:false,
      pixelRatio:1, preserveDrawingBuffer:true, fadeDuration:0, center:[8.53,47.37], zoom:13});
    M.map.on("load",()=>{M.ready=true; scheduleDraw();});
    M.map.on("render",()=>{ if(M.pend) M.shown=M.pend; scheduleDraw(); });   // the map picture now shows M.pend
    M.map.on("idle",()=>{M.idle=true; scheduleDraw();});
    M.map.on("error",(e)=>{ console.warn("map", e && e.error && e.error.message); M.error=true; scheduleDraw(); });
  }
  if(M.w!==W||M.h!==H){ box.style.width=W+"px"; box.style.height=H+"px"; M.w=W; M.h=H; M.map.resize(); }
  if(M.style!==S.mapstyle){ M.style=S.mapstyle; M.map.setStyle(mapStyle(S.mapstyle)); }
  return M.map;
}
function unitToLngLat(ux,uy){
  return [ux*360-180, Math.atan(Math.sinh(Math.PI*(1-2*uy)))*180/Math.PI];
}
function syncMap(V,W,H){
  const map=ensureMap(W,H); if(!map) return null;
  const ux=V.cx+(W/2-V.ox)/V.scale, uy=V.cy+(H/2-V.oy)/V.scale;
  const zoom=Math.log2(V.scale/512);
  const c=map.getCenter(), key=[ux,uy,zoom].map(v=>v.toFixed(9)).join();
  if(M.key!==key){ M.key=key; M.idle=false; M.pend={ux, uy, s:V.scale}; map.jumpTo({center:unitToLngLat(ux,uy), zoom}); }
  return map;
}
function drawMap(V, W, H){
  const bg=(PALETTE[S.mapstyle]||PALETTE.grey).bg;   // (same for "classic")
  ctx.fillStyle=S.mapstyle==="none"?"#e6e6e6":bg; ctx.fillRect(0,0,W,H);
  if(S.mapstyle==="none") return true;
  const map=syncMap(V,W,H);
  // The map picture can lag a frame behind (while loading, zooming or dragging): place it where the view it
  // actually shows belongs, so map and route always line up.
  if(map && M.ready){ try{ const d=M.shown||M.pend, k=d?V.scale/d.s:1;
      const x=d?V.ox+(d.ux-W/2/d.s-V.cx)*V.scale:0, y=d?V.oy+(d.uy-H/2/d.s-V.cy)*V.scale:0;
      ctx.drawImage(map.getCanvas(), x, y, W*k, H*k); }catch(e){ M.error=true; } }
  return !!(map && M.ready && M.idle);
}
function mapSettled(timeout=8000){
  if(S.fmt==="route"||S.mapstyle==="none"||!M.map) return Promise.resolve();
  return new Promise(res=>{ const t0=Date.now(); (function wait(){ if((M.ready&&M.idle&&M.map.areTilesLoaded())||M.error||Date.now()-t0>timeout) return res(); setTimeout(wait,120); })(); });
}


/* ---------- drawing ---------- */
const otherColor = c => c===COLORS[0] ? COLORS[1] : COLORS[0];
const routeColor = i => i===0 ? S.color : otherColor(S.color);
/* Two routes on the same streets: draw them side by side, like lines on a metro map.
   The shorter route's shared stretches are snapped onto the longer one (so GPS wobble doesn't matter)
   and both lines are moved half a line width apart, the shorter one to the inside of the longer loop.
   Where they meet or split, the lines ease apart over a few line widths. Both keep their normal width. */
function sideBySide(pa, pb, w, tol){
  const dense=(pts,step)=>{ const out=[]; for(let i=1;i<pts.length;i++){ const a=pts[i-1], b=pts[i], n=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/step));
      for(let k=0;k<n;k++) out.push({x:a.x+(b.x-a.x)*k/n, y:a.y+(b.y-a.y)*k/n}); } out.push(pts[pts.length-1]); return out; };
  const step=Math.max(2,w/4), A=dense(pa,step), B=dense(pb,step), cell=Math.max(tol*2,8);
  // grid of segments for fast "nearest point on the other line"
  const grid=line=>{ const g=new Map(); for(let i=1;i<line.length;i++){ const a=line[i-1], b=line[i];
      const k=Math.floor((a.x+b.x)/2/cell)+":"+Math.floor((a.y+b.y)/2/cell); (g.get(k)||g.set(k,[]).get(k)).push(i); } return g; };
  const near=(p,line,g)=>{ let best=null; const cx=Math.floor(p.x/cell), cy=Math.floor(p.y/cell);
    for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++) for(const i of g.get((cx+dx)+":"+(cy+dy))||[]){
      const a=line[i-1], b=line[i], vx=b.x-a.x, vy=b.y-a.y, L2=vx*vx+vy*vy||1, t=Math.max(0,Math.min(1,((p.x-a.x)*vx+(p.y-a.y)*vy)/L2));
      const q={x:a.x+t*vx, y:a.y+t*vy}, d=Math.hypot(p.x-q.x,p.y-q.y);
      if(!best||d<best.d) best={d, q, i}; }
    return best; };
  // direction along the longer line, looked at over a few line widths (no kinks from single GPS points)
  const K=Math.max(2,Math.ceil(w*1.5/step));
  const dirA=i=>{ const a=A[Math.max(0,i-K)], b=A[Math.min(A.length-1,i+K)], L=Math.hypot(b.x-a.x,b.y-a.y)||1; return {ux:(b.x-a.x)/L, uy:(b.y-a.y)/L}; };
  const gA=grid(A), gB=grid(B);
  // on the same street = within tol of the other line; short gaps (GPS drifting apart for a moment) are bridged
  const shared=(line,other,g)=>{ const f=line.map(p=>{ const n=near(p,other,g); return !!n && n.d<tol; });
    const gap=Math.ceil(w*3/step); let i=0;
    while(i<f.length){ if(f[i]){ i++; continue; } let j=i; while(j<f.length && !f[j]) j++;
      if(i>0 && j<f.length && j-i<=gap) for(let k=i;k<j;k++) f[k]=true; i=j; }
    return f; };
  const ease=(line,flags)=>{ const cum=[0]; for(let i=1;i<line.length;i++) cum.push(cum[i-1]+Math.hypot(line[i].x-line[i-1].x,line[i].y-line[i-1].y));
    const R=w*3, out=new Array(line.length).fill(0); let last=-Infinity;
    for(let i=0;i<line.length;i++){ if(!flags[i]) last=cum[i]; out[i]=flags[i]?cum[i]-last:0; }
    last=Infinity; for(let i=line.length-1;i>=0;i--){ if(!flags[i]) last=cum[i]; if(flags[i]) out[i]=Math.min(out[i], last-cum[i]); }
    return out.map(d=>{ const x=Math.min(1,d/R); return x*x*(3-2*x); }); };
  let area=0; for(let i=1;i<pa.length;i++) area+=pa[i-1].x*pa[i].y-pa[i].x*pa[i-1].y;
  const out=area>0?-1:1, h=w/2;                       // which side is outside the longer loop
  const sa=ease(A,shared(A,B,gB)), sb=ease(B,shared(B,A,gA));
  const A2=A.map((p,i)=>{ if(!sa[i]) return p; const d=dirA(i); return {x:p.x-d.uy*out*h*sa[i], y:p.y+d.ux*out*h*sa[i]}; });
  const B2=B.map((p,i)=>{ if(!sb[i]) return p; const n=near(p,A,gA); if(!n) return p; const d=dirA(n.i);
    const tx=n.q.x+d.uy*out*h, ty=n.q.y-d.ux*out*h; return {x:p.x+(tx-p.x)*sb[i], y:p.y+(ty-p.y)*sb[i]}; });
  const smooth=(l,k)=>{ for(let r=0;r<k;r++) l=[l[0], ...l.slice(1,-1).map((p,i)=>({x:(l[i].x+2*p.x+l[i+2].x)/4, y:(l[i].y+2*p.y+l[i+2].y)/4})), l[l.length-1]]; return l; };
  return [smooth(A2,3), smooth(B2,3)];
}
function strokeRoute(px, w, color){
  ctx.save(); ctx.lineJoin="round"; ctx.lineCap="round"; ctx.lineWidth=w; ctx.strokeStyle=color;
  ctx.beginPath(); px.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.stroke(); ctx.restore();
}
/* MikkelWind has no Ä Ö Ü (and no accented capitals), and its ä ö ü have no dots. So letters
   with marks are drawn as the plain letter, plus dots made from the font's own full stop
   (or a small accent stroke) placed above it. ß is written SS. */
const MW_KEEP = "ÅåÆæØø";                                      // these exist in the font as they are
const MARK = {"\u0308":"dots", "\u0301":"acute", "\u0300":"grave", "\u0302":"circ", "\u030A":"ring", "\u0303":"tilde"};
function mwSplit(text){
  let base="", marks=[];
  for(const ch of text.replace(/ß/g,"SS").replace(/ẞ/g,"SS")){
    if(MW_KEEP.includes(ch)){ base+=ch; continue; }
    const parts=[...ch.normalize("NFD")];
    if(parts.length>1){ marks.push({i:base.length, kind:MARK[parts[1]]||null}); base+=parts[0]; }
    else base+=ch;
  }
  return {base, marks:marks.filter(m=>m.kind)};
}
/* Draw MikkelWind text; y is the top of the text (like textBaseline "top"). */
function drawMW(text, x, y, size, align="center"){
  const {base, marks}=mwSplit(text);
  ctx.save(); ctx.font=`${size}px "MikkelWind"`; ctx.textBaseline="alphabetic"; ctx.textAlign="left";
  const full=ctx.measureText(base);
  const top=full.fontBoundingBoxAscent;                          // same top as textBaseline "top"
  const x0= align==="center" ? x-full.width/2 : align==="right" ? x-full.width : x;
  const by=y+top;
  ctx.fillText(base, x0, by);
  for(const m of marks){
    const before=ctx.measureText(base.slice(0,m.i)).width, ch=base[m.i];
    const t=letterTop(ch, size);                                   // where the ink is at the top of this letter
    drawMark(m.kind, x0+before+t.cx, by-t.top, size, t.w);
  }
  ctx.restore();
  return full.width;
}
/* Measure a letter as drawn: centre and width of its ink in the top fifth (the font leans a
   little, so the top of a letter is not above the middle of its box), and its height. */
const _lt=new Map();
function letterTop(ch, size){
  const key=ch+"|"+size; if(_lt.has(key)) return _lt.get(key);
  const c=document.createElement("canvas"), pad=Math.ceil(size*0.5);
  c.width=Math.ceil(size*1.6)+pad*2; c.height=Math.ceil(size*1.6);
  const g=c.getContext("2d"); g.font=`${size}px "MikkelWind"`; g.textBaseline="alphabetic"; g.fillStyle="#000";
  const base=Math.ceil(size*1.2); g.fillText(ch, pad, base);
  const d=g.getImageData(0,0,c.width,c.height).data, W=c.width;
  let top=-1, bottom=-1;
  for(let y=0;y<c.height && top<0;y++) for(let x=0;x<W;x++) if(d[(y*W+x)*4+3]>128){ top=y; break; }
  for(let y=base;y>top && bottom<0;y--) for(let x=0;x<W;x++) if(d[(y*W+x)*4+3]>128){ bottom=y; break; }
  // centre: middle of the ink in the top 30% of the letter; spread: from the whole letter's width
  // (an A is narrow at the top, but its dots should still sit as far apart as on an O)
  const band=Math.max(2,Math.round((bottom-top)*0.3));
  let n=0,minx=W,maxx=0,fminx=W,fmaxx=0;
  for(let y=top;y<=bottom;y++) for(let x=0;x<W;x++) if(d[(y*W+x)*4+3]>128){
    fminx=Math.min(fminx,x); fmaxx=Math.max(fmaxx,x);
    if(y<top+band){ n++; minx=Math.min(minx,x); maxx=Math.max(maxx,x); } }
  const r = n ? {cx:(minx+maxx)/2-pad, top:base-top, w:fmaxx-fminx} : {cx:size*0.3, top:size*0.7, w:size*0.6};
  _lt.set(key,r); return r;
}
function drawMark(kind, cx, capTop, size, w){
  const dotFont=Math.round(size*0.8);
  if(kind==="dots"){
    ctx.font=`${dotFont}px "MikkelWind"`;
    const pm=ctx.measureText("."), dh=pm.actualBoundingBoxAscent+pm.actualBoundingBoxDescent;
    const cy=capTop-size*0.06-dh/2;
    for(const dx of [-w*0.22, w*0.22]){
      const px=cx+dx-(pm.actualBoundingBoxRight-pm.actualBoundingBoxLeft)/2;
      const py=cy-(pm.actualBoundingBoxDescent-pm.actualBoundingBoxAscent)/2;
      ctx.fillText(".", px, py);
    }
    ctx.font=`${size}px "MikkelWind"`;
    return;
  }
  ctx.save(); ctx.strokeStyle=ctx.fillStyle; ctx.lineCap="round"; ctx.lineJoin="round"; ctx.lineWidth=size*0.075;
  const h=size*0.13, g=size*0.07, yb=capTop-g;
  ctx.beginPath();
  if(kind==="acute"){ ctx.moveTo(cx-w*0.08,yb); ctx.lineTo(cx+w*0.12,yb-h); }
  else if(kind==="grave"){ ctx.moveTo(cx+w*0.08,yb); ctx.lineTo(cx-w*0.12,yb-h); }
  else if(kind==="circ"){ ctx.moveTo(cx-w*0.2,yb); ctx.lineTo(cx,yb-h); ctx.lineTo(cx+w*0.2,yb); }
  else if(kind==="tilde"){ ctx.moveTo(cx-w*0.22,yb-h*0.3); ctx.quadraticCurveTo(cx-w*0.1,yb-h*1.1,cx,yb-h*0.5); ctx.quadraticCurveTo(cx+w*0.1,yb+h*0.1,cx+w*0.22,yb-h*0.7); }
  else if(kind==="ring"){ ctx.arc(cx, yb-h*0.55, h*0.5, 0, 7); }
  ctx.stroke(); ctx.restore();
}
function fitText(text, font, maxW, size, min){
  const t=mwSplit(text).base;
  let s=size; while(s>min){ ctx.font=`${s}px ${font}`; if(ctx.measureText(t).width<=maxW) break; s-=4; } return s;
}
function fmtDate(v){ if(!v) return ""; const [y,m,d]=v.split("-").map(Number); return `${d}/${m}/${y}`; }
const kmText = r => (r.total/1000).toFixed(1);

/* Title, distance and FREE BEER! can each be moved (one finger), and turned and resized (two fingers).
   Offsets are per format; "Put text back in place" clears them. */
const ITEM0={dx:0, dy:0, scale:1, rot:0};
function itemOf(k){ return {...ITEM0, ...((S.items[S.fmt]||{})[k]||{})}; }
function setItem(k, patch){
  const F=FORMATS[S.fmt], cur=itemOf(k), it={...cur, ...patch}, h=(S.hits||{})[k];
  if(h){ const bx=h.cx-cur.dx, by=h.cy-cur.dy;   // keep the centre on the image
    it.dx=Math.max(30-bx, Math.min(F.w-30-bx, it.dx)); it.dy=Math.max(30-by, Math.min(F.h-30-by, it.dy)); }
  it.scale=Math.max(.3, Math.min(4, it.scale));
  it.rot=((it.rot+180)%360+360)%360-180;
  (S.items[S.fmt] ||= {})[k]=it; scheduleDraw();
}
/* Keep the invisible date field over the date on the post (none on "Transparent"). */
function placeDateField(){
  const el=$("date"), b=S.dateBox, show=S.fmt!=="route" && b;
  el.style.display = show ? "" : "none"; if(!show) return;
  el.style.left=(b.x/b.W*100)+"%"; el.style.top=(b.y/b.H*100)+"%";
  el.style.width=(b.w/b.W*100)+"%"; el.style.height=(b.h/b.H*100)+"%";
}
/* Keep the invisible title field over the title on the post (or where the title goes when it's empty). */
function placeTitleField(F){
  const el=$("title"), show=S.fmt!=="route"; el.style.display = show ? "" : "none"; if(!show) return;
  const h=(S.hits||{}).title, W=cv.width, H=cv.height;
  if(S.editTitle && h){
    // typing: the field shows the title itself, same font, size, place and angle, with a cursor you can move
    const k=cv.getBoundingClientRect().width/W, bw=W*0.9;
    el.style.left=((h.cx-bw/2)/W*100)+"%"; el.style.width=(bw/W*100)+"%";
    el.style.top=((h.cy-h.h*h.scale*0.6)/H*100)+"%"; el.style.height=(h.h*h.scale*1.2/H*100)+"%";
    el.style.fontSize=(S.titleSize*h.scale*k)+"px"; el.style.transform=`rotate(${h.rot}deg)`;
    return; }
  el.style.fontSize=""; el.style.transform="";
  const b = h ? {x:h.cx-h.w*h.scale/2, y:h.cy-h.h*h.scale/2, w:h.w*h.scale, h:h.h*h.scale} : {x:W*0.1, y:F.title, w:W*0.8, h:140};
  el.style.left=(b.x/W*100)+"%"; el.style.top=(b.y/H*100)+"%"; el.style.width=(b.w/W*100)+"%"; el.style.height=(b.h/H*100)+"%";
}
/* Distance (canvas pixels) from a point to a drawn route line */
function distToLine(p, px){ let best=Infinity;
  for(let i=1;i<px.length;i++){ const ax=px[i-1].x, ay=px[i-1].y, bx=px[i].x, by=px[i].y, dx=bx-ax, dy=by-ay, L=dx*dx+dy*dy;
    const t=L?Math.max(0,Math.min(1,((p.x-ax)*dx+(p.y-ay)*dy)/L)):0; best=Math.min(best, Math.hypot(p.x-ax-t*dx, p.y-ay-t*dy)); }
  return best; }
function textMoved(){ return !!S.items[S.fmt]; }
/* anything moved from where the app first put it: text in this format, or the map zoomed / dragged */
function viewMoved(){ return textMoved() || Math.abs(S.zoom-1)>0.005 || Math.hypot(S.pan.x,S.pan.y)>1e-9; }
/* Draw one item around its centre (cx,cy) with its offset, angle and size; remember where it is for touches. */
function drawItem(k, cx, cy, w, h, paint){
  const it=itemOf(k), X=cx+it.dx, Y=cy+it.dy;
  ctx.save(); ctx.translate(X,Y); ctx.rotate(it.rot*Math.PI/180); ctx.scale(it.scale,it.scale); paint();
  if(S.sel===k){ // dashed outline on the text you're handling (preview only, never in the exported image)
    const p=18/it.scale; ctx.lineWidth=3/it.scale; ctx.setLineDash([14/it.scale,10/it.scale]); ctx.strokeStyle="#3584ba";
    ctx.strokeRect(-w/2-p, -h/2-p, w+2*p, h+2*p); }
  ctx.restore();
  S.hits[k]={cx:X, cy:Y, w, h, rot:it.rot, scale:it.scale};
}

function drawText(F, W, H){
  ctx.save(); ctx.fillStyle=TEXT; ctx.textAlign="center"; ctx.textBaseline="top";
  const title=($("title").value||"").toUpperCase().trim();
  S.hits={};
  let y=F.title;
  if(title || S.editTitle){ const s=fitText(title||"T",'"MikkelWind"',W*0.86,160,60);
    ctx.font=`${s}px "MikkelWind"`; const tw=Math.max(ctx.measureText(mwSplit(title).base).width, 40);
    S.titleSize=s;
    drawItem("title", W/2, y+s/2, tw, s, ()=>{ if(!S.editTitle) drawMW(title, 0, -s/2, s); }); y+=s*1.02; }
  const dy=title?y+8:F.dist;
  // distance(s): one route in black, two routes each in their route colour
  ctx.font=`100px "MikkelWind"`;
  if(S.routes.length===1){ const t=`${kmText(S.routes[0])} KM`; const w=ctx.measureText(t).width;
    drawItem("dist", W/2, dy+50, w, 100, ()=>drawMW(t, 0, -50, 100)); }
  else if(S.routes.length===2){
    const parts=[[`${kmText(S.routes[0])} KM`,routeColor(0)],["  /  ",TEXT],[`${kmText(S.routes[1])} KM`,routeColor(1)]];
    let size=100, total; do{ ctx.font=`${size}px "MikkelWind"`; total=parts.reduce((t,[s])=>t+ctx.measureText(s).width,0); size-=6; }while(total>W*0.9 && size>50);
    size+=6; ctx.font=`${size}px "MikkelWind"`;
    drawItem("dist", W/2, dy+size/2, total, size, ()=>{ let x=-total/2; ctx.textAlign="left";
      for(const [s,c] of parts){ ctx.fillStyle=c; ctx.fillText(s,x,-size/2); x+=ctx.measureText(s).width; } });
    ctx.textAlign="center"; ctx.fillStyle=TEXT;
  }
  // FREE BEER! — always there
  ctx.font=`68px "MikkelWind"`;
  const bw=ctx.measureText("FREE BEER!").width, bh=76;
  drawItem("beer", W/2, F.h*F.beer+bh/2, bw, bh, ()=>{ ctx.textBaseline="middle"; ctx.fillText("FREE BEER!", 0, 0); });
  const date=fmtDate($("date").value);
  ctx.textAlign="right"; ctx.textBaseline="bottom"; ctx.font=`58px "MikkelWind"`;
  if(date) ctx.fillText(date, W-40, H-F.dateY);   // digits and slashes are all in the font
  // where the date is, so the invisible date field can sit on top of it (also when it's empty)
  const dw=ctx.measureText(date||"11.11.2026").width, pad=24;
  S.dateBox={x:W-40-dw-pad, y:H-F.dateY-58-pad, w:dw+2*pad, h:58+2*pad, W, H};
  ctx.restore();
}

/* ---------- render ---------- */
let raf=0;
function scheduleDraw(){ if(!raf) raf=requestAnimationFrame(()=>{raf=0; draw();}); }
function prepareRoute(){
  if(!S.routes.length) return;
  const mpu=metresPerUnit(S.routes[0].pts[0].lat);
  S.rpts=S.routes.map(r=>douglasPeucker(trimPoints(r.pts,r.cum,S.trimS,S.trimE).map(merc), S.simplify/mpu));
  S.mpts=S.routes.flatMap(r=>trimPoints(r.pts,r.cum,S.trimS,S.trimE).map(merc));   // everything that must fit in the frame
}
function draw(){
  if(!S.mpts) return;
  const F=S.fmt==="route" ? routeOnlyFormat() : FORMATS[S.fmt]; const W=F.w, H=F.h;
  if(cv.width!==W||cv.height!==H){cv.width=W;cv.height=H;}
  const V=computeView(F,W,H); S.view=V;
  let mapOk=true;
  if(S.fmt==="route"){ ctx.clearRect(0,0,W,H); S.hits={}; }
  else mapOk=drawMap(V,W,H);
  const lines=S.rpts.map(r=>{ let px=r.map(V.toPx); if(S.round) px=chaikin(px,3); return px; });
  if(lines.length===2){
    // two routes: side by side where they share streets (the longer one keeps its line, the shorter goes inside)
    const long=S.routes[0].total>=S.routes[1].total?0:1, short=1-long;
    const tol=Math.max(S.width*1.3, 15*V.scale/metresPerUnit(S.routes[0].pts[0].lat));
    const [a,b]=sideBySide(lines[long], lines[short], S.width, tol);
    strokeRoute(a, S.width, routeColor(long)); strokeRoute(b, S.width, routeColor(short)); S.drawn=[a,b];
  } else { lines.forEach((px,i)=>strokeRoute(px, S.width, routeColor(i))); S.drawn=lines; }
  if(S.fmt!=="route") drawText(F,W,H);
  if(S.guides && S.fmt!=="route"){ // centre guide lines while text sticks to them (preview only)
    ctx.save(); ctx.strokeStyle="#3584ba"; ctx.lineWidth=3; ctx.setLineDash([16,12]);
    if(S.guides.v){ ctx.beginPath(); ctx.moveTo(W/2,0); ctx.lineTo(W/2,H); ctx.stroke(); }
    if(S.guides.h){ ctx.beginPath(); ctx.moveTo(0,H/2); ctx.lineTo(W,H/2); ctx.stroke(); }
    ctx.restore(); }
  $("beerreset").classList.toggle("hidden", !viewMoved() || S.fmt==="route");
  $("posthint").classList.toggle("hidden", S.fmt==="route");   // nothing to drag, pinch or tap on Transparent
  placeDateField(); placeTitleField(F);
  const st=$("status");
  if(S.fmt!=="route" && M.error && !M.ready){ st.textContent="Map couldn’t load. Check your connection and reload."; st.classList.add("warn"); }
  else if(S.fmt!=="route" && !mapOk){ st.textContent="Loading map…"; st.classList.remove("warn"); }
  else { st.textContent = ""; st.classList.remove("warn"); }
  cv.style.background = S.fmt==="route" ? "repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 0 0/24px 24px" : "#eef0f0";
}

/* ---------- export ---------- */
function nextWednesday(){
  const d=new Date(); const add=(3-d.getDay()+7)%7; d.setDate(d.getDate()+add); return localISO(d);
}
function exportBlob(){ return mapSettled().then(()=>new Promise(res=>{ S.sel=null; S.guides=null; draw(); cv.toBlob(b=>res(b),"image/png"); })); }
function fileName(){
  const t=($("title").value||"route").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"route";
  return `mrc-${t}-${S.fmt}.png`;
}
async function download(){
  const b=await exportBlob(); if(!b) return alert("Couldn’t create the image. Check your connection, reload and try again.");
  const a=document.createElement("a"); a.href=URL.createObjectURL(b); a.download=fileName(); document.body.appendChild(a); a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href); a.remove();},2000);
}
async function share(){
  const b=await exportBlob(); if(!b) return download();
  const f=new File([b], fileName(), {type:"image/png"});
  if(navigator.canShare && navigator.canShare({files:[f]})){
    try{ await navigator.share({files:[f]}); }catch(e){ if(e.name!=="AbortError") download(); }
  } else download();
}

/* ---------- GPX files ---------- */
/* "261014_MRC_LITTLE-DIPPER" -> "LITTLE DIPPER" */
function cleanTitle(n){
  return n.replace(/\.gpx$/i,"").replace(/[_\-]+/g," ").replace(/^[\d\s.]+/,"")
          .replace(/\b(MRC|MIKKELLER( RUN(NING)? CLUB)?)\b/ig,"").replace(/\s+/g," ").trim().toUpperCase();
}
/* Metres climbed; rises under 3 m are GPS noise. null without elevation data. Same rule as climbOf() in src/worker.js. */
function climb(pts){
  const ele=pts.map(p=>p.ele).filter(Number.isFinite); if(ele.length<2) return null;
  let up=0, ref=ele[0];
  for(const e of ele){ if(e>ref+3){ up+=e-ref; ref=e; } else if(e<ref-3) ref=e; }
  return Math.round(up);
}
const routeInfo = r => `${kmText(r)} km`+(r.up!=null?` · ↑ ${r.up} m`:"")+(r.lights!=null?` · 🚦 ${r.lights}`:"");
const latlon = r => r.pts.map(p=>[p.lat,p.lon]);
function renderStats(){
  const two=S.routes.length>1, sep='<span class="sep"> · </span>';
  const lights=r=> r.lights!=null ? `${sep}🚦 ${r.lights}` : SIG.error ? `${sep}<button type="button" class="retry" data-sigretry title="${esc(SIG.error)}">🚦 Try again</button>` : `${sep}🚦 …`;
  const line=r=>`${kmText(r)} km`+(r.up!=null?`${sep}↑ ${r.up} m`:"")+lights(r);
  $("routecard").classList.toggle("two", two);
  $("distinfo").innerHTML=S.routes.map((r,i)=>`<div class="lg"><i style="background:${routeColor(i)}" aria-hidden="true"></i>`+
    line(r)+
    `<button type="button" class="rmx" data-rmroute="${i}" aria-label="${two?`Remove ${i?"second":"main"} route`:"Remove the route and start over"}">✕</button></div>`).join("");
}
/* Route post: count the lights once the list is on the phone (first time: a few seconds). */
function lightsForPost(){
  if(!S.routes.length) return;
  loadSignals().then(ok=>{ if(!ok) return renderStats(); let changed=false;
    for(const r of S.routes) if(r.lights==null){ r.lights=countLights(latlon(r)); changed=true; }
    if(changed) renderStats(); });
}
function routeFromText(text, fallbackName){
  const g=parseGPX(text);
  const cum=cumulative(g.pts);
  return {name:g.name||fallbackName||"", pts:g.pts, cum, total:cum[cum.length-1], up:climb(g.pts), gpx:text};
}
async function readRoute(file){ return routeFromText(await file.text(), file.name.replace(/\.gpx$/i,"")); }
function routesChanged(){
  renderStats(); lightsForPost(); fillSecondSelect();
  const two=S.routes.length===2;
  $("route2none").classList.toggle("hidden", two);
  S.pan={x:0,y:0};
  prepareRoute(); scheduleDraw();
}
async function loadFile(file){ return loadRoute(()=>readRoute(file)); }
/* Pasted GPX text (e.g. copied from gpx.studio or a mail). Trims anything around <gpx …>…</gpx>. */
function loadPasted(text){
  const m=/<\?xml[\s\S]*?<\/gpx>|<gpx[\s>][\s\S]*<\/gpx>/i.exec(text||"");
  if(!m) return false;
  loadRoute(()=>routeFromText(m[0].trim(), ""));
  return true;
}
/* A copied file (Files app, Finder, Explorer) or copied GPX text. Returns true if it loaded something. */
async function loadFromClipboardData(dt){
  if(!dt) return false;
  const files=[...(dt.files||[])].concat([...(dt.items||[])].filter(i=>i.kind==="file").map(i=>i.getAsFile()).filter(Boolean));
  for(const f of files){ const t=await f.text().catch(()=>""); if(/<gpx[\s>]/i.test(t)){ loadRoute(()=>routeFromText(t, f.name.replace(/\.gpx$/i,""))); return true; } }
  return loadPasted(dt.getData && dt.getData("text"));
}
async function pasteGpx(){
  const area=$("pastearea"), st=$("pastestatus");
  try{ // Paste button reads the clipboard directly where the browser allows it
    for(const item of await navigator.clipboard.read()){
      for(const type of item.types){ const t=await (await item.getType(type)).text().catch(()=>"");
        if(/<gpx[\s>]/i.test(t) && loadPasted(t)) return; }
    }
    st.textContent="What you copied isn’t a GPX file.";
  }catch(e){}
  area.classList.remove("hidden"); $("pastetext").focus();
}
/* Back to the empty Route post, as if the app had just been opened. */
function startOver(){
  S.routes=[]; S.mpts=null; S.rpts=null; S.view=null; S.items={}; S.pan={x:0,y:0}; S.zoom=1;
  Object.assign(S, ADV_DEFAULTS);
  $("title").value=""; $("distinfo").innerHTML="";
  $("route2none").classList.remove("hidden"); $("routecard").classList.remove("two");
  $("libstatus").textContent=""; $("libdup").classList.add("hidden");
  $("pastetext").value=""; $("pastestatus").textContent=""; $("pastearea").classList.add("hidden");
  $("editor").classList.add("hidden"); $("actions").classList.add("hidden");
  $("drop").classList.remove("hidden"); $("pastebox").classList.remove("hidden");
  ctx.clearRect(0,0,cv.width,cv.height);
  window.scrollTo({top:0, behavior:"smooth"});
}
async function loadRoute(read){
  try{
    const r=await read();
    $("libstatus").textContent=""; $("libdup").classList.add("hidden");
    S.routes=[r]; S.zoom=1; S.items={};
    $("title").value=cleanTitle(r.name);
    fillFromSchedule(true);
    if(!$("date").value) $("date").value=nextWednesday();
    $("editor").classList.remove("hidden"); $("actions").classList.remove("hidden"); $("drop").classList.add("hidden"); $("pastebox").classList.add("hidden"); $("pastearea").classList.add("hidden"); $("pastetext").value=""; $("pastestatus").textContent="";
    routesChanged();
    await document.fonts.load('100px "MikkelWind"'); draw();
    cv.scrollIntoView({behavior:"smooth", block:"start"});
  }catch(e){ alert(e.message||String(e)); }
}
/* Add a second route: a dropdown of the saved routes (or upload a GPX). */
/* Add a second route: one sheet with the saved routes (with distance filters) and a GPX file from the phone. */
const SEC={filter:"all"};
function fillSecondSelect(){ if($("sheet2") && $("sheet2").open) renderPickList(); }
function renderPickList(){
  const box=$("picklist"); if(!box) return;
  $("pickfilter").querySelectorAll("button").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.v===SEC.filter)));
  if(!LIB.routes){ box.innerHTML=`<p class="picknone">Loading saved routes…</p>`; return; }
  const main=S.routes[0], mainC=main && {name:"", km:main.total/1000, pts:thin(main.pts)};
  const km=r=>Number(r.km.toFixed(1)), inRange={all:()=>true, short:r=>km(r)<=5, mid:r=>km(r)>5&&km(r)<=7, long:r=>km(r)>7};
  const rs=LIB.routes.filter(inRange[SEC.filter]||inRange.all);
  $("pickfilter").classList.toggle("hidden", LIB.routes.length<6);
  box.innerHTML = !LIB.routes.length ? `<p class="picknone">No saved routes yet.</p>` : !rs.length ? `<p class="picknone">No saved routes in this range.</p>` :
    rs.map(r=>{ const same=!!mainC && sameRoute(mainC, r);
      return `<button type="button" class="pick" data-pick="${r.id}" ${same?"disabled":""}><div class="thumb" data-thumb="${r.id}">${routeSVG(r.pts)}</div>
        <span><b>${esc(r.name)}</b><small>${r.km.toFixed(1)} km${r.lights!=null?` · 🚦 ${r.lights}`:""}${same?" · this post":""}</small></span></button>`; }).join("");
  queueThumbs(rs);
}
function openSecondSheet(){
  const d=$("sheet2"); if(!LIB.routes) loadRoutes();
  d.classList.remove("full"); $("picklist").scrollTop=0;      // opens at half height, pull up for the full list
  renderPickList(); if(d.showModal) d.showModal(); else d.setAttribute("open","");
}
/* Half sheet: drag the handle up for the full list, down to shrink or close; scrolling the list also opens it fully. */
function initSheetDrag(){
  const d=$("sheet2"), g=$("sheet2grab"); let y0=null, h0=0, moved=false;
  g.addEventListener("pointerdown",e=>{ if(e.target.closest("button")) return; y0=e.clientY; h0=d.getBoundingClientRect().height; moved=false;
    d.classList.add("dragging"); try{ g.setPointerCapture(e.pointerId); }catch(err){} });
  g.addEventListener("pointermove",e=>{ if(y0==null) return; const dy=e.clientY-y0; if(Math.abs(dy)>4) moved=true;
    d.style.height=Math.max(120, Math.min(innerHeight*0.9, h0-dy))+"px"; });
  const end=e=>{ if(y0==null) return; const dy=e.clientY-y0, wasFull=d.classList.contains("full"); y0=null;
    d.classList.remove("dragging"); d.style.height="";
    if(!moved) return d.classList.toggle("full");            // a tap on the handle switches half ⇄ full
    if(dy<-40) d.classList.add("full");
    else if(dy>60){ if(wasFull && dy<h0*0.6) d.classList.remove("full"); else closeSecondSheet(); } };
  g.addEventListener("pointerup",end); g.addEventListener("pointercancel",end);
  $("picklist").addEventListener("scroll",()=>{ if($("picklist").scrollTop>8) d.classList.add("full"); },{passive:true});
}
function closeSecondSheet(){ const d=$("sheet2"); if(d.close) d.close(); else d.removeAttribute("open"); }
async function addSecondFromLibrary(id){
  const r=(LIB.routes||[]).find(x=>x.id===id); if(!r) return;
  closeSecondSheet();
  try{ const res=await fetch(`/api/routes/gpx?id=${id}`,{credentials:"include"}); if(!res.ok) throw new Error("Couldn’t load that route.");
    await loadSecond(new File([await res.blob()], `${r.name}.gpx`, {type:"application/gpx+xml"})); }
  catch(e){ alert(e.message||String(e)); }
}
async function loadSecond(file){
  try{ const r=await readRoute(file); S.routes=[S.routes[0], r]; routesChanged(); }
  catch(e){ alert(e.message||String(e)); }
}

/* ---------- route library (Routes tab) ---------- */
const LIB={routes:null, canEdit:false};
/* At most n evenly spaced points, as [[lat, lon], …] rounded to ~1 m: for pictures and for spotting the same route. */
function thin(pts, n=300){ const step=Math.max(1, (pts.length-1)/(n-1)), out=[];
  for(let i=0;i<pts.length-0.5;i+=step) out.push(pts[Math.round(i)]);
  if(out[out.length-1]!==pts[pts.length-1]) out.push(pts[pts.length-1]);
  return out.slice(0,n).map(p=>[+p.lat.toFixed(5), +p.lon.toFixed(5)]); }
/* Very large GPX files (some watches record every second for hours) are rewritten from their points. */
function gpxFor(r, title){
  if(r.gpx && r.gpx.length < 1500000) return r.gpx;
  const pts=r.pts.length>8000 ? thin(r.pts,8000).map(([lat,lon])=>({lat,lon})) : r.pts;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="MRC ZH" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${esc(title)}</name><trkseg>\n`+
    pts.map(p=>`<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"/>`).join("\n")+`\n</trkseg></trk></gpx>\n`;
}
/* Same route? Similar distance and every part of each line close to the other (≈ within 60 m on average both ways),
   or the same name with a similar distance. */
function sameRoute(a, b){
  const close = Math.abs(a.km-b.km) <= Math.max(0.3, 0.06*Math.max(a.km,b.km));
  if(!close) return false;
  if(a.name && b.name && a.name.toUpperCase()===b.name.toUpperCase()) return true;
  const k=Math.cos(a.pts[0][0]*Math.PI/180)*111320, m=111320;
  const d=(p,q)=>Math.hypot((p[0]-q[0])*m, (p[1]-q[1])*k);
  const mean=(P,Q)=>{ const sample=P.filter((_,i)=>i%Math.max(1,Math.floor(P.length/60))===0);
    return sample.reduce((t,p)=>t+Math.min(...Q.map(q=>d(p,q))),0)/sample.length; };
  return mean(a.pts,b.pts) < 60 && mean(b.pts,a.pts) < 60;
}
/* One or more lines in one picture, on shared bounds (so overlaid routes line up). */
function routesSVG(lines){
  const k=Math.cos(lines[0][0][0][0]*Math.PI/180), all=lines.map(([pts,c])=>[pts.map(([la,lo])=>[lo*k,-la]),c]);
  const xs=all.flatMap(([xy])=>xy.map(p=>p[0])), ys=all.flatMap(([xy])=>xy.map(p=>p[1])), x0=Math.min(...xs), y0=Math.min(...ys);
  const span=Math.max(Math.max(...xs)-x0, Math.max(...ys)-y0) || 1, sc=84/span;
  const ox=(100-(Math.max(...xs)-x0)*sc)/2, oy=(100-(Math.max(...ys)-y0)*sc)/2;
  // overlaid: the first line wide underneath, the second thin on top, so both show where they share streets
  const paths=all.map(([xy,c],j)=>`<path d="${xy.map(([x,y],i)=>`${i?"L":"M"}${(ox+(x-x0)*sc).toFixed(1)} ${(oy+(y-y0)*sc).toFixed(1)}`).join("")}" fill="none" stroke="${c}" stroke-width="${lines.length>1?(j?2:6):3}" stroke-linejoin="round" stroke-linecap="round"/>`).join("");
  return `<svg viewBox="0 0 100 100" aria-hidden="true">${paths}</svg>`;
}
const routeSVG=(pts, color="#882c29")=>routesSVG([[pts,color]]);

/* Map behind each route picture in Routes: a small separate map, one route at a time, framed exactly like
   routesSVG() (same centre, line fills 84 % of the square). Pictures are kept on this phone so it's done once per route. */
const TH={map:null, ready:null, mode:null, queue:[], busy:false, mem:new Map(), size:288};
const thumbKey=r=>`mrc-thumb-v4-${darkUI()?"night-":""}${r.id}-${r.km.toFixed(3)}-${r.pts.length}`;
function thumbFrame(pts){
  const k=Math.cos(pts[0][0]*Math.PI/180), xs=pts.map(p=>p[1]*k), ys=pts.map(p=>-p[0]);
  const x0=Math.min(...xs), x1=Math.max(...xs), y0=Math.min(...ys), y1=Math.max(...ys);
  const span=Math.max(x1-x0, y1-y0) || 0.001, lat=-(y0+y1)/2;
  const mpp=span*111320/(0.84*TH.size);                       // metres per pixel so the line fills 84 %
  return {center:[(x0+x1)/2/k, lat], zoom:Math.log2(78271.517*Math.cos(lat*Math.PI/180)/mpp)};
}
function thumbMap(){
  const mode=darkUI()?"night":POST_MAP;
  if(TH.ready && TH.mode===mode) return TH.ready;
  if(TH.map){ try{ TH.map.remove(); }catch(e){} TH.map=null; }
  TH.mode=mode;
  TH.ready=new Promise(res=>{
    if(typeof maplibregl==="undefined") return res(null);
    TH.map=new maplibregl.Map({container:"thumbbox", style:mapStyle(mode), interactive:false, attributionControl:false,
      pixelRatio:1, preserveDrawingBuffer:true, fadeDuration:0, center:[8.53,47.37], zoom:13});
    TH.map.on("load",()=>res(TH.map)); TH.map.on("error",()=>{}); setTimeout(()=>res(TH.map.loaded()?TH.map:null),15000);
  });
  return TH.ready;
}
function showThumb(id, url){ document.querySelectorAll(`[data-thumb="${id}"]`).forEach(el=>el.style.backgroundImage=`url(${url})`); }
async function renderThumbs(){
  if(TH.busy) return; TH.busy=true;
  try{
    while(TH.queue.length){
      const r=TH.queue.shift(), key=thumbKey(r);
      const map=await thumbMap(); if(!map) break;
      const f=thumbFrame(r.pts); map.jumpTo(f);
      await new Promise(res=>{ const t0=Date.now(); (function wait(){ if((map.loaded()&&map.areTilesLoaded())||Date.now()-t0>8000) return res(); setTimeout(wait,150); })(); });
      map.triggerRepaint(); await new Promise(res=>map.once("render",res));
      let url; try{ url=map.getCanvas().toDataURL("image/jpeg",0.8); }catch(e){ break; }
      TH.mem.set(key,url); if(!String(r.id).startsWith("s")) try{ localStorage.setItem(key,url); }catch(e){}
      showThumb(r.id, url);
    }
  } finally { TH.busy=false; }
}
/* ---------- traffic lights (OpenStreetMap) ----------
   Every traffic light and signalled crossing around Zurich, kept on the phone for a week.
   A route "has" a light when it passes within 15 m; lights within 40 m of each other
   (one junction) count once. */
const SIG={pts:null, grid:null, loading:null};
const SIG_KEY="mrc-signals-v1", CELL=0.001;
function indexSignals(text){
  const pts=text.trim().split(/\n/).map(l=>l.split(/[\t,]/).map(Number)).filter(p=>p.length>=2&&Number.isFinite(p[0])&&Number.isFinite(p[1]));
  const grid=new Map();
  for(const p of pts){ const k=Math.floor(p[0]/CELL)+":"+Math.floor(p[1]/CELL); (grid.get(k)||grid.set(k,[]).get(k)).push(p); }
  SIG.pts=pts; SIG.grid=grid;
}
function loadSignals(){
  if(SIG.pts) return Promise.resolve(true);
  if(SIG.loading) return SIG.loading;
  SIG.loading=(async()=>{
    try{ const c=JSON.parse(localStorage.getItem(SIG_KEY)||"null"); if(c && Date.now()-c.t<7*864e5){ indexSignals(c.text); return true; } }catch(e){}
    try{ const r=await fetch("/api/map/signals",{credentials:"include", cache:"no-store"});
      if(!r.ok){ const j=await r.json().catch(()=>({})); throw new Error(j.error||`Couldn’t load the traffic lights (${r.status}).`); }
      const text=await r.text(); indexSignals(text); SIG.error="";
      try{ localStorage.setItem(SIG_KEY, JSON.stringify({t:Date.now(), text})); }catch(e){}
      return true; }catch(e){ SIG.loading=null; SIG.error=e.message||String(e); return false; }
  })();
  return SIG.loading;
}
/* pts: [[lat, lon], …] → number of traffic lights on the way */
function countLights(pts){
  if(!SIG.grid || !pts || pts.length<2) return null;
  const k=Math.cos(pts[0][0]*Math.PI/180)*111320, m=111320, R=15, hits=[];
  const seen=new Set();
  for(let i=1;i<pts.length;i++){
    const [a0,b0]=pts[i-1], [a1,b1]=pts[i];
    const la0=Math.floor((Math.min(a0,a1)-0.0002)/CELL), la1=Math.floor((Math.max(a0,a1)+0.0002)/CELL);
    const lo0=Math.floor((Math.min(b0,b1)-0.0003)/CELL), lo1=Math.floor((Math.max(b0,b1)+0.0003)/CELL);
    for(let x=la0;x<=la1;x++) for(let y=lo0;y<=lo1;y++){ const cell=SIG.grid.get(x+":"+y); if(!cell) continue;
      for(const s of cell){ if(seen.has(s)) continue;
        const ax=(b0-s[1])*k, ay=(a0-s[0])*m, bx=(b1-s[1])*k, by=(a1-s[0])*m, dx=bx-ax, dy=by-ay;
        const t=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/((dx*dx+dy*dy)||1)));
        if(Math.hypot(ax+t*dx, ay+t*dy)<=R){ seen.add(s); hits.push(s); } } }
  }
  const groups=[];
  for(const s of hits){ const g=groups.find(g=>Math.hypot((g[1]-s[1])*k,(g[0]-s[0])*m)<40); if(!g) groups.push(s); }
  return groups.length;
}
function lightsText(r){ if(r.lights==null && SIG.pts) r.lights=countLights(r.pts); return r.lights==null?"":` · 🚦 ${r.lights}`; }
/* Saved routes keep their count in the library; only routes without one are counted, once, and saved back. */
async function fillMissingLights(){
  const missing=(LIB.routes||[]).filter(r=>r.lights==null); if(!missing.length) return;
  if(!(await loadSignals())){ fillLights(); return; }
  const items=missing.map(r=>({id:r.id, lights:(r.lights=countLights(r.pts))})).filter(i=>i.lights!=null);
  fillLights();
  if(items.length) fetch("/api/routes/lights",{method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({items}), credentials:"include"}).catch(()=>{});
}
function fillLights(){ const st=$("routesstatus");
  if(SIG.error){ st.textContent="🚦 "+SIG.error+" Open Routes again to retry."; st.classList.add("warn"); }
  else if(/^🚦/.test(st.textContent)){ st.textContent=""; st.classList.remove("warn"); }
  document.querySelectorAll("[data-lights]").forEach(el=>{
  const id=el.dataset.lights, r=(LIB.routes||[]).concat(SUG.list||[]).find(x=>String(x.id)===id); if(r) el.textContent=lightsText(r); }); }

/* ---------- Suggest a loop (BRouter via /api/map/route) ----------
   Six directions from the start; each loop goes start → two points either side of the direction → start.
   Out-and-back spurs are cut afterwards, and smoother loops (fewer turns) win ties.
   BRouter's running profile (src/mrc-run.brf) keeps to paths and quiet streets and avoids traffic lights.
   If a loop comes out too long or short it is scaled once and planned again. Best ones first: fewest lights. */
const SUG={km:5, list:null, run:0};
const BAR=[47.3727, 8.5199];   // Mikkeller Zürich, Zweierstrasse 124
function startPoint(){
  const s=(LIB.routes||[]).map(r=>r.pts[0]).filter(Boolean);
  if(s.length<2) return BAR;
  // the start most routes share (they begin at the bar)
  let best=s[0], n=0;
  for(const p of s){ const c=s.filter(q=>Math.hypot((q[0]-p[0])*111320,(q[1]-p[1])*75000)<150).length; if(c>n){ n=c; best=p; } }
  return n>=2 ? best : BAR;
}
const dest=(p,dist,brg)=>{ const b=brg*Math.PI/180; return [p[0]+dist*Math.cos(b)/111320, p[1]+dist*Math.sin(b)/(111320*Math.cos(p[0]*Math.PI/180))]; };
const COMPASS=["NORTH","NORTH-EAST","EAST","SOUTH-EAST","SOUTH","SOUTH-WEST","WEST","NORTH-WEST"];
/* metres between two [lon, lat, …] points */
const gd=(a,b)=>Math.hypot((a[1]-b[1])*111320,(a[0]-b[0])*111320*Math.cos(a[1]*Math.PI/180));
/* Cut out-and-back stretches, whatever their length: where the line comes back to (within 20 m of) a point it
   already passed, and the piece in between is just "there and back" (it encloses almost no area: thinner than
   30 m on average), that piece goes. A detour that loops around something (a block, a park) encloses area and stays. */
function despur(co){
  const n=co.length, cum=[0]; for(let k=1;k<n;k++) cum[k]=cum[k-1]+gd(co[k-1],co[k]);
  const thin=(i,j)=>{   // average width of the piece i..j, from its enclosed area (shoelace, in metres)
    const lat0=co[i][1], k=111320*Math.cos(lat0*Math.PI/180); let a=0;
    for(let t=i;t<j;t++){ const x1=(co[t][0]-co[i][0])*k, y1=(co[t][1]-lat0)*111320, x2=(co[t+1][0]-co[i][0])*k, y2=(co[t+1][1]-lat0)*111320; a+=x1*y2-x2*y1; }
    return Math.abs(a)/2/((cum[j]-cum[i])/2||1) < 30;
  };
  const out=[]; let i=0;
  while(i<n){
    out.push(co[i]); let cut=-1;
    for(let j=n-2;j>i+2;j--){                                      // farthest return first: cut the whole there-and-back
      if(cum[j]-cum[i]<50 || cum[j]-cum[i]>cum[n-1]*0.5 || gd(co[i],co[j])>=20) continue;   // more than half the loop: not a detour
      let far=0; for(let t=i+1;t<j;t++) far=Math.max(far,gd(co[i],co[t]));
      if(far>=25 && thin(i,j)){ cut=j; break; }
    }
    i = cut>0 ? cut+1 : i+1;
  }
  return out;
}
/* Turns sharper than 50°, looking at the line every 25 m (ignores GPS-size wiggles) */
function turnsOf(co){
  const pts=[co[0]]; let acc=0;
  for(let k=1;k<co.length;k++){ acc+=gd(co[k-1],co[k]); if(acc>=25){ pts.push(co[k]); acc=0; } }
  const brg=(a,b)=>Math.atan2((b[0]-a[0])*Math.cos(a[1]*Math.PI/180),b[1]-a[1])*180/Math.PI;
  let n=0; for(let k=2;k<pts.length;k++){ let d=Math.abs(brg(pts[k-1],pts[k])-brg(pts[k-2],pts[k-1])); if(d>180) d=360-d; if(d>50) n++; }
  return n;
}
async function planLoop(start, brg, d){
  // two points either side of the direction: fewer forced detours than three
  const wps=[start, dest(start,d,brg-35), dest(start,d,brg+35), start];
  const lonlats=wps.map(p=>`${p[1].toFixed(6)},${p[0].toFixed(6)}`).join("|");
  const r=await fetch(`/api/map/route?lonlats=${encodeURIComponent(lonlats).replace(/%2C/g,",")}`,{credentials:"include"});
  const j=await r.json().catch(()=>({}));
  if(!r.ok || !j.features) throw new Error(j.error||"No route.");
  const co=despur(j.features[0].geometry.coordinates);
  const m=co.reduce((t,c,i)=>i?t+gd(co[i-1],c):0,0);
  // the whole loop must go round something: average width (area ÷ half its length) of at least 60 m
  const lat0=co[0][1], k=111320*Math.cos(lat0*Math.PI/180); let area=0;
  for(let t=0;t<co.length-1;t++){ const x1=(co[t][0]-co[0][0])*k, y1=(co[t][1]-lat0)*111320, x2=(co[t+1][0]-co[0][0])*k, y2=(co[t+1][1]-lat0)*111320; area+=x1*y2-x2*y1; }
  if(Math.abs(area)/2/(m/2||1) < 60) throw new Error("Out and back, not a loop.");
  return {co, m, brg, turns:turnsOf(co)};
}
function loopToRoute(l, km, i){
  const name=`${COMPASS[Math.round(((l.brg%360)+360)%360/45)%8]} LOOP`;
  const gpx=`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="MRC ZH (BRouter, OpenStreetMap)" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${esc(name)}</name><trkseg>\n`+
    l.co.map(c=>`<trkpt lat="${c[1].toFixed(6)}" lon="${c[0].toFixed(6)}">${c.length>2?`<ele>${Number(c[2]).toFixed(1)}</ele>`:""}</trkpt>`).join("\n")+`\n</trkseg></trk></gpx>\n`;
  const full=routeFromText(gpx, name);
  return {id:`s${Date.now()}${i}`, name, km:full.total/1000, up:full.up, pts:thin(full.pts), full, gpx, turns:l.turns};
}
const SKEL=`<div class="skel"><i style="width:96px;height:96px"></i><div><i style="width:60%;height:12px;margin:4px 0 10px"></i><i style="width:80%;height:16px;margin:0 0 12px"></i><i style="width:50%;height:30px;border-radius:999px"></i></div></div>`;
/* Tap a distance → plan loops for it. Tapping another distance while planning starts over; older results are dropped. */
async function suggestLoops(){
  const run=++SUG.run, km=SUG.km, D=km*1000, st=$("sugstatus");
  st.textContent=""; st.classList.remove("warn"); SUG.list=[];
  $("sugsub").textContent=`Planning ${km} km loops from the bar…`;
  $("suglist").innerHTML=SKEL+SKEL; $("sugclear").classList.add("hidden");
  try{
    if(!LIB.routes) await loadRoutes().catch(()=>{});
    const start=startPoint(); await loadSignals();
    const found=[]; const dirs=[0,60,120,180,240,300].map(b=>b+Math.round(Math.random()*30-15));
    await Promise.all([0,1].map(async w=>{
      for(let i=w;i<dirs.length;i+=2){
        if(run!==SUG.run) return;
        try{
          let d=D/3.9, l=await planLoop(start,dirs[i],d), len=l.m||0;
          if(len && Math.abs(len-D)/D>0.1){ d*=D/len; l=await planLoop(start,dirs[i],d); len=l.m||0; }
          if(len && Math.abs(len-D)/D<=0.2) found.push(l);
        }catch(e){}
      }
    }));
    if(run!==SUG.run) return;                                  // another distance was tapped meanwhile
    let routes=found.map((l,i)=>loopToRoute(l,km,i));
    routes.forEach(r=>r.lights=countLights(r.pts));
    // fewest lights first; with the same number, the smoother one (fewer turns per km), then closest to the distance
    routes.sort((a,b)=>(a.lights??99)-(b.lights??99) || (a.turns/a.km)-(b.turns/b.km) || Math.abs(a.km-km)-Math.abs(b.km-km));
    const keep=[]; for(const r of routes) if(!keep.some(k=>sameRoute(r,k))) keep.push(r);
    SUG.list=keep.slice(0,4);
    st.textContent = SUG.list.length ? "" : "No loops found this time. Tap the distance again to retry.";
    renderSuggestions();
  }catch(e){ if(run===SUG.run){ st.textContent=e.message||String(e); st.classList.add("warn"); $("suglist").innerHTML=""; } }
  finally{ if(run===SUG.run){ $("sugsub").textContent="Tap a distance: loops from the bar with few traffic lights."; $("sugclear").classList.toggle("hidden", !(SUG.list||[]).length && !st.textContent); } }
}
function clearSuggestions(){
  SUG.run++; SUG.list=[]; $("suglist").innerHTML=""; $("sugstatus").textContent=""; $("sugdup").classList.add("hidden");
  $("sugclear").classList.add("hidden"); $("sugkm").querySelectorAll("button").forEach(x=>x.setAttribute("aria-pressed","false"));
  $("sugsub").textContent="Tap a distance: loops from the bar with few traffic lights.";
}
function renderSuggestions(){
  $("suglist").innerHTML=(SUG.list||[]).map(r=>`<article class="rcard"><div class="thumb" data-thumb="${r.id}">${routeSVG(r.pts)}</div>
    <div><span class="km">${r.km.toFixed(1)} km${r.up!=null?` · ↑ ${r.up} m`:""}<span class="lights" data-lights="${r.id}">${lightsText(r)}</span></span><h3>${esc(r.name)}</h3>
      <div class="btns"><button type="button" class="btn" data-suse="${r.id}">Use</button>
        <button type="button" class="btn ghost" data-sgpx="${r.id}" aria-label="Download GPX"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg><span>GPX</span></button>
        ${LIB.canEdit?`<button type="button" class="btn ghost" data-ssave="${r.id}" aria-label="Save ${esc(r.name)} to the route library">Save</button>`:""}</div></div></article>`).join("");
  queueThumbs(SUG.list);
}
function queueThumbs(routes){
  TH.queue=[];
  for(const r of routes){ const key=thumbKey(r);
    let url=TH.mem.get(key); if(!url){ try{ url=localStorage.getItem(key); }catch(e){} if(url) TH.mem.set(key,url); }
    if(url) showThumb(r.id, url); else TH.queue.push(r); }
  if(TH.queue.length) renderThumbs();
}
async function libCall(path, body){
  const r=await fetch(path, body ? {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body), credentials:"include"} : {credentials:"include", cache:"no-store"});
  const j=await r.json().catch(()=>({error:"The route library isn’t available here."}));
  if(!r.ok) throw new Error(j.error||"Something went wrong.");
  LIB.routes=j.routes; LIB.canEdit=j.canEdit && viewAs()!=="guest"; renderRoutes(); return j;
}
async function loadRoutes(){
  const st=$("routesstatus");
  try{ await libCall("/api/routes"); st.textContent=""; st.classList.remove("warn"); }
  catch(e){ st.textContent=e.message||String(e); st.classList.add("warn"); }
}
function renderRoutes(){
  fillSecondSelect();
  $("routeadd").classList.toggle("hidden", !LIB.canEdit);
  $("libsave").classList.toggle("hidden", !LIB.canEdit);
  const list=$("routelist"); if(!LIB.routes) return;
  const all=LIB.routes;
  $("libhead").classList.toggle("hidden", !all.length);
  $("libtitle").textContent=`Saved routes · ${all.length}`;
  $("libfilter").classList.toggle("hidden", all.length<6);           // filters only once the list is long
  if(all.length<6) LIB.filter="all";
  $("libfilter").querySelectorAll("button").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.v===(LIB.filter||"all"))));
  const km=r=>Number(r.km.toFixed(1)), inRange={all:()=>true, short:r=>km(r)<=5, mid:r=>km(r)>5&&km(r)<=7, long:r=>km(r)>7};
  const rs=all.filter(inRange[LIB.filter||"all"]);
  if(!all.length){ list.innerHTML=`<p class="empty">No routes yet. Make a route post and tap “Save to route library”.</p>`; return; }
  if(!rs.length){ list.innerHTML=`<p class="empty">No saved routes in this range.</p>`; return; }
  list.innerHTML=rs.map(r=>{ const when=r.date?`Run on ${niceDate(r.date)} ${r.date.slice(0,4)}`:"";
    return `<article class="rcard" data-id="${r.id}"><div class="thumb" data-thumb="${r.id}">${routeSVG(r.pts)}</div>
      <div><span class="km">${r.km.toFixed(1)} km${r.up!=null?` · ↑ ${r.up} m`:""}<span class="lights" data-lights="${r.id}">${lightsText(r)}</span></span><h3>${esc(r.name)}</h3>
        <p class="meta">${[when, r.addedBy?`added by ${esc(r.addedBy)}`:""].filter(Boolean).join(" · ")}</p>
        <div class="btns"><button type="button" class="btn" data-use="${r.id}" aria-label="Use ${esc(r.name)} for a route post">Use</button>
          <button type="button" class="btn ghost" data-gpx="${r.id}" aria-label="Download GPX"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg><span>GPX</span></button>
          ${LIB.canEdit?`<button type="button" class="btn ghost" data-edit="${r.id}"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M14 6l4 4"/></svg><span>Edit</span></button>`:""}</div></div>
      ${LIB.canEdit?`<div class="edit hidden" id="edit-${r.id}">
        <div><label for="en-${r.id}">Title</label><input id="en-${r.id}" type="text" value="${esc(r.name)}" autocomplete="off"></div>
        <div><label for="ed-${r.id}">Run date</label><input id="ed-${r.id}" type="date" value="${esc(r.date)}"></div>
        <div class="btns"><button type="button" class="btn" data-save="${r.id}">Save</button><button type="button" class="btn ghost rm" data-rm="${r.id}">Remove route</button></div></div>`:""}</article>`; }).join("");
  if(!$("tab-routes").classList.contains("hidden")){ queueThumbs(LIB.routes); fillMissingLights(); }
}
/* Ask before adding a route that's already in the library: replace it, keep both, or skip.
   Shows the new one, the saved one and both on top of each other to compare. */
function askDuplicate(box, cand, existing){
  const NEW="#882c29", OLD="#3584ba";
  return new Promise(res=>{
    box.innerHTML=`<strong>“${esc(cand.name)}” (${cand.km.toFixed(1)} km)</strong> looks like a route already in the library: <strong>“${esc(existing.name)}”</strong>, ${existing.km.toFixed(1)} km.
      <div class="cmp">
        <figure>${routesSVG([[cand.pts,NEW]])}<figcaption><i style="background:${NEW}"></i>New</figcaption></figure>
        <figure>${routesSVG([[existing.pts,OLD]])}<figcaption><i style="background:${OLD}"></i>Saved</figcaption></figure>
        <figure>${routesSVG([[existing.pts,OLD],[cand.pts,NEW]])}<figcaption>Both</figcaption></figure>
      </div>
      <div class="btns"><button type="button" class="btn" data-a="replace">Replace it</button><button type="button" class="btn ghost" data-a="both">Keep both</button><button type="button" class="btn ghost" data-a="skip">Skip</button></div>`;
    box.classList.remove("hidden");
    box.onclick=e=>{ const b=e.target.closest("[data-a]"); if(!b) return; box.classList.add("hidden"); box.onclick=null; res(b.dataset.a); };
  });
}
async function addToLibrary(routes, title, date, box, status){
  if(!LIB.routes) await loadRoutes();
  const done=[];
  for(const [i,r] of routes.entries()){
    const name=(routes.length>1 ? `${title} (${kmText(r)} km)` : title) || cleanTitle(r.name) || "ROUTE";
    const cand={name, km:r.total/1000, pts:thin(r.pts)};
    const dup=(LIB.routes||[]).find(x=>sameRoute(cand,x));
    let replace=null;
    if(dup){ status.textContent=""; const a=await askDuplicate(box, cand, dup); if(a==="skip"){ done.push(`skipped “${name}”`); continue; } if(a==="replace") replace=dup.id; }
    status.textContent="Saving…"; status.classList.remove("warn");
    let lights=r.lights; if(lights==null && await loadSignals()) lights=r.lights=countLights(latlon(r));
    try{ await libCall("/api/routes/add",{...cand, gpx:gpxFor(r,name), date:date||"", replace, lights:lights??null}); done.push(replace?`replaced “${dup.name}”`:`saved “${name}”`); }
    catch(e){ status.textContent=e.message||String(e); status.classList.add("warn"); return; }
  }
  status.textContent=done.length ? done.join(", ").replace(/^./,c=>c.toUpperCase())+"." : "";
}
/* GPX download. On a phone it opens the share sheet (Save to Files, Garmin Connect, Komoot…): opening the
   file directly would trap the home-screen app in iOS's file preview, which has no way back. */
async function downloadGpx(id){
  const st=$("routesstatus");
  try{
    const res=await fetch(`/api/routes/gpx?id=${id}`, {credentials:"include"}); if(!res.ok) throw new Error("Couldn’t load the GPX file.");
    const name=(/filename="([^"]+)"/.exec(res.headers.get("content-disposition")||"")||[])[1]||"route.gpx";
    await shareGpx(await res.blob(), name);
  }catch(e){ st.textContent=e.message||String(e); st.classList.add("warn"); }
}
async function shareGpx(blob, name){
    for(const type of ["application/gpx+xml","application/octet-stream"]){
      const f=new File([blob], name, {type});
      if(navigator.canShare && navigator.canShare({files:[f]})){
        try{ await navigator.share({files:[f]}); }catch(e){ if(e.name!=="AbortError") throw e; }
        return;
      }
    }
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=name; document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },2000);
}
async function useRoute(id){
  const r=(LIB.routes||[]).find(x=>x.id===id); if(!r) return;
  const res=await fetch(`/api/routes/gpx?id=${id}`, {credentials:"include"}); if(!res.ok) return;
  const file=new File([await res.blob()], `${r.name}.gpx`, {type:"application/gpx+xml"});
  document.getElementById("tabbtn-poster").click();
  await loadFile(file); $("title").value=r.name; scheduleDraw();
}
function initSuggest(){
  $("sugkm").addEventListener("click",e=>{ const b=e.target.closest("[data-v]"); if(!b) return; SUG.km=Number(b.dataset.v);
    $("sugkm").querySelectorAll("button").forEach(x=>x.setAttribute("aria-pressed",String(x===b))); suggestLoops(); });
  $("sugclear").addEventListener("click",clearSuggestions);
  $("pickroute").addEventListener("click",()=>{ document.getElementById("tabbtn-routes").click(); window.scrollTo({top:0}); });
  $("suglist").addEventListener("click",async e=>{
    const g=e.target.closest("[data-sgpx]");
    if(g){ const r=(SUG.list||[]).find(x=>x.id===g.dataset.sgpx); if(r) shareGpx(new Blob([r.gpx],{type:"application/gpx+xml"}), `mrc-${r.name.toLowerCase().replace(/[^a-z0-9]+/g,"-")}-${r.km.toFixed(1)}km.gpx`).catch(err=>{ $("sugstatus").textContent=err.message; }); return; }
    const u=e.target.closest("[data-suse]"), s=e.target.closest("[data-ssave]"); const id=(u||s)&&(u||s).dataset[u?"suse":"ssave"];
    const r=(SUG.list||[]).find(x=>x.id===id); if(!r) return;
    if(u){ document.getElementById("tabbtn-poster").click(); await loadRoute(()=>routeFromText(r.gpx, r.name)); return; }
    const st=$("sugstatus"); await addToLibrary([r.full], r.name, "", $("sugdup"), st);
    const t=st.textContent;
    if(/^(Saved|Replaced)/.test(t)){ s.textContent="Saved ✓"; s.disabled=true; s.classList.add("saved"); st.textContent=""; }
    else if(/^Skipped/.test(t)){ s.textContent="Skipped"; st.textContent=""; }
  });
}
function initRoutes(){
  $("libfilter").addEventListener("click",e=>{ const b=e.target.closest("[data-v]"); if(!b) return; LIB.filter=b.dataset.v; renderRoutes(); });
  initSuggest();
  $("routelist").addEventListener("click", async e=>{
    const u=e.target.closest("[data-use]"); if(u) return useRoute(Number(u.dataset.use));
    const g=e.target.closest("[data-gpx]"); if(g) return downloadGpx(Number(g.dataset.gpx));
    const ed=e.target.closest("[data-edit]"); if(ed){ $("edit-"+ed.dataset.edit).classList.toggle("hidden"); return; }
    const sv=e.target.closest("[data-save]"); if(sv){ const id=sv.dataset.save;
      try{ await libCall("/api/routes/edit",{id:Number(id), name:$("en-"+id).value.toUpperCase().trim(), date:$("ed-"+id).value}); $("routesstatus").textContent="Saved."; $("routesstatus").classList.remove("warn"); }
      catch(err){ $("routesstatus").textContent=err.message; $("routesstatus").classList.add("warn"); } return; }
    const rm=e.target.closest("[data-rm]"); if(!rm) return;
    if(rm.dataset.sure!=="1"){ rm.dataset.sure="1"; rm.textContent="Sure? Tap again"; setTimeout(()=>{ if(rm.isConnected){ rm.dataset.sure=""; rm.textContent="Remove"; } },4000); return; }
    try{ await libCall("/api/routes/remove",{id:Number(rm.dataset.rm)}); }catch(err){ $("routesstatus").textContent=err.message; $("routesstatus").classList.add("warn"); }
  });
  $("libsavebtn").addEventListener("click", ()=>addToLibrary(S.routes, ($("title").value||"").toUpperCase().trim(), $("date").value, $("libdup"), $("libstatus")));
  // several GPX files at once: each is checked against the library (replace / skip) in turn
  $("gpx3").addEventListener("change", async e=>{ const files=[...e.target.files]; e.target.value=""; if(!files.length) return;
    const st=$("routesstatus"), notes=[];
    for(const f of files){
      try{ const r=await readRoute(f); await addToLibrary([r], cleanTitle(r.name)||cleanTitle(f.name), "", $("adddup"), st); if(st.textContent) notes.push(st.textContent.replace(/\.$/,"")); }
      catch(err){ notes.push(`${f.name}: ${err.message||err}`); }
    }
    st.textContent=notes.join(" · ")+(notes.length?".":""); const bad=notes.some(n=>/:/.test(n)); st.classList.toggle("warn", bad);
    if(!bad){ const t=st.textContent; setTimeout(()=>{ if(st.textContent===t) st.textContent=""; },5000); } });
}

/* ---------- schedule (captains' availability + lead) ---------- */
const SCH={data:null, view:"upcoming", today:""};
const DAYS=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"], MONTHS=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const esc=t=>String(t??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function localISO(d=new Date()){ const z=n=>String(n).padStart(2,"0"); return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`; }
function niceDate(iso){ const d=new Date(iso+"T12:00:00"); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; }
function nextRun(){ return SCH.data ? SCH.data.runs.find(r=>r.date>=SCH.today && !r.cancelled) : null; }
function runOn(date){ return SCH.data ? SCH.data.runs.find(r=>r.date===date) : null; }
/* ---------- Kate's view switch (⋯ menu): see the app as a captain or a guest does ----------
   The server sends Kate a few extra things (me.owner, who last changed a run).
   "Captain" and "Guest" strip those here, on her phone only; "Guest" also turns off editing. */
const OWNER_ONLY = [
  "Who last changed a run (Schedule)",
  "This View as switch",
];
let IS_OWNER=false;
const viewAs = () => { try{ return localStorage.getItem("mrc-view")||"me"; }catch(e){ return "me"; } };   // only Kate can set it
function asViewed(j){
  IS_OWNER = !!(j.me && j.me.owner);
  const v=viewAs(); if(v==="me") return j;
  const c=JSON.parse(JSON.stringify(j));
  c.me.owner=false; c.runs.forEach(r=>r.changedBy="");
  if(v==="guest") c.me.captain=null;
  return c;
}
function renderOwnerMenu(){
  $("ownermenu").hidden=!IS_OWNER; if(!IS_OWNER) return;
  const v=viewAs();
  $("ownermenu").querySelectorAll("[data-view]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.view===v)));
  const items=[...OWNER_ONLY];
  $("onlyyou").innerHTML=items.map(t=>`<li>${esc(t)}</li>`).join("");
  $("viewpill").classList.toggle("hidden", v==="me");
  $("viewpilltext").textContent = v==="guest" ? "Guest" : "Captain";
}
function setView(v){
  try{ localStorage.setItem("mrc-view", v); }catch(e){}
  renderOwnerMenu(); loadSchedule(); loadRoutes();
}
function captain(id){ return SCH.data ? SCH.data.captains.find(c=>c.id===id) : null; }
const statusText = st => st==="yes" ? "coming" : st==="tbd" ? "doesn’t know yet" : "not coming";
/* Captains on two lines: the shorter names on top, the longer ones below (each line A–Z). */
function capRows(caps){
  if(caps.length<4) return [caps];
  const byLen=[...caps].sort((a,b)=>a.name.length-b.name.length || a.name.localeCompare(b.name)), top=Math.ceil(caps.length/2);
  const az=l=>l.sort((a,b)=>a.name.localeCompare(b.name));
  return [az(byLen.slice(0,top)), az(byLen.slice(top))];
}
/* "Kate", "Kate & Felix", "Kate, Felix & Andrea" */
function names(ids){ const n=(ids||[]).map(captain).filter(Boolean).map(c=>c.name); return n.length<2 ? (n[0]||"") : n.slice(0,-1).join(", ")+" & "+n[n.length-1]; }

async function schedCall(path, body){
  const st=$("schedstatus"); st.classList.remove("warn");
  try{
    const r=await fetch(path, body ? {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body), credentials:"include"} : {credentials:"include", cache:"no-store"});
    const j=await r.json().catch(()=>({error:"The schedule isn’t available here."}));
    if(!r.ok) throw new Error(j.error||"Something went wrong.");
    SCH.data=asViewed(j); st.textContent=""; renderSchedule(); fillFromSchedule(false); renderOwnerMenu();
    return true;
  }catch(e){ st.textContent=e.message||String(e); st.classList.add("warn"); return false; }
}
function loadSchedule(){ SCH.today=localISO(); return schedCall("/api/state"); }

/* Keep the schedule live: while it's on screen, fetch other captains' changes every 15 s and
   whenever the app comes back to the foreground. Skipped while you're in the middle of
   editing a run, so nothing jumps under your finger. */
const POLL_MS = Number(params.get("poll")) || 15000;
function scheduleVisible(){ return !$("tab-schedule").classList.contains("hidden") && document.visibilityState==="visible"; }
function busyEditing(){
  if(!$("statepick").classList.contains("hidden")) return true;
  const a=document.activeElement;
  return !!(a && $("runs").contains(a) && a.matches("input,select,textarea")) || !!$("runs").querySelector("details[open]") || $("addrun").open;
}
async function refreshSchedule(){
  if(!scheduleVisible() || busyEditing() || SCH.loading || capPending) return;
  SCH.loading=true;
  try{
    const r=await fetch("/api/state",{credentials:"include",cache:"no-store"});
    if(r.ok){ const j=await r.json(); if(!busyEditing() && !capPending){ SCH.today=localISO(); SCH.data=asViewed(j); renderSchedule(); fillFromSchedule(false); } }
  }catch(e){}
  SCH.loading=false;
}
setInterval(refreshSchedule, POLL_MS);
document.addEventListener("visibilitychange", refreshSchedule);

/* Each captain's state on a run: no -> tbd -> yes -> lead -> no (tap their name to move on). */
const STATE_TEXT={no:"not coming", tbd:"tbd", yes:"coming", lead:"leading"};
const stateOf=(r,id)=> r.leads.includes(id) ? "lead" : (r.avail[id]||"tbd");

function renderSchedule(){
  const D=SCH.data; if(!D) return;
  const me=D.me.captain;
  $("taphint").classList.toggle("hidden", !me || SCH.view==="history" || tappedBefore());
  const shown=D.runs.filter(r=>r.date>=SCH.today).slice(0,16);
  renderHistory();
  const nxt=nextRun();
  $("runs").innerHTML = shown.length ? shown.map(r=>{
    const coming=D.captains.filter(c=>["yes","lead"].includes(stateOf(r,c.id)));
    const leadNames=names(r.leads);
    const past=r.date<SCH.today, editable=!!me && !past;
    // bottom line (no lead yet / last change by); ✎ Edit sits at its right, or after the names when there's no bottom line
    const meta=[r.leads.length?"":"No lead yet", r.changedBy?`last change by ${esc(r.changedBy)}`:""].filter(Boolean).join(" · ");
    const EDIT=`<button type="button" class="editbtn" data-editrun aria-expanded="false"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M14 6l4 4"/></svg><span>Edit</span></button>`;
    return `<article class="run ${r===nxt?"next":""} ${r.cancelled?"cancelled":""}" data-date="${r.date}">${r===nxt?'<span class="nexttab">Next run</span>':""}
      <div class="run-head">
        <div><span class="run-date">${niceDate(r.date)}</span> <span class="run-meta">${esc(r.time)}</span></div>
        <div>${r.cancelled?'<span class="tag muted">Cancelled</span>':`<span class="run-meta">${coming.length} coming</span>`}</div>
      </div>
      ${r.note?`<p class="run-note">${esc(r.note)}</p>`:""}
      ${r.cancelled && !past ? `<div class="todo"><strong>To do for ${leadNames?esc(leadNames):"the captain who was going to lead"}:</strong>
        Post an Instagram story (and edit the run post) saying the run is off and why, update the “next run” board in the bar, and tell the other captains. A cancelled run should stay the exception.</div>` : ""}
      <div class="who" role="group" aria-label="Captains on ${niceDate(r.date)}">${capRows(D.captains).map((row,ri,all)=>`<div class="whorow">${row.map(c=>{ const st=stateOf(r,c.id);
        return `<button type="button" class="${st}" data-cap="${c.id}" ${editable?"":"disabled"} aria-label="${esc(c.name)}: ${STATE_TEXT[st]}${editable?". Tap to change.":""}" aria-haspopup="menu">${esc(c.name)}${st==="lead"?'<span class="leadmark">lead</span>':""}</button>`; }).join("")}${ri===all.length-1 && editable && !meta?EDIT:""}</div>`).join("")}</div>
      ${meta?`<div class="runfoot"><p class="run-meta">${meta}</p>${editable?EDIT:""}</div>`:""}
      ${editable ? `<details class="runedit" style="margin-top:8px"><summary>Edit run</summary>
        <div class="grid" style="margin-top:10px">
          <div><label for="t-${r.date}">Time</label><input id="t-${r.date}" type="time" value="${esc(r.time)}" data-f="time"></div>
          <div style="align-self:end"><label class="check"><input type="checkbox" data-f="cancelled" ${r.cancelled?"checked":""}> Cancelled</label></div>
          <div class="full"><label for="n-${r.date}">Note</label><input id="n-${r.date}" type="text" value="${esc(r.note)}" data-f="note"></div>
        </div>
        <div style="margin-top:10px"><button type="button" class="btn ghost" data-saverun>Save</button></div></details>` : ""}
    </article>`; }).join("") : `<p class="empty">No runs to show.</p>`;
}

/* History: the last 12 months, newest first, grouped by month, plus a tally per captain.
   "Said coming" is what was in the schedule, not a head count. Leads before the app come
   from the old spreadsheet's green cells (imported once, see importSheetLeads in src/worker.js). */
function renderHistory(){
  const D=SCH.data; if(!D) return;
  const from=new Date(SCH.today+"T12:00:00"); from.setFullYear(from.getFullYear()-1);
  const fromISO=localISO(from);
  const past=D.runs.filter(r=>r.date<SCH.today && r.date>=fromISO).reverse();
  if(!past.length){ $("history").innerHTML='<p class="empty">No past runs yet.</p>'; return; }
  const held=past.filter(r=>!r.cancelled);
  const rows=D.captains.map(c=>({name:c.name,
    led:held.filter(r=>r.leads.includes(c.id)).length,
    came:held.filter(r=>["yes","lead"].includes(stateOf(r,c.id))).length}));
  const MONTHS_LONG=["January","February","March","April","May","June","July","August","September","October","November","December"];
  let html=`<div class="card"><h2>Last 12 months</h2>
    <p class="run-meta" style="margin:-4px 0 10px">${held.length} runs, ${past.length-held.length} cancelled</p>
    <table class="hist-table"><thead><tr><th>Captain</th><th class="n">Led</th><th class="n">Said coming</th></tr></thead><tbody>
    ${rows.map(r=>`<tr><td>${esc(r.name)}</td><td class="n">${r.led}</td><td class="n">${r.came}</td></tr>`).join("")}</tbody></table></div>`;
  let month="";
  for(const r of past){
    const d=new Date(r.date+"T12:00:00"), m=`${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
    if(m!==month){ month=m; html+=`<h3 class="hist-month">${m}</h3>`; }
    const n=D.captains.filter(c=>["yes","lead"].includes(stateOf(r,c.id))).length;
    html+=`<div class="hist-run ${r.cancelled?"cancelled":""}"><span class="d">${niceDate(r.date)} · ${esc(r.time)}</span>
      <span class="x">${r.cancelled?`Cancelled${r.leads.length?` (${esc(names(r.leads))} was to lead)`:""}`:`${r.leads.length?`Led by ${esc(names(r.leads))} · `:""}${n} captain${n===1?"":"s"}`}${r.note?`<br>${esc(r.note)}`:""}</span></div>`;
  }
  $("history").innerHTML=html;
}

/* Taps update the screen at once and are sent in order; the server's answer is shown once all are saved. */
let capQueue=Promise.resolve(), capPending=0;
/* Tapping a name opens a small picker with the four answers. */
const PICK=[["yes","Coming"],["lead","Lead"],["tbd","tbd"],["no","Not coming"]];
/* the "Tap a name…" hint shows until a captain has tapped a name once (remembered on this phone) */
const tappedBefore = () => { try{ return localStorage.getItem("mrc-tapped")==="1"; }catch(e){ return false; } };
function openPicker(btn, date, id){
  try{ localStorage.setItem("mrc-tapped","1"); }catch(e){} $("taphint").classList.add("hidden");
  const r=runOn(date), c=captain(id), box=$("statepick"); if(!r||!c) return;
  const cur=stateOf(r,id);
  box.innerHTML=`<p class="sp-h">${esc(c.name)} · ${niceDate(date)}</p><div class="sp-opts">`+
    PICK.map(([st,label])=>`<button type="button" class="${st}" data-state="${st}" aria-pressed="${st===cur}">${label}</button>`).join("")+`</div>`;
  box.dataset.date=date; box.dataset.cap=id; box.classList.remove("hidden");
  const b=btn.getBoundingClientRect(), w=box.offsetWidth, h=box.offsetHeight;
  const left=Math.max(12, Math.min(window.innerWidth-w-12, b.left+b.width/2-w/2));
  const below=b.bottom+8+h < window.innerHeight-90;   // keep clear of the tab bar
  box.style.left=left+"px"; box.style.top=(below ? b.bottom+8 : b.top-8-h)+window.scrollY+"px";
  box.querySelector('[aria-pressed="true"]')?.focus();
}
function closePicker(){ $("statepick").classList.add("hidden"); }
function tapCaptain(date, id, next){
  const r=runOn(date); if(!r) return;
  r.leads=r.leads.filter(x=>x!==id); if(next==="lead") r.leads.push(id);
  r.avail[id]= next==="lead" ? "yes" : next;
  if(SCH.data.me.owner) r.changedBy=(SCH.data.me.captain||{}).name||r.changedBy;   // only Kate sees who changed a run last
  renderSchedule(); fillFromSchedule(false);
  capPending++;
  capQueue=capQueue.then(async()=>{
    try{
      const res=await fetch("/api/captain",{method:"POST",headers:{"content-type":"application/json"},credentials:"include",body:JSON.stringify({date, captain:id, state:next})});
      const j=await res.json().catch(()=>({error:"Couldn’t save."}));
      if(!res.ok) throw new Error(j.error||"Couldn’t save.");
      if(--capPending===0){ SCH.data=asViewed(j); renderSchedule(); fillFromSchedule(false); $("schedstatus").textContent=""; }
    }catch(e){ capPending=0; $("schedstatus").textContent=(e.message||String(e))+" Reloading…"; $("schedstatus").classList.add("warn"); loadSchedule(); }
  });
}

function initSchedule(){
  $("statepick").addEventListener("click",e=>{ const b=e.target.closest("[data-state]"); if(!b) return;
    const box=$("statepick"); closePicker(); tapCaptain(box.dataset.date, Number(box.dataset.cap), b.dataset.state); });
  document.addEventListener("click",e=>{ if(!$("statepick").contains(e.target)) closePicker(); });
  document.addEventListener("keydown",e=>{ if(e.key==="Escape") closePicker(); });
  $("runs").addEventListener("click",e=>{
    const art=e.target.closest(".run"); if(!art) return;
    const ed=e.target.closest("[data-editrun]");
    if(ed){ const d=art.querySelector("details.runedit"); if(d){ d.open=!d.open; ed.setAttribute("aria-expanded",String(d.open)); } return; }
    const cap=e.target.closest(".who button[data-cap]");
    if(cap && !cap.disabled){ e.stopPropagation(); openPicker(cap, art.dataset.date, Number(cap.dataset.cap)); return; }
    if(e.target.closest("[data-saverun]")){
      const f=k=>art.querySelector(`[data-f="${k}"]`);
      schedCall("/api/run",{date:art.dataset.date, time:f("time").value, note:f("note").value, cancelled:f("cancelled").checked});
    }
  });

  $("schedview").addEventListener("click",e=>{ const b=e.target.closest("button"); if(!b) return;
    SCH.view=b.dataset.v; $("schedview").querySelectorAll("button").forEach(x=>x.setAttribute("aria-pressed",String(x===b)));
    const hist=SCH.view==="history";
    $("history").classList.toggle("hidden",!hist); ["runs","addrun","taphint"].forEach(id=>$(id).classList.toggle("hidden",hist || (id==="taphint" && (!(SCH.data&&SCH.data.me.captain) || tappedBefore()))));
    renderSchedule(); });
  $("newsave").addEventListener("click",async()=>{ if(await schedCall("/api/run",{date:$("newdate").value, time:$("newtime").value, note:$("newnote").value, cancelled:false})){ $("newnote").value=""; $("addrun").open=false; } });
  const tabs={poster:$("tabbtn-poster"), schedule:$("tabbtn-schedule"), routes:$("tabbtn-routes")};
  const show=k=>{ for(const [n,b] of Object.entries(tabs)){ b.setAttribute("aria-selected", String(n===k)); $("tab-"+n).classList.toggle("hidden", n!==k); }
    $("actions").classList.toggle("hidden", k!=="poster" || $("editor").classList.contains("hidden"));
    if(k==="schedule") loadSchedule();
    if(k==="routes") loadRoutes(); };
  tabs.poster.addEventListener("click",()=>show("poster"));
  tabs.schedule.addEventListener("click",()=>show("schedule"));
  tabs.routes.addEventListener("click",()=>show("routes"));
}


/* ---------- UI wiring ---------- */
function seg(id, key, after){
  const el=$(id);
  const set=v=>{ S[key]=v; el.querySelectorAll("button").forEach(b=>b.setAttribute("aria-pressed", String(b.dataset.v===v))); };
  set(S[key]);
  el.addEventListener("click", e=>{ const b=e.target.closest("button"); if(!b) return; set(b.dataset.v); after&&after(); scheduleDraw(); });
}
function range(id, key, fmt, conv, after){
  const el=$(id), out=$(id+"v");
  const upd=()=>{ S[key]=conv(el.value); if(out) out.textContent=fmt(el.value); };
  el.addEventListener("input", ()=>{ upd(); after&&after(); scheduleDraw(); }); upd();
  return upd;
}

/* Cloudflare Access tells a page who is signed in at /cdn-cgi/access/get-identity. */
async function showWhoAmI(){
  try{
    const r=await fetch("/cdn-cgi/access/get-identity",{credentials:"include",cache:"no-store"});
    if(!r.ok) return;
    const email=String((await r.json()).email||"").toLowerCase();
    if(email){ $("whoemail").textContent=email; $("whoami").classList.remove("hidden"); }
  }catch(e){}
}

/* Sign out: end this app's Cloudflare Access login, then open the app again, which shows
   Cloudflare's login page (email, then code). */
async function signOut(e){
  e.preventDefault();
  try{ await fetch("/cdn-cgi/access/logout",{credentials:"include",redirect:"manual",cache:"no-store"}); }catch(err){}
  location.replace("/?signedout=" + Date.now());
}

function initOwnerMenu(){
  $("ownermenu").addEventListener("click",e=>{ const b=e.target.closest("[data-view]"); if(b) setView(b.dataset.view); });
  $("viewpill").addEventListener("click",()=>setView("me"));
}
function init(){
  initOwnerMenu();
  loadPrefs();
  $("signout").addEventListener("click",signOut);
  showWhoAmI();
  initSchedule();
  loadSchedule();
  initRoutes();
  loadRoutes();
  seg("fmt","fmt");
  // the title field sits invisibly over the title on the post: show the dashed outline while typing
  $("title").addEventListener("focus",()=>{ clearTimeout(S.selT); S.sel="title"; S.editTitle=true; $("title").classList.add("editing"); scheduleDraw(); });
  $("title").addEventListener("blur",()=>{ S.sel=null; S.editTitle=false; $("title").classList.remove("editing"); scheduleDraw(); });
  $("title").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); e.target.blur(); } });
  $("beerreset").addEventListener("click",()=>{ delete S.items[S.fmt]; S.zoom=1; S.pan={x:0,y:0}; scheduleDraw(); });
  ["title","date"].forEach(i=>$(i).addEventListener("input",scheduleDraw));
  $("gpx").addEventListener("change",e=>{ const f=e.target.files[0]; if(f) loadFile(f); e.target.value=""; });
  $("gpx2").addEventListener("change",e=>{ const f=e.target.files[0]; closeSecondSheet(); if(f) loadSecond(f); e.target.value=""; });
  $("route2add").addEventListener("click",openSecondSheet); initSheetDrag();
  // WhatsApp community QR: button next to ⋯ on every tab; tap anywhere or Close to hide it
  $("qrbtn").addEventListener("click",()=>{ const d=$("qrsheet"); if(d.showModal) d.showModal(); else d.setAttribute("open",""); });
  $("qrsheet").addEventListener("click",()=>{ const d=$("qrsheet"); if(d.close) d.close(); else d.removeAttribute("open"); });
  $("sheet2close").addEventListener("click",closeSecondSheet);
  $("sheet2").addEventListener("click",e=>{ if(e.target===$("sheet2")) closeSecondSheet();   // tap on the dimmed background
    const b=e.target.closest("[data-pick]"); if(b && !b.disabled) addSecondFromLibrary(Number(b.dataset.pick)); });
  $("pickfilter").addEventListener("click",e=>{ const b=e.target.closest("[data-v]"); if(!b) return; SEC.filter=b.dataset.v; renderPickList(); });
  // ✕ on either route: the other one stays; removing the main one makes the second the main one (keeping its colour; the title stays)
  $("distinfo").addEventListener("click",e=>{ const b=e.target.closest("[data-rmroute]"); if(!b) return;
    if(b.dataset.rmroute==="0" && S.routes.length===2){
      const keep=S.routes[1], col=routeColor(1);
      S.routes=[keep]; S.color=col;
    } else if(S.routes.length===1) return startOver();   // the only route: back to the empty Route post
    else S.routes=S.routes.slice(0,1);
    routesChanged(); });
  $("distinfo").addEventListener("click",e=>{ if(e.target.closest("[data-sigretry]")){ SIG.error=""; renderStats(); lightsForPost(); } });
  $("pastebtn").addEventListener("click",pasteGpx);
  $("pastetext").addEventListener("paste",async e=>{ const dt=e.clipboardData; if(dt && [...(dt.items||[])].some(i=>i.kind==="file")){ e.preventDefault();
      if(!(await loadFromClipboardData(dt))) $("pastestatus").textContent="That file isn’t a GPX."; } });
  $("pastetext").addEventListener("input",e=>{ const t=e.target.value;
    if(!loadPasted(t)) $("pastestatus").textContent = t.trim() ? (/<gpx[\s>]/i.test(t) ? "Not the whole GPX yet: it needs to end with </gpx>." : "That doesn’t look like GPX text.") : ""; });
  // pasting anywhere on an empty Route post (e.g. Cmd+V on a laptop) loads it straight away
  document.addEventListener("paste",e=>{ if($("tab-poster").classList.contains("hidden") || !$("editor").classList.contains("hidden")) return;
    if(e.target.closest && e.target.closest("input,textarea")) return;
    e.preventDefault(); loadFromClipboardData(e.clipboardData); });
  const drop=$("drop");
  ["dragenter","dragover"].forEach(t=>drop.addEventListener(t,e=>{e.preventDefault(); drop.classList.add("over");}));
  ["dragleave","drop"].forEach(t=>drop.addEventListener(t,e=>{e.preventDefault(); drop.classList.remove("over");}));
  drop.addEventListener("drop",e=>{ const f=e.dataTransfer.files[0]; if(f) loadFile(f); });
  
  $("share").addEventListener("click",share);

  // One finger: drag the map, or the title / distance / FREE BEER! when the finger starts on it.
  // Two fingers: pinch the map to zoom, or turn + resize the text the gesture started on (any angle).
  // Like Instagram: text sticks to the centre lines (and to straight angles) when it comes close, with a guide line,
  // and comes off again once you move a bit further. raw = where your finger would put it without sticking.
  const ptrs=new Map(); let last=null, g0=null, key=null, raw=null;
  const SNAP=28, SNAP_DEG=6;
  const sticky=(k, rdx, rdy)=>{ const F=FORMATS[S.fmt], h=S.hits[k], cur=itemOf(k); if(!h) return {dx:rdx, dy:rdy};
    const bx=h.cx-cur.dx, by=h.cy-cur.dy; let dx=rdx, dy=rdy; S.guides={};
    if(Math.abs(bx+rdx-F.w/2)<SNAP){ dx=F.w/2-bx; S.guides.v=true; }
    if(Math.abs(by+rdy-F.h/2)<SNAP){ dy=F.h/2-by; S.guides.h=true; }
    return {dx, dy}; };
  const straight=r=>{ const n=Math.round(r/90)*90; return Math.abs(r-n)<SNAP_DEG ? n : r; };
  const toCanvas=(x,y)=>{ const r=cv.getBoundingClientRect(), k=cv.width/r.width; return {x:(x-r.left)*k, y:(y-r.top)*k}; };
  const hitAt=(x,y)=>{ if(S.fmt==="route") return null; const c=toCanvas(x,y), pad=30;
    for(const k of ["beer","title","dist"]){ const h=(S.hits||{})[k]; if(!h) continue;
      const a=-h.rot*Math.PI/180, px=c.x-h.cx, py=c.y-h.cy;
      const lx=(px*Math.cos(a)-py*Math.sin(a))/h.scale, ly=(px*Math.sin(a)+py*Math.cos(a))/h.scale;
      if(Math.abs(lx)<h.w/2+pad/h.scale && Math.abs(ly)<h.h/2+pad/h.scale) return k; }
    return null; };
  const twoFinger=()=>{ const [a,b]=[...ptrs.values()]; return {d:Math.hypot(a.x-b.x,a.y-b.y), ang:Math.atan2(b.y-a.y,b.x-a.x)}; };
  cv.addEventListener("pointerdown",e=>{ try{ cv.setPointerCapture(e.pointerId); }catch(err){} ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY}); cv.classList.add("dragging");
    if(ptrs.size===1){ key=hitAt(e.clientX,e.clientY); clearTimeout(S.selT); S.sel=key; if(key){ const it=itemOf(key); raw={dx:it.dx, dy:it.dy}; scheduleDraw(); } }
    if(ptrs.size===2){ const t=twoFinger(); const it=key?itemOf(key):ITEM0; g0={d:t.d, ang:t.ang, zoom:S.zoom, scale:it.scale, rot:it.rot}; }
    last={x:e.clientX,y:e.clientY}; });
  cv.addEventListener("pointermove",e=>{ if(!ptrs.has(e.pointerId)||!S.view||S.fmt==="route") return; ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY});
    const k=cv.width/cv.getBoundingClientRect().width;
    if(ptrs.size===2 && g0){ const t=twoFinger();
      if(key){ setItem(key,{scale:g0.scale*t.d/g0.d, rot:straight(g0.rot+(t.ang-g0.ang)*180/Math.PI)}); return; }
      const z=Math.max(.5,Math.min(2,g0.zoom*t.d/g0.d));
      S.zoom=z; scheduleDraw(); return; }
    if(ptrs.size===1 && last){
      const dx=(e.clientX-last.x)*k, dy=(e.clientY-last.y)*k; last={x:e.clientX,y:e.clientY};
      if(key){ raw.dx+=dx; raw.dy+=dy; setItem(key, sticky(key, raw.dx, raw.dy)); }
      else { S.pan.x+=dx/S.view.scale; S.pan.y+=dy/S.view.scale; scheduleDraw(); }
    } });
  const up=e=>{ ptrs.delete(e.pointerId); if(ptrs.size<2) g0=null; if(!ptrs.size){ last=null; key=null; S.guides=null; scheduleDraw(); cv.classList.remove("dragging");
    clearTimeout(S.selT); if(S.sel) S.selT=setTimeout(()=>{ S.sel=null; scheduleDraw(); },1200); } else { const v=[...ptrs.values()][0]; last={x:v.x,y:v.y}; if(key){ const it=itemOf(key); raw={dx:it.dx, dy:it.dy}; } } };
  cv.addEventListener("pointerup",up); cv.addEventListener("pointercancel",up);
  // A tap (no drag): on the title → type a new one; on a route → burgundy ⇄ blue (two routes swap colours)
  let downAt=null, moved=false;
  cv.addEventListener("pointerdown",e=>{ if(ptrs.size===1){ downAt={x:e.clientX,y:e.clientY,t:Date.now()}; moved=false; } else moved=true; });
  cv.addEventListener("pointermove",e=>{ if(downAt && Math.hypot(e.clientX-downAt.x,e.clientY-downAt.y)>8) moved=true; });
  cv.addEventListener("click",e=>{ if(moved || !downAt || Date.now()-downAt.t>600) return;
    if(S.fmt!=="route" && hitAt(e.clientX,e.clientY)==="title"){ $("title").focus(); return; }
    const c=toCanvas(e.clientX,e.clientY), near=Math.max(48, S.width*3);
    if((S.drawn||[]).some(px=>px.length>1 && distToLine(c,px)<near)){ S.color=otherColor(S.color); savePrefs(); if(S.routes.length) renderStats(); scheduleDraw(); }
    else if(S.fmt!=="route" && !S.hits?.title && c.y<cv.height*0.3){ $("title").focus(); } });
  document.fonts.load('60px "MikkelWind"');
}

/* The route post takes its date from the next run in the schedule. */
function fillFromSchedule(onLoad){
  const n=nextRun();
  const hint=$("nextrun-hint");
  if(n){ const l=names(n.leads); hint.textContent=`Next run: ${niceDate(n.date)}, ${n.time}${l?` · led by ${l}`:" · no lead picked yet"}`; } else hint.textContent="";
  if(onLoad && n) $("date").value=n.date;
}

init();

/* Theme switched (⋯ menu or phone setting): redraw route pictures in the matching map style */
function themeChanged(){ try{ if(typeof renderRoutes==="function") renderRoutes(); if(typeof renderSuggestions==="function" && SUG.list && SUG.list.length) renderSuggestions(); }catch(e){} }
document.addEventListener("mrc-theme", themeChanged);
try{ matchMedia("(prefers-color-scheme: dark)").addEventListener("change", themeChanged); }catch(e){}
