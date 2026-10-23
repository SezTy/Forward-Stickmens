// Serveur : node server.js  (npm i ws)   — le client est dans public/index.html
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 2010;
const MAXP = 8, MINP = 2;                 // joueurs max / min pour lancer
const LEN = 240, IN = 22, GOAL = 4000;    // longueur plateforme, marge des stickmen, distance arrivée
const FLOOR = 210, CEIL = -250;           // sol et plafond du couloir
const ACC = 220, FR = 0.95, DT = 1 / 30;  // poussée par joueur, frottement, pas de temps
const GRAV = 105;                         // gravité : sans poussée vers le haut, la plateforme tombe
const WACC = 150;                         // force maximale d'une rafale
const WDIRS = [0, 0, Math.PI, -Math.PI / 2, -Math.PI / 4, Math.PI / 6, -3 * Math.PI / 4]; // directions possibles du vent
const MV = 110, JV = 300, GJ = 900;        // vitesse de marche, impulsion de saut, gravité du saut (stickmen)
const BR = 9, ENX = 380;                  // rayon des boulets, distance de la plateforme ennemie
const LEVR = 15, PZ = 2.5;                // rayon d'action du levier (px), durée de paralysie (s)
const BG = 140, KS = 1.3;                 // gravité des boulets (sauf rouges) ; pente de l'exponentielle vitesse / charge                  // rayon des boulets, distance de la plateforme ennemie
const BACK = 8000;                        // délai avant retour au salon (ms)
const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0cb7c9', '#f032e6', '#c8c800'];

const server = http.createServer((q, s) => {
  s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  s.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
});
const wss = new WebSocketServer({ server });
const rooms = new Map();
let nid = 1;

const send = (p, m) => p.ws.readyState === 1 && p.ws.send(JSON.stringify(m));
const bcast = (r, m) => r.players.forEach(p => send(p, m));
const pub = r => r.players.map(p => ({ id: p.id, name: p.name, color: p.color }));
const lobby = r => bcast(r, { k: 'lobby', code: r.code, host: r.players[0].id, playing: !!r.g, players: pub(r) });
// Directions (y positif = vers le bas) : éventail de -100° (presque tout droit vers le haut) à +10° (vers l'avant).
// Les premiers joueurs soulèvent la plateforme, les derniers la font avancer. (Même formule côté client.)
const dirs = n => n < 2 ? [-Math.PI / 2]
  : Array.from({ length: n }, (_, i) => (-100 + 110 * i / (n - 1)) * Math.PI / 180);

// Pupitre de chaque joueur sur la plateforme (décalage depuis le centre) et côté où il se tient
const slot = (i, n) => (n < 2 ? 0 : -LEN / 2 + IN + i * (LEN - 2 * IN) / (n - 1)) + 4;
const side = a => Math.cos(a) >= 0 ? 1 : -1;

wss.on('connection', ws => {
  const me = { id: nid++, ws, name: '', color: '', room: null };
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const r = me.room;
    if (m.k === 'create' || m.k === 'join') {
      if (r) return;
      me.name = String(m.name || '').trim().slice(0, 12) || 'Joueur';
      let room;
      if (m.k === 'create') {
        let c;
        do { c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join(''); } while (rooms.has(c));
        room = { code: c, players: [], g: null };
        rooms.set(c, room);
      } else {
        room = rooms.get(String(m.code || '').toUpperCase());
        if (!room) return send(me, { k: 'err', m: 'Room introuvable' });
        if (room.g) return send(me, { k: 'err', m: 'Partie en cours' });
        if (room.players.length >= MAXP) return send(me, { k: 'err', m: 'Room pleine' });
      }
      me.color = COLORS.find(c => !room.players.some(p => p.color === c));
      me.room = room; room.players.push(me);
      send(me, { k: 'me', id: me.id });
      lobby(room);
    } else if (!r) return;
    else if (m.k === 'kick' && r.players[0] === me && !r.g) {
      const t = r.players.find(p => p.id === m.id && p !== me);
      if (t) { send(t, { k: 'kicked' }); leave(t); }
    } else if (m.k === 'start' && r.players[0] === me && !r.g && r.players.length >= MINP) start(r);
    else if (m.k === 'in' && r.g && r.g.go) { const i = r.g.ids.indexOf(me.id); if (i >= 0) r.g.in[i] = { l: Math.sign(+m.l) || 0, sp: !!m.sp }; }
  });
  ws.on('close', () => leave(me));
});

function leave(p) {
  const r = p.room; if (!r) return;
  p.room = null;
  r.players = r.players.filter(x => x !== p);
  if (r.g) { const i = r.g.ids.indexOf(p.id); if (i >= 0) { r.g.alive[i] = false; r.g.press[i] = false; } }
  if (!r.players.length) { if (r.g) clearInterval(r.g.iv); rooms.delete(r.code); }
  else lobby(r); // le nouveau chef = le plus ancien restant
}

// Prochain tir : vert au début, de plus en plus d'orange / rouge, et des boulets magiques violets vers la fin
function plan(g) {
  const p = Math.min(1, g.t / 70), e = g.en;
  if (Math.random() < .04 + .26 * p) { e.kind = 1; e.thr = .85; }
  else { e.kind = 0; e.thr = Math.random() < .05 + .3 * p ? 1 : .12 + .78 * Math.pow(Math.random(), 1.4 + 2 * (1 - p)); }
}
function solve(v, D, h) { // angle de tir (haut positif) pour atteindre (D, h) avec la gravité ; null si hors de portée
  const d = v ** 4 - BG * (BG * D * D + 2 * h * v * v);
  return d < 0 ? null : Math.atan((v * v - Math.sqrt(d)) / (BG * D));
}
function fire(g, ch) {
  const en = g.en, live = g.alive.map((a, i) => a ? i : -1).filter(i => i >= 0);
  if (!live.length) return;
  const mx = en.x - 132, my = en.y - 27, T = i => [g.wx[i], g.wy[i] - 18];
  const purple = en.kind === 1, red = !purple && ch >= .97;
  const v = purple ? Math.min(300, 190 + g.t * 1.6) : Math.min(560, 420 + g.t * 2.5) * Math.exp(-KS * (1 - ch));
  const i = live[Math.random() * live.length | 0]; let vx, vy;
  if (purple) {
    const [tx, ty] = T(i), a = Math.atan2(ty - my, tx - mx); vx = Math.cos(a) * v * .6; vy = Math.sin(a) * v * .6;
    g.balls.push({ x: mx, y: my, vx, vy, hx: vx, hy: vy, k: 101, sp: v, tz: g.t + .2, side: Math.random() < .5 ? 1 : -1, age: 0, ti: i });
  } else if (red) {                                  // rouge : plein pot, en ligne droite (pas de gravité)
    const [tx, ty] = T(i), tf = Math.hypot(tx - mx, ty - my) / v;
    const a = Math.atan2(ty + g.vy * tf * .6 - my, tx + g.vx * tf * .6 - mx); vx = Math.cos(a) * v; vy = Math.sin(a) * v;
    g.balls.push({ x: mx, y: my, vx, vy, k: 100, gr: false });
  } else {                                           // vert / orange : tir en cloche, plus lent et plus court
    let best = null;
    for (const j of live.slice().sort(() => Math.random() - .5)) {
      let [tx, ty] = T(j), th = null;
      for (let it = 0; it < 2; it++) {
        const D = mx - tx, h = my - ty; if (D < 20) { th = null; break; }
        th = solve(v, D, h); if (th === null) break;
        const tf = D / (v * Math.cos(th)); tx = g.wx[j] + g.vx * tf * .6; ty = g.wy[j] - 18 + g.vy * tf * .6;
      }
      if (th !== null) { best = th; break; }
    }
    if (best === null) best = Math.PI / 4;           // hors de portée : le boulet retombe trop court
    vx = -Math.cos(best) * v; vy = -Math.sin(best) * v;
    g.balls.push({ x: mx, y: my, vx, vy, k: Math.round(ch * 100), gr: true });
  }
  en.a = Math.atan2(vy, vx); en.f = 0;
}

function start(r) {
  const n = r.players.length, a = dirs(n), R = (x, y) => x + Math.random() * (y - x);
  const intro = Math.round((0.2 + 0.22 * (n - 1) + 2.2 + 1.5) * 1000); // entrée des stickmen + compte à rebours
  // Objets à ramasser (0 bouclier, 1 turbo, 2 vie) : dans les airs ou au sol, hors de la plateforme
  const items = [];
  for (let x = 650; x < GOAL - 250; x += R(230, 330)) {
    const u = Math.random(), ty = u < .4 ? 0 : u < .75 ? 1 : 2;
    items.push({ x: Math.round(x), y: Math.random() < .4 ? FLOOR - 28 : Math.round(R(-170, 120)), ty, on: true });
  }
  const g = { ids: r.players.map(p => p.id), n, a, alive: Array(n).fill(true), press: Array(n).fill(false),
    x: 0, y: FLOOR - 12, vx: 0, vy: 0, t: 0, gt: 0, go: false, w: { a: null, s: 0, e: 0, next: 6 },
    wx: a.map((d, i) => slot(i, n) - 12 * side(d)), wy: Array(n).fill(FLOOR - 28), wv: Array(n).fill(0), wvx: Array(n).fill(0), st: Array(n).fill(true),
    sh: Array(n).fill(false), turbo: 0, items, ev: [],
    in: Array.from({ length: n }, () => ({ l: 0, sp: false })), el: Array(n).fill(0), par: Array(n).fill(0), psp: Array(n).fill(false),
    balls: [], en: { x: ENX, y: FLOOR - 70, a: Math.PI, f: 9, cs: 2.2, thr: .2, kind: 0, ch: -1 } };
  plan(g); r.g = g;
  bcast(r, { k: 'start', players: pub(r), a: g.a, items: items.map(i => [i.x, i.y, i.ty]), GOAL, LEN, IN, FLOOR, CEIL, intro });
  g.iv = setTimeout(() => { g.go = true; g.iv = setInterval(() => tick(r), DT * 1000); }, intro);
}

function tick(r) {
  const g = r.g, n = g.n, F = v => +v.toFixed(1), ev = g.ev = []; let fx = 0, fy = GRAV;
  const boost = g.t < g.turbo ? 1.6 : 1;
  // Intentions : ESPACE sur son pad = pousser ; ailleurs (plateforme ou sol) = sauter
  for (let i = 0; i < n; i++) {
    if (!g.alive[i]) { g.press[i] = false; continue; }
    const rin = g.in[i], paralyzed = g.t < g.par[i], inp = paralyzed ? { l: 0, sp: false } : rin, stx = slot(i, n) - 12 * side(g.a[i]);
    g.el[i] = inp.l;
    const onLev = g.st[i] && Math.abs(g.wx[i] - g.x - stx) < LEVR, grounded = !g.st[i] && g.wy[i] >= FLOOR - 0.5;
    if (inp.sp && !g.psp[i] && (grounded || (g.st[i] && !onLev))) { g.wv[i] = -JV; g.wvx[i] = g.st[i] ? g.vx : 0; g.st[i] = false; }
    g.psp[i] = rin.sp;
    g.press[i] = inp.sp && onLev;
    if (g.press[i]) { fx += Math.cos(g.a[i]) * ACC * boost; fy += Math.sin(g.a[i]) * ACC * boost; }
  }
  // Rafales : 1,2 s d'avertissement puis 3 s de vent (force en cloche), toutes les 3 à 7 s
  const w = g.w; let wk = 0, ww = 0;
  if (w.a === null && g.t >= w.next) { w.a = WDIRS[Math.random() * WDIRS.length | 0]; w.s = g.t + 1.2; w.e = w.s + 3; }
  if (w.a !== null) {
    if (g.t < w.s) ww = 1 - (w.s - g.t) / 1.2;
    else if (g.t < w.e) { wk = Math.sin(Math.PI * (g.t - w.s) / 3); fx += Math.cos(w.a) * WACC * wk; fy += Math.sin(w.a) * WACC * wk; }
    else { w.a = null; w.next = g.t + 3 + Math.random() * 4; }
  }
  const x0 = g.x;
  g.vx = (g.vx + fx * DT) * FR; g.vy = (g.vy + fy * DT) * FR;
  g.x += g.vx * DT; g.y += g.vy * DT; g.t += DT;
  if (g.x < 0) { g.x = 0; g.vx *= -0.3; }
  if (g.x > GOAL + 350) { g.x = GOAL + 350; g.vx = 0; }
  if (g.y < CEIL) { g.y = CEIL; g.vy *= -0.3; }
  const gy = FLOOR - 12, ground = g.y >= gy - 0.5;
  if (g.y > gy) { g.y = gy; g.vy = 0; }
  if (ground) g.vx *= 0.96;                       // frottement au sol
  // Stickmen : portés par la plateforme, ou libres (chute, saut, marche au sol)
  const dx = g.x - x0, sf = g.y - 16;
  for (let i = 0; i < n; i++) {
    if (!g.alive[i]) continue;
    let x = g.wx[i], y = g.wy[i];
    if (g.st[i]) { x += dx; y = sf; }
    x += g.el[i] * MV * DT;
    if (g.st[i] && Math.abs(x - g.x) > LEN / 2) { g.st[i] = false; g.wv[i] = 0; g.wvx[i] = g.vx; } // il passe le bord : il tombe
    if (!g.st[i]) {
      g.wv[i] += GJ * DT; y += g.wv[i] * DT; x += g.wvx[i] * DT; g.wvx[i] *= 0.985;
      if (g.wv[i] >= 0 && Math.abs(x - g.x) <= LEN / 2 && y >= sf && y - sf <= Math.max(8, g.wv[i] * DT * 2 + 6 + Math.max(0, g.vy * DT))) { y = sf; g.wv[i] = 0; g.st[i] = true; }
      else if (y >= FLOOR) { y = FLOOR; g.wv[i] = 0; g.wvx[i] = 0; }
      else if (y > g.y - 5 && y - 36 < g.y + 11 && Math.abs(x - g.x) < LEN / 2 + 7) x = x < g.x ? g.x - LEN / 2 - 7 : g.x + LEN / 2 + 7; // la plateforme est solide par les côtés
    }
    g.wx[i] = Math.max(g.x - 170, Math.min(g.x + 440, x)); g.wy[i] = y;
  }
  // Objets : bouclier, turbo (poussée x1,6 pendant 5 s), vie (ressuscite un stickman tombé)
  for (const it of g.items) {
    if (!it.on) continue;
    for (let i = 0; i < n; i++) {
      if (!g.alive[i]) continue;
      const cx = Math.max(g.wx[i] - 6, Math.min(g.wx[i] + 6, it.x)), cy = Math.max(g.wy[i] - 36, Math.min(g.wy[i], it.y));
      if (Math.hypot(it.x - cx, it.y - cy) >= 14) continue;
      it.on = false; ev.push([1, it.x, it.y, it.ty]);
      if (it.ty === 0) g.sh[i] = true;
      else if (it.ty === 1) g.turbo = Math.max(g.turbo, g.t) + 5;
      else {
        const d = g.alive.indexOf(false);
        if (d < 0) g.sh[i] = true;
        else { g.alive[d] = true; g.par[d] = 0; g.st[d] = true; g.wx[d] = g.x + slot(d, n) - 12 * side(g.a[d]); g.wy[d] = g.y - 16; g.wv[d] = 0; g.sh[d] = false; ev.push([5, g.wx[d], g.wy[d] - 18]); }
      }
      break;
    }
  }
  // Plateforme ennemie (automatique) : le canon se charge du vert à l'orange puis au rouge ; il tire quand il veut
  const en = g.en;
  en.x += (g.x + ENX - en.x) * 0.1;
  en.y += Math.max(-4, Math.min(4, (Math.max(CEIL + 30, Math.min(FLOOR - 12, g.y - 20 + Math.sin(g.t * .7) * 80)) - en.y) * 0.05));
  en.f += DT;
  const dur = Math.max(.9, 3.2 - g.t * .04), gap = Math.max(.5, 2.4 - g.t * .03);
  en.ch = g.t < en.cs ? -1 : Math.min(1, (g.t - en.cs) / dur);
  if (en.ch >= 0 && en.ch >= en.thr && g.t >= 3) { fire(g, en.ch); en.cs = g.t + gap; plan(g); }
  // Boulets : bouclier = bloqué ; sauter dessus les détruit ; touché de côté ou par au-dessus = mort
  g.balls = g.balls.filter(b => {
    if (b.k > 100) {                                  // boulet magique : zigzag aléatoire piloté par le sorcier
      b.age += DT;
      if (g.t >= b.tz) {
        if (!g.alive[b.ti]) { const lv = g.alive.map((a, i) => a ? i : -1).filter(i => i >= 0); if (!lv.length) return false; b.ti = lv[Math.random() * lv.length | 0]; }
        const base = Math.atan2(g.wy[b.ti] - 18 - b.y, g.wx[b.ti] - b.x), h = base + b.side * (.5 + Math.random() * .8);
        b.side *= -1; b.hx = Math.cos(h) * b.sp; b.hy = Math.sin(h) * b.sp; b.tz = g.t + .22 + Math.random() * .3;
      }
      b.vx += (b.hx - b.vx) * Math.min(1, DT * 9); b.vy += (b.hy - b.vy) * Math.min(1, DT * 9);
      if (b.age > 8 || b.x < g.x - 200) return false;          // disparaît en passant le bord gauche de l'écran
      b.y = Math.min(b.y, FLOOR - 6);
    } else if (b.gr) b.vy += BG * DT;
    b.x += b.vx * DT; b.y += b.vy * DT;
    if (b.x < g.x - 700 || b.x > g.x + 900 || b.y < -700) return false;
    if (b.k <= 100 && b.y > FLOOR - 4) { ev.push([2, b.x, FLOOR]); return false; }  // le boulet touche le sol
    if (b.k <= 100 && Math.abs(b.x - g.x) < LEN / 2 + BR && Math.abs(b.y - g.y) < 11 + BR) { g.vx -= 55; return false; } // choc contre la plateforme
    for (let i = 0; i < n; i++) {
      if (!g.alive[i]) continue;
      const sx = g.wx[i], fyy = g.wy[i];
      const cx = Math.max(sx - 6, Math.min(sx + 6, b.x)), cy = Math.max(fyy - 36, Math.min(fyy, b.y));
      if (Math.hypot(b.x - cx, b.y - cy) >= BR) continue;
      if (g.sh[i]) { g.sh[i] = false; ev.push([3, b.x, b.y]); return false; }
      if (!g.st[i] && g.wv[i] > 20 && fyy <= b.y + 2) { g.wv[i] = -230; ev.push([2, b.x, b.y]); return false; } // écrasé : le boulet disparaît, le stickman rebondit
      if (b.k > 100) { g.par[i] = g.t + PZ; ev.push([6, sx, fyy - 18]); return false; }   // boulet magique : paralyse au lieu de tuer
      g.alive[i] = false; ev.push([4, sx, fyy - 18]); return false;
    }
    return true;
  });
  // Poser la plateforme : au sol, dans la zone d'arrivée, quasi à l'arrêt, 1,5 s
  const ok = ground && Math.abs(g.x - GOAL) < 80 && Math.hypot(g.vx, g.vy) < 35;
  g.gt = ok ? g.gt + DT : Math.max(0, g.gt - DT);
  const left = g.alive.some(Boolean);
  bcast(r, { k: 's', t: +g.t.toFixed(2), x: F(g.x), y: F(g.y), vx: F(g.vx), vy: F(g.vy), al: g.alive.map(Number), pr: g.press.map(Number),
    gt: +g.gt.toFixed(2),
    pl: g.wx.map((x, i) => g.st[i] ? [F(x - g.x), 0, g.el[i], 1, 0] : [F(x), F(g.wy[i]), g.el[i], 0, Math.round(g.wvx[i])]),
    sh: g.sh.map(Number), pz: g.par.map(p => +Math.max(0, p - g.t).toFixed(1)), tb: +Math.max(0, g.turbo - g.t).toFixed(1), ic: g.items.map(i => i.on ? 1 : 0).join(''), ev,
    b: g.balls.map(b => [Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy), b.k]), en: [F(en.x), F(en.y), +en.a.toFixed(2), +en.f.toFixed(2), +en.ch.toFixed(2), en.kind],
    wa: w.a, wk: +wk.toFixed(2), ww: +ww.toFixed(2) });
  if (g.gt >= 1.5 || !left) {
    clearInterval(g.iv);
    bcast(r, { k: 'end', win: left, t: +g.t.toFixed(1), al: g.alive.map(Number), back: BACK });
    setTimeout(() => { if (rooms.get(r.code) === r) { r.g = null; if (r.players.length) lobby(r); } }, BACK);
  }
}

server.listen(PORT, () => console.log('http://localhost:' + PORT));
