/* ==========================================================================
   FIREBASE : comptes et progression, sans serveur à soi
   Ce fichier répond à acctApi (09j-compte.js) à la place de l'ancien serveur de comptes (api/, Vercel + Postgres) : acctApi lui passe le nom de
   la route (me, register, login...) et reçoit la même forme de réponse { ok, status, data }. Tout passe par les API REST de Firebase, sans
   bibliothèque :
   - Authentication : e-mail et mot de passe. Le mot de passe oublié et le changement de mot de passe sont ceux de Firebase (le message
     de récupération est envoyé par Firebase) ;
   - Realtime Database : /usernames/<nom> (identifiant public, unique) et /users/<uid> (profil, XP, statistiques, arsenal).
   Les règles de sécurité à coller dans la console sont dans firebase/database.rules.json. L'XP se calcule ici, dans le navigateur, avec les
   mêmes règles qu'avant (06r-arsenal.js, arsLocalXp) ; les règles de la base bornent ce qu'une partie peut ajouter.
   Routes prises en charge : me, register, login, logout, profile, password-change, password-reset, account-delete, arsenal, match-start,
   match-end. Les autres (amis, communauté, modération, photo) répondent « pas encore disponible ».
   FB.db vide : comptes indisponibles, le jeu se joue sans compte.
   ========================================================================== */
const FB = {
  key: 'AIzaSyAg0W_ca61GMrLUoR9C38S0miBsggVzEeE', // clé web du projet fpsshoter (publique par conception)
  db: 'https://fpsshoter-default-rtdb.firebaseio.com', // adresse de la Realtime Database (console Firebase, Realtime Database, onglet Données) ; vide : comptes indisponibles
};

/* ---------- Session : jetons gardés sur l'appareil ---------- */
const FB_KEY = 'dc_fb';
let FB_SESS;
function fbSess() {
  if (FB_SESS === undefined) {
    try { FB_SESS = JSON.parse(localStorage.getItem(FB_KEY) || 'null'); } catch (e) { FB_SESS = null; }
    if (!(FB_SESS && FB_SESS.uid && FB_SESS.refresh)) FB_SESS = null;
  }
  return FB_SESS;
}
function fbSessSet(s) {
  FB_SESS = s || null;
  try { if (s) localStorage.setItem(FB_KEY, JSON.stringify(s)); else localStorage.removeItem(FB_KEY); } catch (e) { /* stockage indisponible : la session ne dure que cette page */ }
}
function fbSessFrom(d, mail) { return { uid: d.localId, email: d.email || mail, refresh: d.refreshToken, id: d.idToken, exp: Date.now() + (+d.expiresIn || 3600) * 1000 }; }

/* ---------- Appels réseau ---------- */
/* { ok, status, data } ; jamais d'exception (réseau coupé : status 0) */
async function fbFetch(url, opt, ms) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), ms || 12000);
  try {
    const r = await fetch(url, { ...opt, signal: ctl.signal });
    let data = null; try { data = await r.json(); } catch (e) { /* réponse sans corps */ }
    return { ok: r.ok, status: r.status, data };
  } catch (e) { return { ok: false, status: 0, data: null }; } finally { clearTimeout(to); }
}
function fbAuth(method, body, ms) {
  return fbFetch('https://identitytoolkit.googleapis.com/v1/accounts:' + method + '?key=' + FB.key,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Firebase-Locale': LANG === 'en' ? 'en' : 'fr' }, body: JSON.stringify(body) }, ms);
}
const fbBase = () => (FB.db.endsWith('/') ? FB.db.slice(0, -1) : FB.db);
/* Realtime Database : tok absent pour une lecture publique (/usernames/<nom>) */
function fbDb(path, method, tok, body, ms) {
  return fbFetch(fbBase() + '/' + path + '.json' + (tok ? '?auth=' + encodeURIComponent(tok) : ''),
    { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, ms);
}
/* Jeton d'accès valide : renouvelé une minute avant la fin ; null si la session est perdue (révoquée) ou si le réseau manque (la session reste) */
async function fbToken() {
  const s = fbSess(); if (!s) return null;
  if (s.exp > Date.now() + 60000) return s.id;
  const r = await fbFetch('https://securetoken.googleapis.com/v1/token?key=' + FB.key,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(s.refresh) });
  if (r.ok && r.data && r.data.id_token) {
    fbSessSet({ uid: r.data.user_id || s.uid, email: s.email, refresh: r.data.refresh_token || s.refresh, id: r.data.id_token, exp: Date.now() + (+r.data.expires_in || 3600) * 1000 });
    return r.data.id_token;
  }
  if (r.status >= 400 && r.status < 500) fbSessSet(null); // session révoquée ou compte supprimé
  return null;
}

/* ---------- Réponses ---------- */
const fbOff = () => ({ ok: false, status: 0, data: null });
const fbOk = (data) => ({ ok: true, status: 200, data });
const fbBad = (text) => ({ ok: false, status: 422, data: { error: text } });
const fbNoSession = () => ({ ok: false, status: 401, data: { error: _t('Votre session a expiré. Reconnectez-vous.') } });
function fbMsg(r) {
  const code = String((r.data && r.data.error && r.data.error.message) || '').split(' ')[0];
  const wrong = _t('E-mail ou mot de passe incorrect.');
  const T = {
    EMAIL_EXISTS: _t('Cet e-mail est déjà utilisé.'),
    INVALID_EMAIL: _t('Adresse e-mail invalide.'),
    MISSING_EMAIL: _t('Adresse e-mail invalide.'),
    WEAK_PASSWORD: _t('Mot de passe trop court (8 caractères au moins).'),
    INVALID_LOGIN_CREDENTIALS: wrong, INVALID_PASSWORD: wrong, EMAIL_NOT_FOUND: wrong,
    USER_DISABLED: _t('Ce compte est désactivé.'),
    TOO_MANY_ATTEMPTS_TRY_LATER: _t('Trop d\x27essais. Réessayez dans quelques minutes.'),
    OPERATION_NOT_ALLOWED: _t('La connexion par e-mail n\x27est pas activée pour ce jeu.'),
  };
  return hasKey(T, code) ? T[code] : _t('Une erreur est survenue.');
}
const fbFail = (r) => (r.status === 0 ? r : { ok: false, status: r.status || 400, data: { error: fbMsg(r) } });
const FB_MAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------- Profil, niveau, statistiques ---------- */
const FB_STATS = ['kills', 'deaths', 'assists', 'wins', 'matches', 'shots', 'hits', 'headshots', 'bestStreak', 'seconds'];
function fbStats(s) { const o = {}; for (const k of FB_STATS) o[k] = Math.max(0, Math.floor(+(s && s[k]) || 0)); return o; }
function fbRecent(r) { const a = Array.isArray(r) ? r : r && typeof r === 'object' ? Object.values(r) : []; return a.filter(Boolean).slice(0, 10); }
function fbLevel(xp) {
  const l = levelOfXp(xp), a = pxpForLevel(l), b = l < 100 ? pxpForLevel(l + 1) : 0;
  return { level: l, into: xp - a, need: b ? b - a : 0, xp };
}
/* Ce que le jeu attend de /me : le compte, le niveau, les statistiques et les dernières parties */
function fbOut(p, s) {
  return {
    user: { username: p.username, displayName: p.displayName || p.username, email: s.email, avatar: 0, hasPassword: true, hasRecovery: true, moderator: false, modOpen: 0 },
    level: fbLevel(Math.max(0, Math.floor(+p.xp || 0))), stats: fbStats(p.stats), recent: fbRecent(p.recent),
  };
}
async function fbLoad(s, tok) {
  const r = await fbDb('users/' + s.uid, 'GET', tok);
  if (r.status === 0) return fbOff();
  if (!r.ok) return fbFail(r);
  if (!r.data || !r.data.username) return { ok: false, status: 404, data: { error: _t('Profil introuvable pour ce compte.') } };
  return fbOk(fbOut(r.data, s));
}
/* Appelle fn(session, jeton) avec une session valide ; sans session : 401, sans réseau : status 0 */
async function fbWith(fn) {
  if (!fbSess()) return fbNoSession();
  const tok = await fbToken();
  if (!tok) return fbSess() ? fbOff() : fbNoSession();
  return fn(fbSess(), tok);
}

/* ---------- Routes ---------- */
async function fbMe() {
  if (!fbSess()) return fbOk({ user: null, level: null, stats: null, recent: [] });
  return fbWith((s, tok) => fbLoad(s, tok));
}
async function fbRegister(b) {
  const name = String(b.username || '').trim().toLowerCase(), mail = String(b.email || '').trim(), pw = String(b.password || '');
  if (!/^[a-z0-9_]{3,16}$/.test(name)) return fbBad(_t('Nom d\x27utilisateur invalide (3 à 16 caractères, lettres sans accent, chiffres ou tiret bas).'));
  if (filtreNom(name)) return fbBad(_t('Ce nom d\x27utilisateur n\x27est pas accepté.'));
  if (!FB_MAIL.test(mail)) return fbBad(_t('Adresse e-mail invalide.'));
  if (pw.length < 8) return fbBad(_t('Mot de passe trop court (8 caractères au moins).'));
  if (!b.accept) return fbBad(_t('Vous devez accepter les conditions pour créer un compte.'));
  const free = await fbDb('usernames/' + name, 'GET');
  if (free.status === 0) return fbOff();
  if (free.ok && free.data !== null) return fbBad(_t('Ce nom d\x27utilisateur est déjà pris.'));
  const a = await fbAuth('signUp', { email: mail, password: pw, returnSecureToken: true });
  if (!a.ok) return fbFail(a);
  const s = fbSessFrom(a.data, mail); fbSessSet(s);
  const undo = async () => { await fbAuth('delete', { idToken: s.id }); fbSessSet(null); }; // le compte Firebase ne reste pas sans profil
  const c = await fbDb('usernames/' + name, 'PUT', s.id, s.uid); // réserve le nom : refusé s'il vient d'être pris
  if (!c.ok) { await undo(); return c.status === 0 ? fbOff() : fbBad(_t('Ce nom d\x27utilisateur est déjà pris.')); }
  const p = { username: name, displayName: name, created: Date.now(), xp: 0, stats: fbStats(null) };
  const w = await fbDb('users/' + s.uid, 'PUT', s.id, p);
  if (!w.ok) { await fbDb('usernames/' + name, 'DELETE', s.id); await undo(); return w.status === 0 ? fbOff() : fbFail(w); }
  return fbOk(fbOut(p, s));
}
async function fbLogin(b) {
  const mail = String(b.login || '').trim(), pw = String(b.password || '');
  if (!FB_MAIL.test(mail)) return fbBad(_t('Adresse e-mail invalide.'));
  const a = await fbAuth('signInWithPassword', { email: mail, password: pw, returnSecureToken: true });
  if (!a.ok) return fbFail(a);
  const s = fbSessFrom(a.data, mail); fbSessSet(s);
  const m = await fbLoad(s, s.id);
  if (!m.ok) fbSessSet(null);
  return m;
}
async function fbLogout() { fbSessSet(null); return fbOk({}); }
function fbProfile(b) {
  return fbWith(async (s, tok) => {
    const n = String(b.displayName || '').replace(/[\x00-\x1f<>]/g, '').trim().slice(0, 16);
    if (!n) return fbBad(_t('Le nom d\x27affichage ne peut pas être vide.'));
    if (filtreNom(n)) return fbBad(_t('Ce nom d\x27affichage n\x27est pas accepté.'));
    const w = await fbDb('users/' + s.uid, 'PATCH', tok, { displayName: n });
    if (!w.ok) return fbFail(w);
    return fbLoad(s, tok);
  });
}
/* Changer le mot de passe : Firebase demande une connexion récente, le mot de passe actuel est donc vérifié d'abord */
async function fbPasswordChange(b) {
  const s = fbSess(); if (!s) return fbNoSession();
  const next = String(b.next || '');
  if (next.length < 8) return fbBad(_t('Mot de passe trop court (8 caractères au moins).'));
  const a = await fbAuth('signInWithPassword', { email: s.email, password: String(b.current || ''), returnSecureToken: true });
  if (!a.ok) return a.status === 0 ? fbOff() : fbBad(_t('Mot de passe actuel incorrect.'));
  const u = await fbAuth('update', { idToken: a.data.idToken, password: next, returnSecureToken: true });
  if (!u.ok) return fbFail(u);
  const s2 = fbSessFrom(u.data, s.email); fbSessSet(s2);
  return fbLoad(s2, s2.id);
}
/* Mot de passe oublié : le message avec le lien est envoyé par Firebase. Même réponse que l'e-mail existe ou non */
async function fbPasswordReset(b) {
  const mail = String(b.email || '').trim();
  if (!FB_MAIL.test(mail)) return fbBad(_t('Adresse e-mail invalide.'));
  const r = await fbAuth('sendOobCode', { requestType: 'PASSWORD_RESET', email: mail });
  if (r.status === 0) return fbOff();
  const code = String((r.data && r.data.error && r.data.error.message) || '');
  if (!r.ok && code.indexOf('EMAIL_NOT_FOUND') !== 0) return fbFail(r);
  return fbOk({ sent: true });
}
async function fbAccountDelete(b) {
  const m = await fbWith((s, tok) => fbLoad(s, tok));
  if (!m.ok) return m;
  const s = fbSess(), name = m.data.user.username;
  if (String(b.confirm || '').trim().toLowerCase() !== name) return fbBad(_t('Le nom d\x27utilisateur saisi ne correspond pas.'));
  const a = await fbAuth('signInWithPassword', { email: s.email, password: String(b.password || ''), returnSecureToken: true });
  if (!a.ok) return a.status === 0 ? fbOff() : fbBad(_t('Mot de passe actuel incorrect.'));
  const t = a.data.idToken;
  await fbDb('users/' + s.uid, 'DELETE', t);
  await fbDb('usernames/' + name, 'DELETE', t);
  const d = await fbAuth('delete', { idToken: t });
  if (!d.ok) return fbFail(d);
  fbSessSet(null);
  return fbOk({});
}
/* Arsenal : { data } l'enregistre, {} le lit. Rangé en texte JSON : la base ne garde ni les tableaux troués ni les valeurs nulles */
function fbArsenal(b) {
  return fbWith(async (s, tok) => {
    if (b.data !== undefined) {
      const w = await fbDb('users/' + s.uid + '/arsenal', 'PUT', tok, JSON.stringify(b.data));
      return w.ok ? fbOk({}) : fbFail(w);
    }
    const r = await fbDb('users/' + s.uid + '/arsenal', 'GET', tok);
    if (!r.ok) return fbFail(r);
    let d = null; try { d = typeof r.data === 'string' ? JSON.parse(r.data) : null; } catch (e) { d = null; }
    return fbOk({ data: d });
  });
}
/* Ouverture d'une partie : le « jeton » est l'heure de départ, qui borne la durée que le résumé pourra annoncer */
async function fbMatchStart() { return fbSess() ? fbOk({ token: String(Date.now()) }) : fbNoSession(); }
function fbMatchEnd(b) {
  return fbWith(async (s, tok) => {
    const m = b.summary || {}, num = (v, max) => Math.max(0, Math.min(max, Math.floor(+v || 0)));
    const t0 = +b.token || 0, real = t0 > 0 ? Math.floor((Date.now() - t0) / 1000) + 5 : 0;
    const dur = Math.min(num(m.duration, 86400), real);
    const kills = num(m.kills, 500), deaths = num(m.deaths, 500), assists = num(m.assists, 500);
    const head = Math.min(num(m.headshots, 500), kills), shots = num(m.shots, 50000), hits = Math.min(num(m.hits, 50000), shots), streak = Math.min(num(m.streak, 500), kills);
    const res = ['win', 'loss', 'draw', 'quit'].indexOf(m.result) >= 0 ? m.result : 'quit', online = !!m.online;
    const r = await fbDb('users/' + s.uid, 'GET', tok);
    if (!r.ok || !r.data) return fbFail(r);
    const p = r.data, xp0 = Math.max(0, Math.floor(+p.xp || 0)), before = fbLevel(xp0);
    if (dur < 30) return fbOk({ level: before, stats: fbStats(p.stats), recent: fbRecent(p.recent), gained: 0, levelUp: 0 }); // une partie de moins de 30 s ne compte pas
    // mêmes règles que l'XP hors compte (06r-arsenal.js, arsLocalXp) : la moitié en solo, 2500 au plus
    let gained = kills * 50 + head * 15 + assists * 20 + Math.floor(dur / 60) * 20 + 100 + (res === 'win' ? 150 : res === 'draw' ? 50 : 0);
    if (!online) gained *= 0.5;
    gained = Math.min(2500, Math.round(gained));
    const st = fbStats(p.stats);
    st.matches += 1; if (res === 'win') st.wins += 1;
    st.kills += kills; st.deaths += deaths; st.assists += assists; st.headshots += head; st.shots += shots; st.hits += hits; st.seconds += dur;
    st.bestStreak = Math.max(st.bestStreak, streak);
    const recent = [{ map: String(m.map || '').slice(0, 40), mode: String(m.mode || 'tdm').slice(0, 20), result: res, online, kills, deaths, xp: gained, played_at: new Date().toISOString() }]
      .concat(fbRecent(p.recent)).slice(0, 10);
    const xp = xp0 + gained;
    const w = await fbDb('users/' + s.uid, 'PATCH', tok, { xp, stats: st, recent });
    if (!w.ok) return fbFail(w);
    const L = fbLevel(xp);
    return fbOk({ level: L, stats: st, recent, gained, levelUp: L.level - before.level });
  });
}

/* Export des données du compte (Profil, « Télécharger mes données ») : un Blob JSON, ou null */
async function fbExport() {
  const s = fbSess(), tok = await fbToken();
  if (!s || !tok) return null;
  const r = await fbDb('users/' + s.uid, 'GET', tok);
  if (!r.ok || !r.data) return null;
  return new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), email: s.email, uid: s.uid, profile: r.data }, null, 2) + '\n'], { type: 'application/json' });
}
const FB_ROUTES = {
  me: fbMe, register: fbRegister, login: fbLogin, logout: fbLogout, profile: fbProfile,
  'password-change': fbPasswordChange, 'password-reset': fbPasswordReset, 'account-delete': fbAccountDelete,
  arsenal: fbArsenal, 'match-start': fbMatchStart, 'match-end': fbMatchEnd,
};
