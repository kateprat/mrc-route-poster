"use strict";
/* MRC Route Poster: GPX -> branded route post, plus the captains' schedule.
   Layout per format: FORMATS. Map look: PALETTE / mapStyle(). Schedule: renderSchedule(). */

/* ---------- constants ---------- */
const FORMATS = {
  feed:   {w:1080, h:1350, box:[0.10,0.36,0.90,0.80], title:150, dist:300, beer:0.865, dateY:40},
  story:  {w:1080, h:1920, box:[0.10,0.33,0.90,0.72], title:270, dist:420, beer:0.78,  dateY:290},
  square: {w:1080, h:1080, box:[0.12,0.40,0.88,0.80], title:100, dist:240, beer:0.87,  dateY:36},
  route:  {w:1080, h:1920, box:[0.12,0.15,0.88,0.85], title:null}
};
const TEXT = "#141414";
const COLORS = ["#882c29", "#3584ba"];                   // MRC burgundy, MRC blue
const ADV_DEFAULTS = {width:10, simplify:8, round:false, trimS:0, trimE:0};
/* Map data: OpenFreeMap vector tiles (OpenStreetMap, OpenMapTiles schema). No API key, no limits.
   ?source=<tilejson url> lets the offline test point at local data. */
const params = new URLSearchParams(location.search);
const MAP_SOURCE = params.get("source") || "https://tiles.openfreemap.org/planet";

/* ---------- state ---------- */
const S = {
  routes: [],        // [{name, pts:[{lat,lon}], cum:[m], total:m}] — one, or two when there are two route options
  fmt: "feed", color: COLORS[0], mapstyle: "grey",   // always the MRC grey map
  zoom: 1, ...ADV_DEFAULTS,
  pan: {x:0, y:0},   // mercator units
  beer: {},          // per format: {x,y,scale,rot} once someone moves/turns/resizes FREE BEER!, else default
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
  const pts = nodes.map(n => ({lat:parseFloat(n.getAttribute("lat")), lon:parseFloat(n.getAttribute("lon"))}))
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
function computeView(F, W, H){
  const m=S.mpts; let minx=1e9,miny=1e9,maxx=-1e9,maxy=-1e9;
  for(const p of m){minx=Math.min(minx,p.x);maxx=Math.max(maxx,p.x);miny=Math.min(miny,p.y);maxy=Math.max(maxy,p.y);}
  const [bx0,by0,bx1,by1]=F.box; const bw=(bx1-bx0)*W, bh=(by1-by0)*H;
  const rw=Math.max(maxx-minx,1e-9), rh=Math.max(maxy-miny,1e-9);
  const scale=Math.min(bw/rw, bh/rh)*S.zoom;            // px per mercator unit
  const cx=(minx+maxx)/2 - S.pan.x, cy=(miny+maxy)/2 - S.pan.y;
  const ox=(bx0+bx1)/2*W, oy=(by0+by1)/2*H;
  return {scale, cx, cy, ox, oy, toPx:(p)=>({x:ox+(p.x-cx)*scale, y:oy+(p.y-cy)*scale})};
}

/* ---------- map (MapLibre, drawn off-screen, copied into the post) ---------- */
const PALETTE = {
  grey:  {bg:"#e6e6e6", park:"#dedede", water:"#cfd3d4", building:"#dadada", road:"#ffffff", minor:"#fbfbfb", rail:"#d2d2d2"}
};
function mapStyle(name){
  const c=PALETTE[name]||PALETTE.grey;
  const w=(base)=>["interpolate",["exponential",1.6],["zoom"],10,base*0.25,14,base,18,base*9];
  const roads=[
    ["path",   ["path","track"],                          0.9, c.minor],
    ["minor",  ["minor","service"],                       1.6, c.minor],
    ["street", ["tertiary","secondary"],                  2.6, c.road],
    ["major",  ["primary","trunk","motorway"],            3.4, c.road],
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
      {id:"building", type:"fill", source:"omt", "source-layer":"building", minzoom:14, paint:{"fill-color":c.building}},
      {id:"rail", type:"line", source:"omt", "source-layer":"transportation", filter:["==",["get","class"],"rail"], paint:{"line-color":c.rail, "line-width":w(1)}},
      ...roads.map(([id,cls,width,color])=>({id:"road-"+id, type:"line", source:"omt", "source-layer":"transportation",
        filter:["all",["in",["get","class"],["literal",cls]],["!=",["get","brunnel"],"tunnel"]],
        layout:{"line-cap":"round","line-join":"round"}, paint:{"line-color":color, "line-width":w(width)}})),
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
    M.map.on("render",()=>scheduleDraw());
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
  if(M.key!==key){ M.key=key; M.idle=false; map.jumpTo({center:unitToLngLat(ux,uy), zoom}); }
  return map;
}
function drawMap(V, W, H){
  const bg=(PALETTE[S.mapstyle]||PALETTE.grey).bg;
  ctx.fillStyle=S.mapstyle==="none"?"#e6e6e6":bg; ctx.fillRect(0,0,W,H);
  if(S.mapstyle==="none") return true;
  const map=syncMap(V,W,H);
  if(map && M.ready){ try{ ctx.drawImage(map.getCanvas(),0,0,W,H); }catch(e){ M.error=true; } }
  return !!(map && M.ready && M.idle);
}
function mapSettled(timeout=8000){
  if(S.fmt==="route"||S.mapstyle==="none"||!M.map) return Promise.resolve();
  return new Promise(res=>{ const t0=Date.now(); (function wait(){ if((M.ready&&M.idle&&M.map.areTilesLoaded())||M.error||Date.now()-t0>timeout) return res(); setTimeout(wait,120); })(); });
}


/* ---------- drawing ---------- */
const otherColor = c => c===COLORS[0] ? COLORS[1] : COLORS[0];
const routeColor = i => i===0 ? S.color : otherColor(S.color);
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
    const cm=ctx.measureText(ch), w=ctx.measureText(base.slice(0,m.i+1)).width-before;
    const cx=x0+before+w/2, capTop=by-cm.actualBoundingBoxAscent;
    drawMark(m.kind, cx, capTop, size, w);
  }
  ctx.restore();
  return full.width;
}
function drawMark(kind, cx, capTop, size, w){
  const dotFont=Math.round(size*0.8);
  if(kind==="dots"){
    ctx.font=`${dotFont}px "MikkelWind"`;
    const pm=ctx.measureText("."), dh=pm.actualBoundingBoxAscent+pm.actualBoundingBoxDescent;
    const cy=capTop-size*0.06-dh/2;
    for(const dx of [-w*0.2, w*0.2]){
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

const BEER_DEFAULT = () => { const F=FORMATS[S.fmt]; return {x:F.w/2, y:F.h*F.beer, scale:1, rot:0}; };
function beerState(){ return {...BEER_DEFAULT(), ...(S.beer[S.fmt]||{})}; }
function setBeer(patch){
  const F=FORMATS[S.fmt], b={...beerState(), ...patch};
  b.x=Math.max(60,Math.min(F.w-60,b.x)); b.y=Math.max(10,Math.min(F.h-60,b.y));
  b.scale=Math.max(.6,Math.min(2.2,b.scale)); b.rot=Math.max(-45,Math.min(45,b.rot));
  S.beer[S.fmt]=b; syncBeerControls(); scheduleDraw();
}
function syncBeerControls(){
  const b=beerState();
  $("beersize").value=Math.round(b.scale*100); $("beersizev").textContent=Math.round(b.scale*100)+"%";
  $("beerrot").value=Math.round(b.rot); $("beerrotv").textContent=Math.round(b.rot)+"°";
}

function drawText(F, W, H){
  ctx.save(); ctx.fillStyle=TEXT; ctx.textAlign="center"; ctx.textBaseline="top";
  const title=($("title").value||"").toUpperCase().trim();
  let y=F.title;
  if(title){ const s=fitText(title,'"MikkelWind"',W*0.86,160,60); drawMW(title,W/2,y,s); y+=s*1.02; }
  const dy=title?y+8:F.dist;
  // distance(s): one route in black, two routes each in their route colour
  ctx.font=`100px "MikkelWind"`;
  if(S.routes.length===1){ drawMW(`${kmText(S.routes[0])} KM`, W/2, dy, 100); }
  else if(S.routes.length===2){
    const parts=[[`${kmText(S.routes[0])} KM`,routeColor(0)],["  /  ",TEXT],[`${kmText(S.routes[1])} KM`,routeColor(1)]];
    let size=100, total; do{ ctx.font=`${size}px "MikkelWind"`; total=parts.reduce((t,[s])=>t+ctx.measureText(s).width,0); size-=6; }while(total>W*0.9 && size>50);
    let x=W/2-total/2; ctx.textAlign="left";
    for(const [s,c] of parts){ ctx.fillStyle=c; ctx.fillText(s,x,dy); x+=ctx.measureText(s).width; }
    ctx.textAlign="center"; ctx.fillStyle=TEXT;
  }
  // FREE BEER! — always there; can be moved, turned and resized; the reset button puts it back
  const b=beerState();
  ctx.font=`68px "MikkelWind"`;
  const bw=ctx.measureText("FREE BEER!").width, bh=76;
  ctx.save(); ctx.translate(b.x, b.y+bh/2); ctx.rotate(b.rot*Math.PI/180); ctx.scale(b.scale,b.scale);
  ctx.textBaseline="middle"; ctx.fillText("FREE BEER!", 0, 0); ctx.restore();
  S.beerHit={cx:b.x, cy:b.y+bh/2, r:Math.max(bw,bh)/2*b.scale};
  const date=fmtDate($("date").value);
  if(date){ ctx.textAlign="right"; ctx.textBaseline="bottom"; ctx.font=`58px "MikkelWind"`; ctx.fillText(date, W-40, H-F.dateY); }   // digits and slashes are all in the font
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
  const F=FORMATS[S.fmt]; const W=F.w, H=F.h;
  if(cv.width!==W||cv.height!==H){cv.width=W;cv.height=H;}
  const V=computeView(F,W,H); S.view=V;
  let mapOk=true;
  if(S.fmt==="route"){ ctx.clearRect(0,0,W,H); S.beerHit=null; }
  else mapOk=drawMap(V,W,H);
  // second route first, so the main route sits on top where they share streets
  for(let i=S.rpts.length-1;i>=0;i--){ let px=S.rpts[i].map(V.toPx); if(S.round) px=chaikin(px,3); strokeRoute(px, S.width, routeColor(i)); }
  if(S.fmt!=="route") drawText(F,W,H);
  $("beerreset").classList.toggle("hidden", !S.beer[S.fmt] || S.fmt==="route");
  $("beerctl").classList.toggle("hidden", S.fmt==="route");
  const st=$("status");
  if(S.fmt!=="route" && M.error && !M.ready){ st.textContent="Map couldn’t load. Check your connection and reload."; st.classList.add("warn"); }
  else if(S.fmt!=="route" && !mapOk){ st.textContent="Loading map…"; st.classList.remove("warn"); }
  else { st.textContent = S.fmt==="route" ? "Transparent PNG of just the route, for stickers on photos." : ""; st.classList.remove("warn"); }
  cv.style.background = S.fmt==="route" ? "repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 0 0/24px 24px" : "#e6e6e6";
}

/* ---------- export ---------- */
function nextWednesday(){
  const d=new Date(); const add=(3-d.getDay()+7)%7; d.setDate(d.getDate()+add); return localISO(d);
}
function exportBlob(){ return mapSettled().then(()=>new Promise(res=>{ draw(); cv.toBlob(b=>res(b),"image/png"); })); }
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
async function readRoute(file){
  const g=parseGPX(await file.text());
  const cum=cumulative(g.pts);
  return {name:g.name||file.name.replace(/\.gpx$/i,""), pts:g.pts, cum, total:cum[cum.length-1]};
}
function routesChanged(){
  const maxTrim=Math.max(50, Math.round(Math.min(...S.routes.map(r=>r.total))/2/10)*10);
  ["trimS","trimE"].forEach(i=>$(i).max=String(maxTrim));
  $("distinfo").textContent=S.routes.map(r=>`${kmText(r)} km`).join(" / ");
  const two=S.routes.length===2;
  $("route2none").classList.toggle("hidden", two); $("route2some").classList.toggle("hidden", !two);
  if(two) $("route2info").textContent=`Second route: ${kmText(S.routes[1])} km`;
  S.pan={x:0,y:0};
  prepareRoute(); scheduleDraw();
}
async function loadFile(file){
  try{
    const r=await readRoute(file);
    S.routes=[r]; S.zoom=1; $("zoom").value=100; $("zoomv").textContent="100%"; S.beer={}; syncBeerControls();
    $("title").value=cleanTitle(r.name);
    fillFromSchedule(true);
    if(!$("date").value) $("date").value=nextWednesday();
    $("editor").classList.remove("hidden"); $("actions").classList.remove("hidden"); $("drop").classList.add("hidden");
    routesChanged();
    await document.fonts.load('100px "MikkelWind"'); draw();
    cv.scrollIntoView({behavior:"smooth", block:"start"});
  }catch(e){ alert(e.message||String(e)); }
}
async function loadSecond(file){
  try{ const r=await readRoute(file); S.routes=[S.routes[0], r]; routesChanged(); }
  catch(e){ alert(e.message||String(e)); }
}

/* ---------- schedule (captains' availability + lead) ---------- */
const SCH={data:null, showPast:false, today:""};
const DAYS=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"], MONTHS=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const esc=t=>String(t??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function localISO(d=new Date()){ const z=n=>String(n).padStart(2,"0"); return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`; }
function niceDate(iso){ const d=new Date(iso+"T12:00:00"); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; }
function nextRun(){ return SCH.data ? SCH.data.runs.find(r=>r.date>=SCH.today && !r.cancelled) : null; }
function runOn(date){ return SCH.data ? SCH.data.runs.find(r=>r.date===date) : null; }
function captain(id){ return SCH.data ? SCH.data.captains.find(c=>c.id===id) : null; }

async function schedCall(path, body){
  const st=$("schedstatus"); st.classList.remove("warn");
  try{
    const r=await fetch(path, body ? {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body), credentials:"include"} : {credentials:"include", cache:"no-store"});
    const j=await r.json().catch(()=>({error:"The schedule isn’t available here."}));
    if(!r.ok) throw new Error(j.error||"Something went wrong.");
    SCH.data=j; st.textContent=""; renderSchedule(); fillFromSchedule(false);
    return true;
  }catch(e){ st.textContent=e.message||String(e); st.classList.add("warn"); return false; }
}
function loadSchedule(){ SCH.today=localISO(); return schedCall("/api/state"); }

function renderSchedule(){
  const D=SCH.data; if(!D) return;
  const me=D.me.captain;
  $("unlinked").classList.toggle("hidden", !!me);
  $("unlinkedemail").textContent=D.me.email;
  const runs=D.runs.filter(r=>SCH.showPast ? true : r.date>=SCH.today);
  const shown=SCH.showPast ? runs.slice(-60) : runs.slice(0,16);
  const nxt=nextRun();
  $("showpast").textContent=SCH.showPast ? "Hide past runs" : "Show past runs";
  $("runs").innerHTML = shown.length ? shown.map(r=>{
    const coming=D.captains.filter(c=>r.avail[c.id]==="yes");
    const mine=me ? (r.avail[me.id]||"") : "";
    const lead=captain(r.lead);
    const opts=['<option value="">No lead yet</option>'].concat(
      [...D.captains].sort((a,b)=>(r.avail[b.id]==="yes")-(r.avail[a.id]==="yes"))
        .map(c=>`<option value="${c.id}" ${c.id===r.lead?"selected":""}>${esc(c.name)}${r.avail[c.id]==="yes"?" ✓":""}</option>`)).join("");
    const past=r.date<SCH.today;
    return `<article class="run ${r===nxt?"next":""} ${r.cancelled?"cancelled":""}" data-date="${r.date}">
      <div class="run-head">
        <div><span class="run-date">${niceDate(r.date)}</span> <span class="run-meta">${esc(r.time)}</span></div>
        <div>${r===nxt?'<span class="tag">Next run</span> ':""}${r.cancelled?'<span class="tag muted">Cancelled</span>':`<span class="run-meta">${coming.length} coming</span>`}</div>
      </div>
      ${r.note?`<p class="run-note">${esc(r.note)}</p>`:""}
      ${r.cancelled && !past ? `<div class="todo"><strong>To do for ${lead?esc(lead.name):"the captain who was going to lead"}:</strong>
        Post an Instagram story (and edit the run post) saying the run is off and why, update the “next run” board in the bar, and tell the other captains. A cancelled run should stay the exception.</div>` : ""}
      ${me && !past ? `<div class="mine" role="group" aria-label="Your availability on ${niceDate(r.date)}">
        <button type="button" data-s="yes" aria-pressed="${mine==="yes"}">Coming</button>
        <button type="button" data-s="no" aria-pressed="${mine==="no"}">Not coming</button>
        <button type="button" data-s="tbd" aria-pressed="${mine==="tbd"}">Don’t know</button></div>` : ""}
      <ul class="who" aria-label="Captains">${D.captains.map(c=>{ const st=r.avail[c.id]||"no";
        return `<li class="${st}">${esc(c.name)}<span class="sr"> — ${st==="yes"?"coming":st==="tbd"?"don’t know yet":"not coming"}</span></li>`; }).join("")}</ul>
      <div class="leadrow"><label for="lead-${r.date}">Lead</label>
        <select id="lead-${r.date}" data-lead ${me&&!past?"":"disabled"}>${opts}</select></div>
      ${r.lead&&r.leadBy?`<p class="run-meta" style="margin:6px 0 0">Set by ${esc(r.leadBy)}</p>`:""}
      ${me && !past ? `<details style="margin-top:8px"><summary>Edit run</summary>
        <div class="grid" style="margin-top:10px">
          <div><label for="t-${r.date}">Time</label><input id="t-${r.date}" type="time" value="${esc(r.time)}" data-f="time"></div>
          <div style="align-self:end"><label class="check"><input type="checkbox" data-f="cancelled" ${r.cancelled?"checked":""}> Cancelled</label></div>
          <div class="full"><label for="n-${r.date}">Note</label><input id="n-${r.date}" type="text" value="${esc(r.note)}" data-f="note"></div>
        </div>
        <div style="margin-top:10px"><button type="button" class="btn ghost" data-saverun>Save</button></div></details>` : ""}
    </article>`; }).join("") : `<p class="empty">No runs to show.</p>`;
}

function initSchedule(){
  $("runs").addEventListener("click",e=>{
    const art=e.target.closest(".run"); if(!art) return;
    const b=e.target.closest(".mine button");
    if(b){ schedCall("/api/status",{date:art.dataset.date, status:b.dataset.s}); return; }
    if(e.target.closest("[data-saverun]")){
      const f=k=>art.querySelector(`[data-f="${k}"]`);
      schedCall("/api/run",{date:art.dataset.date, time:f("time").value, note:f("note").value, cancelled:f("cancelled").checked});
    }
  });
  $("runs").addEventListener("change",e=>{
    const sel=e.target.closest("select[data-lead]"); if(!sel) return;
    schedCall("/api/lead",{date:sel.closest(".run").dataset.date, lead:sel.value||null});
  });
  $("showpast").addEventListener("click",()=>{ SCH.showPast=!SCH.showPast; renderSchedule(); });
  $("newsave").addEventListener("click",async()=>{ if(await schedCall("/api/run",{date:$("newdate").value, time:$("newtime").value, note:$("newnote").value, cancelled:false})){ $("newnote").value=""; $("addrun").open=false; } });
  const tabs={poster:$("tabbtn-poster"), schedule:$("tabbtn-schedule")};
  const show=k=>{ for(const [n,b] of Object.entries(tabs)){ b.setAttribute("aria-selected", String(n===k)); $("tab-"+n).classList.toggle("hidden", n!==k); }
    $("actions").classList.toggle("hidden", k!=="poster" || $("editor").classList.contains("hidden"));
    if(k==="schedule") loadSchedule(); };
  tabs.poster.addEventListener("click",()=>show("poster"));
  tabs.schedule.addEventListener("click",()=>show("schedule"));
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
function resetAdvanced(){
  Object.assign(S, ADV_DEFAULTS);
  $("width").value=S.width; $("widthv").textContent=S.width;
  $("simplify").value=S.simplify; $("simplifyv").textContent=S.simplify+" m";
  $("round").checked=false;
  ["trimS","trimE"].forEach(i=>{ $(i).value=0; $(i+"v").textContent="0 m"; });
  prepareRoute(); scheduleDraw();
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

/* Sign out of this app and of the Cloudflare Access team, so the next visit asks for email + code again. */
async function signOut(e){
  e.preventDefault();
  try{ await fetch("/cdn-cgi/access/logout",{credentials:"include",redirect:"manual",cache:"no-store"}); }catch(err){}
  const team=SCH.data && SCH.data.me && SCH.data.me.team;
  location.href = team ? `${team}/cdn-cgi/access/logout` : "/cdn-cgi/access/logout";
}

function init(){
  loadPrefs();
  $("signout").addEventListener("click",signOut);
  showWhoAmI();
  initSchedule();
  loadSchedule();
  seg("fmt","fmt");
  seg("color","color",savePrefs);
  range("zoom","zoom",v=>v+"%",v=>v/100);
  range("width","width",v=>v,Number);
  range("simplify","simplify",v=>v+" m",Number,prepareRoute);
  range("trimS","trimS",v=>v+" m",Number,prepareRoute);
  range("trimE","trimE",v=>v+" m",Number,prepareRoute);
  $("round").addEventListener("change",e=>{S.round=e.target.checked; scheduleDraw();});
  $("advreset").addEventListener("click",resetAdvanced);
  $("beerreset").addEventListener("click",()=>{ delete S.beer[S.fmt]; syncBeerControls(); scheduleDraw(); });
  $("beersize").addEventListener("input",e=>setBeer({scale:e.target.value/100}));
  $("beerrot").addEventListener("input",e=>setBeer({rot:Number(e.target.value)}));
  $("fmt").addEventListener("click",()=>setTimeout(syncBeerControls,0));
  ["title","date"].forEach(i=>$(i).addEventListener("input",scheduleDraw));
  $("gpx").addEventListener("change",e=>{ const f=e.target.files[0]; if(f) loadFile(f); e.target.value=""; });
  $("gpx2").addEventListener("change",e=>{ const f=e.target.files[0]; if(f) loadSecond(f); e.target.value=""; });
  $("route2remove").addEventListener("click",()=>{ S.routes=S.routes.slice(0,1); routesChanged(); });
  const drop=$("drop");
  ["dragenter","dragover"].forEach(t=>drop.addEventListener(t,e=>{e.preventDefault(); drop.classList.add("over");}));
  ["dragleave","drop"].forEach(t=>drop.addEventListener(t,e=>{e.preventDefault(); drop.classList.remove("over");}));
  drop.addEventListener("drop",e=>{ const f=e.dataTransfer.files[0]; if(f) loadFile(f); });
  $("save").addEventListener("click",download);
  $("share").addEventListener("click",share);

  // One finger: drag the map, or FREE BEER! when the finger starts on it.
  // Two fingers: pinch the map to zoom, or turn + resize FREE BEER! when the gesture started on it.
  const ptrs=new Map(); let last=null, g0=null, beerMode=false;
  const toCanvas=(x,y)=>{ const r=cv.getBoundingClientRect(), k=cv.width/r.width; return {x:(x-r.left)*k, y:(y-r.top)*k}; };
  const onBeer=(x,y)=>{ const h=S.beerHit; if(!h) return false; const c=toCanvas(x,y); return Math.hypot(c.x-h.cx,c.y-h.cy) < h.r+40; };
  const twoFinger=()=>{ const [a,b]=[...ptrs.values()]; return {d:Math.hypot(a.x-b.x,a.y-b.y), ang:Math.atan2(b.y-a.y,b.x-a.x)}; };
  cv.addEventListener("pointerdown",e=>{ try{ cv.setPointerCapture(e.pointerId); }catch(err){} ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY}); cv.classList.add("dragging");
    if(ptrs.size===1) beerMode=onBeer(e.clientX,e.clientY);
    if(ptrs.size===2){ const t=twoFinger(); const bs=beerState(); g0={d:t.d, ang:t.ang, zoom:S.zoom, scale:bs.scale, rot:bs.rot}; }
    last={x:e.clientX,y:e.clientY}; });
  cv.addEventListener("pointermove",e=>{ if(!ptrs.has(e.pointerId)||!S.view) return; ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY});
    const k=cv.width/cv.getBoundingClientRect().width;
    if(ptrs.size===2 && g0){ const t=twoFinger();
      if(beerMode){ setBeer({scale:g0.scale*t.d/g0.d, rot:g0.rot+(t.ang-g0.ang)*180/Math.PI}); return; }
      const z=Math.max(.5,Math.min(2,g0.zoom*t.d/g0.d));
      S.zoom=z; $("zoom").value=Math.round(z*100); $("zoomv").textContent=Math.round(z*100)+"%"; scheduleDraw(); return; }
    if(ptrs.size===1 && last){
      const dx=(e.clientX-last.x)*k, dy=(e.clientY-last.y)*k; last={x:e.clientX,y:e.clientY};
      if(beerMode){ const b=beerState(); setBeer({x:b.x+dx, y:b.y+dy}); }
      else { S.pan.x+=dx/S.view.scale; S.pan.y+=dy/S.view.scale; scheduleDraw(); }
    } });
  const up=e=>{ ptrs.delete(e.pointerId); if(ptrs.size<2) g0=null; if(!ptrs.size){ last=null; beerMode=false; cv.classList.remove("dragging"); } else { const v=[...ptrs.values()][0]; last={x:v.x,y:v.y}; } };
  cv.addEventListener("pointerup",up); cv.addEventListener("pointercancel",up);
  document.fonts.load('60px "MikkelWind"');
}

/* The route post takes its date from the next run in the schedule. */
function fillFromSchedule(onLoad){
  const n=nextRun();
  const hint=$("nextrun-hint");
  if(n){ const l=captain(n.lead); hint.textContent=`Next run: ${niceDate(n.date)}, ${n.time}${l?` · led by ${l.name}`:" · no lead picked yet"}`; } else hint.textContent="";
  if(onLoad && n) $("date").value=n.date;
}

init();
