// logic.js — módulo compartilhado (Firebase + UI helpers)

import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signOut,
  fetchSignInMethodsForEmail,
  createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  writeBatch,
  serverTimestamp,
  addDoc,
  collection,
  query,
  where,
  getDocs,
  limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

// Firebase config
export const firebaseConfig = {
  apiKey: "AIzaSyC7UJxBOViZj8ELjw-Xvy645QYfDfpBzxM",
  authDomain: "guilda-hubb.firebaseapp.com",
  projectId: "guilda-hubb",
  storageBucket: "guilda-hubb.firebasestorage.app",
  messagingSenderId: "117135418619",
  appId: "1:117135418619:web:e8ca8ec52eb0eeeff87c5e",
  measurementId: "G-9CHV67E64Y"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app);

// --- Contexto da Guilda -----------------------------------------------------
let __guildCtx = null;

const __GUILDCTX_LS_KEY = 'guildCtx_cache_v1';
try {
  const raw = localStorage.getItem(__GUILDCTX_LS_KEY);
  if (raw) {
    const cached = JSON.parse(raw);
    if (cached && cached.guildId && cached.uid && cached.email && cached.role) {
      __guildCtx = {
        guildId: String(cached.guildId),
        guildName: cached.guildName ? String(cached.guildName) : null,
        role: String(cached.role),
        email: String(cached.email),
        uid: String(cached.uid),
        vipTier: cached.vipTier ? String(cached.vipTier) : 'free'
      ,
        vipExpiresAtMs: (cached.vipExpiresAtMs != null ? Number(cached.vipExpiresAtMs) : null)};
    }
  }
} catch (_) {}

const __CEO_LS_KEY = 'ceo_cache_v1';
let __isCeo = false;
try {
  const raw = localStorage.getItem(__CEO_LS_KEY);
  if (raw) {
    const cached = JSON.parse(raw);
    if (cached && cached.email && cached.ts && (Date.now() - cached.ts) < 10 * 60 * 1000) {
      __isCeo = !!cached.isCeo;
    }
  }
} catch (_) {}


export function getGuildContext() {
  return __guildCtx;
}

export function getVipTier() {
  return (__guildCtx && __guildCtx.vipTier) ? String(__guildCtx.vipTier) : 'free';
}

export function getVipExpiresAtMs() {
  return (__guildCtx && __guildCtx.vipExpiresAtMs != null) ? Number(__guildCtx.vipExpiresAtMs) : null;
}


function __maybeDowngradeVipSync() {
  try {
    if (!__guildCtx) return;
    const tier = String(__guildCtx.vipTier || 'free');
    const exp = (__guildCtx.vipExpiresAtMs != null) ? Number(__guildCtx.vipExpiresAtMs) : null;
    if (tier !== 'free' && exp != null && isFinite(exp) && Date.now() > exp) {
      __guildCtx.vipTier = 'free';
      __guildCtx.vipExpiresAtMs = null;
      try {
        localStorage.setItem(__GUILDCTX_LS_KEY, JSON.stringify({
          guildId: __guildCtx.guildId,
          guildName: __guildCtx.guildName,
          role: __guildCtx.role,
          vipTier: __guildCtx.vipTier,
          vipExpiresAtMs: __guildCtx.vipExpiresAtMs,
          email: __guildCtx.email,
          uid: __guildCtx.uid,
          ts: Date.now()
        }));
      } catch (_) {}

      // tenta gravar no banco (não bloqueia UI)
      try {
        setDoc(doc(db, 'configGuilda', __guildCtx.guildId), { vipTier: 'free', vipExpiresAt: null, updatedAt: serverTimestamp() }, { merge: true });
      } catch (_) {}
      try {
        setDoc(doc(db, 'guildas', __guildCtx.guildId), { vipTier: 'free', updatedAt: serverTimestamp() }, { merge: true });
      } catch (_) {}
    }
  } catch (_) {}
}

export function getVipRemainingDays() {
  __maybeDowngradeVipSync();
  const ms = getVipExpiresAtMs();
  if (!ms) return null;
  const diff = ms - Date.now();
  if (!isFinite(diff)) return null;
  const days = Math.ceil(diff / 86400000);
  return Math.max(0, days);
}

function vipTierFromValue(v) {
  const s = (v || '').toString().toLowerCase().trim();
  if (!s || s === 'free') return 'free';
  if (s === 'business' || s === 'bussines' || s.includes('buss') || s.includes('business')) return 'business';
  if (s === 'pro' || s.includes('pro')) return 'pro';
  return 'plus';
}


function requireGuildId() {
  if (!__guildCtx || !__guildCtx.guildId) throw new Error("Guilda não resolvida. Faça login novamente.");
  return __guildCtx.guildId;
}

function cleanEmail(email) {
  return (email || "").toString().toLowerCase().trim();
}

function emailDocId(emailLower) {
  // Firestore doc IDs não aceitam '/', então usamos uma normalização simples.
  // Mantém estável para lookup futuro.
  return cleanEmail(emailLower).replaceAll('.', ',');
}

// --- Chefe (CEO) -----------------------------------------------------------
export function isCeo() {
  return !!__isCeo;
}

async function __refreshCeoStatus(emailLower) {
  const email = cleanEmail(emailLower);
  if (!email) return false;
  try {
    const snap = await getDoc(doc(db, "chefe", "security"));
    const data = snap.exists() ? (snap.data() || {}) : {};
    const list = Array.isArray(data.ceo) ? data.ceo : [];
    const ok = list.map(cleanEmail).includes(email);
    __isCeo = ok;
    try {
      localStorage.setItem(__CEO_LS_KEY, JSON.stringify({ email, isCeo: ok, ts: Date.now() }));
    } catch (_) {}
    return ok;
  } catch (_) {
    __isCeo = false;
    return false;
  }
}

export async function ensureCeoStatus() {
  try {
    const user = auth.currentUser;
    const email = cleanEmail(user?.email);
    return await __refreshCeoStatus(email);
  } catch (_) {
    return false;
  }
}

export function applyCeoNavVisibility() {
  try {
    document.querySelectorAll('[data-ceo-only="true"], #nav-chefe').forEach((el) => {
      if (!el) return;
      if (__isCeo) el.classList.remove('hidden');
      else el.classList.add('hidden');
    });
  } catch (_) {}
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const v of (arr || [])) {
    const s = (v || "").toString();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

async function getGuildName(guildId) {
  try {
    const snap = await getDoc(doc(db, "guildas", guildId));
    if (!snap.exists()) return null;
    const data = snap.data() || {};
    return (data.name || "").toString().trim() || null;
  } catch {
    return null;
  }
}

async function findGuildByEmail(emailLower) {
  if (!emailLower) return null;

  // 1) Tentativas rápidas (indexáveis) — requer que os e-mails estejam normalizados (lowercase) no Firestore
  try {
    const q1 = query(collection(db, "configGuilda"), where("leaders", "array-contains", emailLower), limit(1));
    const s1 = await getDocs(q1);
    if (!s1.empty) return { guildId: s1.docs[0].id, source: "leaders" };
  } catch (_) {}

  try {
    const q2 = query(collection(db, "configGuilda"), where("admins", "array-contains", emailLower), limit(1));
    const s2 = await getDocs(q2);
    if (!s2.empty) return { guildId: s2.docs[0].id, source: "admins" };
  } catch (_) {}

  try {
    const q3 = query(collection(db, "configGuilda"), where("ownerEmail", "==", emailLower), limit(1));
    const s3 = await getDocs(q3);
    if (!s3.empty) return { guildId: s3.docs[0].id, source: "ownerEmail" };
  } catch (_) {}

  try {
    const q4 = query(collection(db, "configGuilda"), where("playerEmail", "==", emailLower), limit(1));
    const s4 = await getDocs(q4);
    if (!s4.empty) return { guildId: s4.docs[0].id, source: "playerEmail" };
  } catch (_) {}

  // 2) Fallback robusto (varredura): cobre casos em que o Firestore tem e-mails salvos com maiúsculas/espacos,
  // e portanto "array-contains" / "==" não bate. Isso evita logout de admin/líder secundário.
  // Observação: ideal é salvar tudo em lowercase, mas isso resolve sem mexer no cadastro.
  try {
    const qAll = query(collection(db, "configGuilda"), limit(300));
    const snap = await getDocs(qAll);

    for (const d of snap.docs) {
      const data = d.data() || {};
      const leaders = Array.isArray(data.leaders) ? data.leaders : [];
      const admins  = Array.isArray(data.admins) ? data.admins : [];
      const ownerEmail = cleanEmail(data.ownerEmail);
      const playerEmail = cleanEmail(data.playerEmail);

      const leadersL = uniq(leaders.map((x) => cleanEmail(x))).filter(Boolean);
      const adminsL  = uniq(admins.map((x) => cleanEmail(x))).filter(Boolean);

      if (leadersL.includes(emailLower)) return { guildId: d.id, source: "scan-leaders" };
      if (adminsL.includes(emailLower))  return { guildId: d.id, source: "scan-admins" };
      if (ownerEmail && ownerEmail === emailLower) return { guildId: d.id, source: "scan-ownerEmail" };
      if (playerEmail && playerEmail === emailLower) return { guildId: d.id, source: "scan-playerEmail" };
    }
  } catch (_) {}

  return null;
}

async function resolveRoleInGuild(guildId, email) {
  const e = cleanEmail(email);
  if (!guildId || !e) return "Membro";

  try {
    const snap = await getDoc(doc(db, "configGuilda", guildId));
    if (snap.exists()) {
      const data = snap.data() || {};
      const leaders = Array.isArray(data.leaders) ? data.leaders : [];
      const admins = Array.isArray(data.admins) ? data.admins : [];

      const leadersL = uniq(leaders.map((x) => cleanEmail(x))).filter(Boolean);
      const adminsL = uniq(admins.map((x) => cleanEmail(x))).filter(Boolean);

      if (leadersL.includes(e)) return "Líder";
      if (adminsL.includes(e)) return "Admin";

      const playerEmail = cleanEmail(data.playerEmail);
      if (playerEmail && playerEmail === e) return "Jogador";
    }

    const g = await getDoc(doc(db, "guildas", guildId));
    if (g.exists()) {
      const gd = g.data() || {};
      const ownerEmail = cleanEmail(gd.ownerEmail);
      const ownerUid = (gd.ownerUid || "").toString().trim();
      if (ownerUid && ownerUid === auth.currentUser?.uid) return "Líder";
      if (ownerEmail && ownerEmail === e) return "Líder";
    }

    return "Membro";
  } catch {
    return "Membro";
  }
}

async function normalizeConfigGuilda(guildId) {
  try {
    const ref = doc(db, "configGuilda", guildId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;

    const data = snap.data() || {};
    const leaders = Array.isArray(data.leaders) ? data.leaders : [];
    const admins = Array.isArray(data.admins) ? data.admins : [];

    const leadersN = uniq(leaders.map((x) => cleanEmail(x))).filter(Boolean);
    const adminsN = uniq(admins.map((x) => cleanEmail(x))).filter(Boolean);
    const ownerEmailN = data.ownerEmail ? cleanEmail(data.ownerEmail) : null;

    const changed =
      JSON.stringify(leadersN) !== JSON.stringify(leaders) ||
      JSON.stringify(adminsN) !== JSON.stringify(admins) ||
      (data.ownerEmail ? ownerEmailN !== data.ownerEmail : false);

    if (!changed) return;

    await setDoc(ref, {
      ...(ownerEmailN ? { ownerEmail: ownerEmailN } : {}),
      leaders: leadersN,
      admins: adminsN,
      updatedAt: serverTimestamp()
    }, { merge: true });
  } catch (_) {}
}


// Bootstrap de primeira criação (signup): NÃO faz leituras antes, porque as regras
// podem bloquear read quando a guilda ainda não existe.
async function bootstrapNewGuildAndUser(user, username) {
  const uid = user.uid;
  const email = cleanEmail(user.email);
  const uname = (username || "").toString().trim();

  if (!uid) throw new Error("UID inválido.");
  if (!uname) throw new Error("Nome de guilda inválido.");

  const batch = writeBatch(db);

  // ✅ users/{uid}
  batch.set(doc(db, "users", uid), {
    uid,
    email,
    guildId: uid,
    role: "Líder",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  }, { merge: true });

  // ✅ guildas/{uid}
  batch.set(doc(db, "guildas", uid), {
    name: uname || "Minha Guilda",
    ownerUid: uid,
    ownerEmail: email,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  }, { merge: true });

  // ✅ configGuilda/{uid}
  batch.set(doc(db, "configGuilda", uid), {
    ownerUid: uid,
    ownerEmail: email,
    tagMembros: "",
    leaders: email ? [email] : [],
    admins: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  }, { merge: true });

  await batch.commit();
}

// Garantia leve (logins futuros do dono): não mexe no nome, só garante timestamps.
async function ensureOwnerDocsLight(user) {
  const uid = user.uid;
  if (!uid) return;

  const batch = writeBatch(db);
  batch.set(doc(db, "guildas", uid), { updatedAt: serverTimestamp() }, { merge: true });
  batch.set(doc(db, "configGuilda", uid), { updatedAt: serverTimestamp() }, { merge: true });
  batch.set(doc(db, "users", uid), { updatedAt: serverTimestamp() }, { merge: true });
  await batch.commit();
}

export async function finalizeSignup(user, username) {
  if (!user || !user.uid) throw new Error("Usuário inválido.");
  const uname = (username || "").toString().trim();
  if (!uname) throw new Error("Nome de usuário inválido.");

  await bootstrapNewGuildAndUser(user, uname);
  return { guildId: user.uid };
}

export async function getMemberTagConfig() {
  let guildId = null;
  try {
    guildId = requireGuildId();
  } catch (_) {
    return null;
  }

  try {
    const raw = localStorage.getItem(`tagMembros_${guildId}`);
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached?.value) return String(cached.value);
    }
  } catch (_) {}

  try {
    const snap = await getDoc(doc(db, "configGuilda", guildId));
    if (!snap.exists()) return null;
    const data = snap.data() || {};
    const tag = (data.tagMembros || "").toString().trim();
    if (tag) {
      try { localStorage.setItem(`tagMembros_${guildId}`, JSON.stringify({ value: tag, ts: Date.now() })); } catch (_) {}
      return tag;
    }
    return null;
  } catch (e) {
    return null;
  }
}

export async function setMemberTagConfig(tag) {
  const clean = (tag || "").toString().trim();
  if (!clean) throw new Error("Tag inválida.");

  const guildId = requireGuildId();
  await setDoc(
    doc(db, "configGuilda", guildId),
    { tagMembros: clean, updatedAt: serverTimestamp() },
    { merge: true }
  );
  try { localStorage.setItem(`tagMembros_${guildId}`, JSON.stringify({ value: clean, ts: Date.now() })); } catch (_) {}
  return true;
}

export function showToast(type = "info", message = "") {
  const containerId = "toast-container";
  let container = document.getElementById(containerId);
  if (!container) {
    container = document.createElement("div");
    container.id = containerId;
    container.className = "fixed top-4 right-4 z-[9999] flex flex-col gap-2";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className =
    "px-4 py-3 rounded-xl shadow-lg border text-sm font-medium flex items-start gap-2 max-w-[340px] " +
    (type === "success"
      ? "bg-emerald-50 text-emerald-800 border-emerald-200"
      : type === "error"
      ? "bg-red-50 text-red-800 border-red-200"
      : "bg-gray-900 text-white border-white/10");

  toast.innerHTML = `<div class="flex-1 leading-snug">${escapeHtml(message)}</div>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-4px)";
    toast.style.transition = "all 180ms ease";
  }, 2600);

  setTimeout(() => toast.remove(), 3000);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function createUpgradeSolicitacao(planId, payerName) {
  const user = auth.currentUser;
  if (!user) throw new Error("Você precisa estar logado para solicitar upgrade.");

  const plan = (planId || "").toString().toLowerCase().trim();
  if (!plan || !["plus", "pro", "business"].includes(plan)) {
    throw new Error("Plano inválido.");
  }

  const name = (payerName || "").toString().trim();
  if (!name) throw new Error("Informe o nome real do pagador.");

  const email = cleanEmail(user.email);
  const uid = user.uid;
  const guildId = (__guildCtx && __guildCtx.guildId) ? String(__guildCtx.guildId) : null;

  await addDoc(collection(db, "solicita"), {
    email,
    uid,
    plano: plan,
    nomePagador: name,
    ...(guildId ? { guildId } : {}),
    status: "pendente",
    createdAt: serverTimestamp()
  });

  return true;
}

export function checkAuth(redirectToLogin = true) {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      const isLoginPage = /index\.html$|\/$/i.test(window.location.pathname || "");

      if (!user) {
        if (redirectToLogin && !isLoginPage) window.location.href = "index.html";
        resolve(null);
        return;
      }

      const emailLower = cleanEmail(user.email);
      const emailEl = document.getElementById("user-email");
      if (emailEl) emailEl.textContent = user.email || "";

      let guildId = null;
      let username = "";

      // 0) Primeiro tenta resolver pela coleção /users (mais rápida e evita logout indevido)
      let roleHint = null;
      let userProfile = null;
      try {
        const uSnap = await getDoc(doc(db, "users", user.uid));
        if (uSnap.exists()) {
          userProfile = uSnap.data() || {};
          if (userProfile.guildId) guildId = String(userProfile.guildId);
          if (userProfile.role) roleHint = String(userProfile.role);
        }
      } catch (_) {}

      // Resolve a guilda SOMENTE pela configGuilda.

      // - Contas secundárias (admin/líder/jogador) precisam estar dentro dos arrays em /configGuilda/{guildId}
      // - O dono (guildId === uid) é criado no signup (finalizeSignup). Em logins futuros, também será resolvido.
      try {
        const found = await findGuildByEmail(emailLower);
        if (found?.guildId) guildId = found.guildId;
      } catch (_) {}

      // Se não achou por e-mail, só aceitamos como "dono" quando já existe configGuilda com id == uid.
      // Isso evita o bug de criar uma guilda nova ao logar com contas secundárias.
      if (!guildId) {
        try {
          const selfCfg = await getDoc(doc(db, "configGuilda", user.uid));
          if (selfCfg.exists()) guildId = user.uid;
        } catch (_) {}
      }

      // Se ainda não resolveu, a conta não está vinculada a nenhuma guilda -> não criar nada automaticamente.
      if (!guildId) {
        try { await signOut(auth); } catch (_) {}
        if (!isLoginPage) window.location.href = "index.html";
        resolve(null);
        return;
      }

      // Após o login: não tente ler antes de existir (regras podem bloquear).
      // Se for o dono (guildId === uid), apenas garante docs com merge sem mexer em nome.
      try {
        if (guildId === user.uid) {
          await ensureOwnerDocsLight(user);
        }
      } catch (e) {
        // Se falhar aqui, não derruba o login: isso é apenas uma garantia leve.
      }

      let role = null;

      // Se o /users já informa o role, usamos como base (e ainda tentamos confirmar via configGuilda).
      const hint = (roleHint || "").toString().trim();
      if (hint && ["Líder", "Admin", "Jogador"].includes(hint)) role = hint;

      const resolved = await resolveRoleInGuild(guildId, user.email || "");
      if (!role || role === "Membro") role = resolved;

      // Se o resolve der "Membro" por algum motivo, mas o /users diz que é Admin/Líder, não derruba o login.
      if (role === "Membro" && hint && hint !== "Membro") role = hint;
      if (role === "Líder") {
        normalizeConfigGuilda(guildId);
      }

      const guildName = await getGuildName(guildId);

      let vipTier = 'free';
      let vipExpiresAtMs = null;

      // Preferência: vipTier e vipExpiresAt vêm de /configGuilda/{guildId}
      try {
        const cfgSnap = await getDoc(doc(db, "configGuilda", guildId));
        if (cfgSnap.exists()) {
          const cfg = cfgSnap.data() || {};
          const rawVip = cfg.vipTier ?? cfg.vip ?? cfg.planoVip ?? cfg.planoVIP ?? cfg.vipLevel ?? cfg.vipPlano ?? cfg.vipName ?? cfg.plano ?? cfg.plan ?? cfg.tier;
          vipTier = vipTierFromValue(rawVip);

          // vipExpiresAt pode ser Timestamp, número (ms) ou string ISO — aceitamos qualquer um sem quebrar
          const rawExp = cfg.vipExpiresAt ?? cfg.vipExpiraEm ?? cfg.vipExpireAt ?? cfg.expiresAt ?? cfg.vipExpires;
          if (rawExp && typeof rawExp.toMillis === 'function') {
            vipExpiresAtMs = rawExp.toMillis();
          } else if (typeof rawExp === 'number') {
            vipExpiresAtMs = rawExp;
          } else if (typeof rawExp === 'string') {
            const t = Date.parse(rawExp);
            vipExpiresAtMs = isFinite(t) ? t : null;
          }
        }
      } catch (_) {}

      // Fallback: se configGuilda não tiver vipTier, tenta /guildas/{guildId}
      if (!vipTier || vipTier === 'free') {
        try {
          const gSnap = await getDoc(doc(db, "guildas", guildId));
          if (gSnap.exists()) {
            const g = gSnap.data() || {};
            const rawVip2 = g.vipTier ?? g.vip ?? g.planoVip ?? g.planoVIP ?? g.vipLevel ?? g.vipPlano ?? g.vipName ?? g.plano ?? g.plan ?? g.tier;
            const v2 = vipTierFromValue(rawVip2);
            if (v2) vipTier = v2;
          }
        } catch (_) {}
      }

      // ✅ Verificação automática de expiração (somente se vipExpiresAt existir)
      if (vipTier && vipTier !== 'free' && vipExpiresAtMs != null && isFinite(vipExpiresAtMs)) {
        if (Date.now() > vipExpiresAtMs) {
          vipTier = 'free';
          vipExpiresAtMs = null;

          // Tenta gravar no banco (não quebra caso não tenha permissão)
          try {
            await setDoc(doc(db, 'configGuilda', guildId), { vipTier: 'free', vipExpiresAt: null, updatedAt: serverTimestamp() }, { merge: true });
          } catch (_) {}
          try {
            await setDoc(doc(db, 'guildas', guildId), { vipTier: 'free', updatedAt: serverTimestamp() }, { merge: true });
          } catch (_) {}
        }
      }


      __guildCtx = {
        guildId,
        guildName,
        role,
        vipTier,
        vipExpiresAtMs,
        email: emailLower,
        uid: user.uid
      };

      try {
        localStorage.setItem(__GUILDCTX_LS_KEY, JSON.stringify({ guildId, guildName, role, vipTier, vipExpiresAtMs, email: emailLower, uid: user.uid, ts: Date.now() }));
      } catch (_) {}
      try { applyVipUiAndGates(vipTier); } catch (_) {}

      try { await __refreshCeoStatus(emailLower); } catch (_) {}
      try { applyCeoNavVisibility(); } catch (_) {}


      const roleEl = document.getElementById("user-role");
      if (roleEl) roleEl.textContent = role;

      const path = (window.location.pathname || "").toLowerCase();
      const isAdminPage = path.endsWith("/admin") || path.endsWith("/admin.html") || path.includes("admin.html");
      const isMembersPage = path.endsWith("/membros") || path.endsWith("/membros.html") || path.includes("membros.html");
      const isDashboardPage = path.endsWith("/dashboard") || path.endsWith("/dashboard.html") || path.includes("dashboard.html");
      const isSettingsPage = path.endsWith("/ajustes") || path.endsWith("/ajustes.html") || path.includes("ajustes.html");
      const isLinesPage = path.endsWith("/lines") || path.endsWith("/lines.html") || path.includes("lines.html");
      const isChefePage = path.endsWith("/chefe") || path.endsWith("/chefe.html") || path.includes("chefe.html");

      // (Fix) Algumas versões antigas tinham uma tela "camp". Aqui garantimos que a variável exista
      // para não quebrar o fluxo quando o role for "Admin".
      const isCampPage = path.endsWith("/camp") || path.endsWith("/camp.html") || path.includes("camp.html");

      if (role === "Membro") {
        // Só derruba o login quando NÃO existe vínculo em /users e o papel realmente não foi reconhecido.
        // Isso evita logout indevido de Admin/Líder secundário.
        const hasUserLink = !!(userProfile && userProfile.guildId);
        const hint = (roleHint || "").toString().trim();
        if (!hasUserLink && (!hint || hint === "Membro")) {
          try { await signOut(auth); } catch (_) {}
          if (!isLoginPage) window.location.href = "index.html";
          resolve(null);
          return;
        }
      }

      if (isChefePage && !__isCeo) {
        window.location.href = "dashboard.html";
        resolve(null);
        return;
      }

      
      if (role === "Jogador") {
        const isPlayerPage = path.endsWith("/jogador") || path.endsWith("/jogador.html") || path.includes("jogador.html");
        if (!isPlayerPage) {
          window.location.href = "jogador.html";
          resolve(null);
          return;
        }
        resolve(user);
        return;
      }

      if (role === "Admin") {
        if (isAdminPage || isCampPage) {
          window.location.href = "dashboard.html";
          resolve(null);
          return;
        }
        if (!isDashboardPage && !isMembersPage && !isSettingsPage && !isLinesPage) {
          window.location.href = "dashboard.html";
          resolve(null);
          return;
        }
      }

      resolve(user);
    });
  });
}


function normalizeVipTier(v) {
  const s = (v || '').toString().toLowerCase().trim();
  if (s.includes('buss') || s.includes('business')) return 'business';
  if (s.includes('pro')) return 'pro';
  if (s.includes('plus')) return 'plus';
  return 'free';
}

function __setDisabled(btn, disabled, reasonText) {
  if (!btn) return;
  btn.disabled = !!disabled;
  btn.classList.toggle("opacity-50", !!disabled);
  btn.classList.toggle("cursor-not-allowed", !!disabled);
  if (disabled) {
    btn.setAttribute("aria-disabled", "true");
    if (reasonText) btn.setAttribute("title", reasonText);
  } else {
    btn.removeAttribute("aria-disabled");
  }
}

function __setLockedLabel(btn, labelText) {
  if (!btn) return;
  btn.dataset.originalHtml = btn.dataset.originalHtml || btn.innerHTML;
  btn.innerHTML = `<span class="inline-flex items-center gap-2"><i data-lucide="lock" class="w-4 h-4"></i><span class="font-extrabold tracking-wide">${labelText}</span></span>`;
  try { if (window.lucide && typeof window.lucide.createIcons === "function") window.lucide.createIcons(); } catch (_) {}
}

function __restoreLabel(btn) {
  if (!btn) return;
  if (btn.dataset.originalHtml) btn.innerHTML = btn.dataset.originalHtml;
  try { if (window.lucide && typeof window.lucide.createIcons === "function") window.lucide.createIcons(); } catch (_) {}
}

function __ensureVipTagsIndex() {
  try {
    document.querySelectorAll("span").forEach((sp) => {
      if (sp.closest && sp.closest("#vip-label")) return;
      if (sp.dataset && sp.dataset.vipTag) return;
      const t = (sp.textContent || "").trim().toUpperCase();
      if (t === "PLUS") sp.dataset.vipTag = "plus";
      if (t === "PRO") sp.dataset.vipTag = "pro";
    });
  } catch (_) {}
}

export function applyVipUiAndGates(tierRaw) {
  const tier = normalizeVipTier(tierRaw || getVipTier());

  const vipLabel = document.getElementById("vip-label");
  if (vipLabel) {
    const days = getVipRemainingDays();
    const daysTxt = (tier !== 'free' && days != null) ? ` • ${days} dias` : '';
    vipLabel.innerHTML = `Guilda: <span class="font-bold text-gray-800">${tier.toUpperCase()}${daysTxt}</span>`;
  }

  __ensureVipTagsIndex();
  const showPlusTags = tier === "free";
  const showProTags = (tier !== "pro" && tier !== "business");
  document.querySelectorAll("[data-vip-tag]").forEach((el) => {
    const tag = (el.dataset.vipTag || "").toLowerCase();
    if (tag === "plus") el.style.display = showPlusTags ? "" : "none";
    if (tag === "pro") el.style.display = showProTags ? "" : "none";
  });

  const isPlusOrPro = tier !== "free";
  const isPro = (tier === "pro" || tier === "business");

  __setDisabled(document.getElementById("btn-add-admin"), !isPlusOrPro, "Recurso PLUS");
  __setDisabled(document.getElementById("btn-add-leader"), !isPlusOrPro, "Recurso PLUS");

  const __btnNewLine = document.getElementById("btn-new-line");
  const __btnSaveLine = document.getElementById("btn-save-line");

  if (__btnNewLine) {
    __setDisabled(__btnNewLine, false);
    __restoreLabel(__btnNewLine);
  }

  if (__btnSaveLine) {
    __setDisabled(__btnSaveLine, !isPlusOrPro, "Recurso PLUS");
    if (!isPlusOrPro) __setLockedLabel(__btnSaveLine, "PLUS");
    else __restoreLabel(__btnSaveLine);
  }

  __setDisabled(document.getElementById("btn-new-camp"), !isPro, "Recurso PRO (BETA)");
}

(function __vipAutoApply() {
  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => applyVipUiAndGates(getVipTier()));
    } else {
      applyVipUiAndGates(getVipTier());
    }
  } catch (_) {}
})();

export function setupSidebar() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebar-overlay");
  const btn = document.getElementById("mobile-menu-btn");

  if (!sidebar || !overlay || !btn) return;

  const open = () => {
    sidebar.classList.remove("-translate-x-full");
    overlay.classList.remove("hidden");
  };

  const close = () => {
    sidebar.classList.add("-translate-x-full");
    overlay.classList.add("hidden");
  };

  btn.addEventListener("click", open);
  overlay.addEventListener("click", close);

  sidebar.querySelectorAll("a[href]").forEach((a) => {
    a.addEventListener("click", () => {
      if (window.innerWidth < 1024) close();
    });
  });

  if (window.innerWidth < 1024) {
    sidebar.classList.add("-translate-x-full");
    overlay.classList.add("hidden");
  }
}

export function initIcons() {
  try {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons();
    }
  } catch (_) {}
}

export async function logout() {
  try {
    await signOut(auth);
  } finally {
    try {
      localStorage.removeItem(__GUILDCTX_LS_KEY);
      localStorage.removeItem("membersList");
      localStorage.removeItem("dashboard_stats");
      localStorage.removeItem("campsList");
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i) || "";
        if (k.startsWith("securityConfig_") || k.startsWith("tagMembros_")) {
          localStorage.removeItem(k);
        }
      }
    } catch (_) {}
    window.location.href = "index.html";
  }
}

export function consumeLoginToasts() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    if (params.get("login") !== "1") return;

    const email = (document.getElementById("user-email")?.textContent || auth.currentUser?.email || "").trim();
    const role = (document.getElementById("user-role")?.textContent || "Membro").trim();

    showToast("success", "Login realizado com sucesso!");
    showToast("info", `Perfil: ${role} • ${email}`);

    params.delete("login");
    const qs = params.toString();
    const newUrl = window.location.pathname + (qs ? `?${qs}` : "") + (window.location.hash || "");
    history.replaceState({}, "", newUrl);
  } catch (e) {}
}

export async function ensureUserAccount(email, password, opts = {}) {
  const e = cleanEmail(email);
  if (!e) throw new Error("E-mail inválido.");

  const methods = await fetchSignInMethodsForEmail(auth, e);
  if (methods && methods.length) {
    // Conta já existe.
    return { created: false, uid: null };
  }

  if (!password || String(password).length < 6) {
    throw new Error("Conta não existe. Informe uma senha (mínimo 6 caracteres) para criar.");
  }

  const secondaryName = "secondary_" + Date.now();
  const secondaryApp = initializeApp(firebaseConfig, secondaryName);
  const secondaryAuth = getAuth(secondaryApp);

  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, e, password);
    const uid = cred.user.uid;

    // Se foi criado a partir do Admin (conta secundária), cria/atualiza também em /users/{uid}
    // para o login conseguir resolver a guilda pelo documento do usuário.
    try {
      const guildId = opts && opts.guildId ? String(opts.guildId) : null;
      const role = opts && opts.role ? String(opts.role) : null;
      if (guildId) {
        await setDoc(doc(db, "users", uid), {
          email: e,
          guildId,
          role: role || "Membro",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }, { merge: true });
      }
    } catch (_) {}

    return { created: true, uid };
  } finally {
    try { await signOut(secondaryAuth); } catch (_) {}
    try { await deleteApp(secondaryApp); } catch (_) {}
  }
}

export async function createPlayer_DISABLED_BETAAccess(guildId, email, password) {
  if (!guildId) throw new Error("GuildId inválido.");
  email = cleanEmail(email || "");
  if (!email) throw new Error("Informe um e-mail válido para o Jogador.");

  if (!password || String(password).length < 6) {
    throw new Error("Defina uma senha com no mínimo 6 caracteres.");
  }

  const secondaryName = "secondary_player_" + Date.now();
  const secondaryApp = initializeApp(firebaseConfig, secondaryName);
  const secondaryAuth = getAuth(secondaryApp);

  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    const uid = cred.user.uid;

    await setDoc(doc(db, "configGuilda", guildId), {
      playerEmail: email,
      playerEnabled: true,
      playerCreatedAt: serverTimestamp()
    }, { merge: true });

    return { email, uid };
  } finally {
    try { await signOut(secondaryAuth); } catch (_) {}
    try { await deleteApp(secondaryApp); } catch (_) {}
  }
}

export async function revokePlayerAccess(guildId) {
  if (!guildId) throw new Error("GuildId inválido.");
  await setDoc(doc(db, "configGuilda", guildId), {
    playerEmail: null,
    playerEnabled: false,
    playerRevokedAt: serverTimestamp()
  }, { merge: true });
  return true;
}

export async function deletePlayerAccount(playerEmail, password) {
  const email = cleanEmail(playerEmail);
  if (!email) throw new Error("E-mail inválido.");
  if (!password || String(password).length < 6) throw new Error("Informe a senha do jogador (mínimo 6).");

  const secondaryName = "secondary_delete_" + Date.now();
  const secondaryApp = initializeApp(firebaseConfig, secondaryName);
  const secondaryAuth = getAuth(secondaryApp);

  try {
    const { signInWithEmailAndPassword } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
    const cred = await signInWithEmailAndPassword(secondaryAuth, email, password);
    const uid = cred.user.uid;

    await cred.user.delete();

    return { deleted: true };
  } finally {
    try { await signOut(secondaryAuth); } catch (_) {}
    try { await deleteApp(secondaryApp); } catch (_) {}
  }
}
