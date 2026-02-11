// logic.js — módulo compartilhado (Firebase + UI helpers)
// MODO "MULTI-USUÁRIO NA MESMA GUILDA" (por e-mail):
// - users/{uid} guarda guildId (id do doc em guildas/configGuilda)
// - guildas/{guildId} e configGuilda/{guildId} são da guilda (normalmente do líder principal)
// - Um usuário só acessa a guilda cujo guildId está no próprio users/{uid}
// - Se users/{uid} não existir, tentamos descobrir a guilda via e-mail em configGuilda (leaders/admins/ownerEmail)

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
  writeBatch,
  serverTimestamp,
  collection,
  query,
  where,
  getDocs,
  limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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

// --- Contexto da Guilda -----------------------------------------------------
let __guildCtx = null;

// --- Cache local do contexto da guilda (para evitar 'piscar' entre telas) ---
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
        uid: String(cached.uid)
      };
    }
  }
} catch (_) {}


// Retorna { guildId, guildName, role, email, uid }
export function getGuildContext() {
  return __guildCtx;
}

function requireGuildId() {
  if (!__guildCtx || !__guildCtx.guildId) throw new Error("Guilda não resolvida. Faça login novamente.");
  return __guildCtx.guildId;
}

function cleanEmail(email) {
  return (email || "").toString().toLowerCase().trim();
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

// Busca a guilda por e-mail nas listas de leaders/admins ou ownerEmail.
// Retorna { guildId, source } ou null.
async function findGuildByEmail(emailLower) {
  if (!emailLower) return null;

  // 1) leaders array-contains
  try {
    const q1 = query(collection(db, "configGuilda"), where("leaders", "array-contains", emailLower), limit(1));
    const s1 = await getDocs(q1);
    if (!s1.empty) return { guildId: s1.docs[0].id, source: "leaders" };
  } catch (_) {}

  // 2) admins array-contains
  try {
    const q2 = query(collection(db, "configGuilda"), where("admins", "array-contains", emailLower), limit(1));
    const s2 = await getDocs(q2);
    if (!s2.empty) return { guildId: s2.docs[0].id, source: "admins" };
  } catch (_) {}

  // 3) ownerEmail == email
  try {
    const q3 = query(collection(db, "configGuilda"), where("ownerEmail", "==", emailLower), limit(1));
    const s3 = await getDocs(q3);
    if (!s3.empty) return { guildId: s3.docs[0].id, source: "ownerEmail" };
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

    // fallback: ownerEmail/ownerUid do doc guildas
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

// Normaliza e-mails dentro de configGuilda (leaders/admins/ownerEmail) para lower-case.
// Só tenta escrever se houver mudança e se o usuário tiver permissão (líder).
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
  } catch (_) {
    // silêncio: se não tiver permissão, não queremos derrubar login
  }
}

// Garante docs base:
// - users/{uid} SEMPRE
// - guildas/{guildId} e configGuilda/{guildId} APENAS quando guildId == uid (dono/criador)
async function ensureBootstrapDocs(user, usernameMaybe, guildId) {
  const uid = user.uid;
  const email = cleanEmail(user.email);
  const uname = (usernameMaybe || "").toString().trim();

  const uRef = doc(db, "users", uid);
  const uSnap = await getDoc(uRef);

  // users/{uid}
  if (!uSnap.exists()) {
    await setDoc(uRef, {
      email,
      username: uname || null,
      guildId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
  } else {
    await setDoc(uRef, {
      ...(uname ? { username: uname } : {}),
      ...(guildId ? { guildId } : {}),
      updatedAt: serverTimestamp()
    }, { merge: true });
  }

  // Se este usuário é o dono (guildId == uid), cria/garante guildas/config
  if (guildId !== uid) return;

  const [gSnap, cSnap] = await Promise.all([
    getDoc(doc(db, "guildas", uid)),
    getDoc(doc(db, "configGuilda", uid))
  ]);

  const batch = writeBatch(db);

  if (!gSnap.exists()) {
    batch.set(doc(db, "guildas", uid), {
      name: uname || "Minha Guilda",
      ownerUid: uid,
      ownerEmail: email,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  } else {
    batch.set(doc(db, "guildas", uid), {
      ...(uname ? { name: uname } : {}),
      updatedAt: serverTimestamp()
    }, { merge: true });
  }

  if (!cSnap.exists()) {
    batch.set(doc(db, "configGuilda", uid), {
      ownerUid: uid,
      ownerEmail: email,
      tagMembros: "",
      leaders: email ? [email] : [],
      admins: [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  } else {
    // não sobrescreve tag/roles
    batch.set(doc(db, "configGuilda", uid), {
      updatedAt: serverTimestamp()
    }, { merge: true });
  }

  await batch.commit();
}

// Signup do dono: cria guilda própria (guildId = uid)
export async function finalizeSignup(user, username) {
  if (!user || !user.uid) throw new Error("Usuário inválido.");
  const uname = (username || "").toString().trim();
  if (!uname) throw new Error("Nome de usuário inválido.");

  const guildId = user.uid;
  await ensureBootstrapDocs(user, uname, guildId);
  return { guildId };
}

// --- Ajustes (Firestore) ----------------------------------------------------
// Tag por guilda: configGuilda/{guildId}.tagMembros
export async function getMemberTagConfig() {
  let guildId = null;
  try {
    guildId = requireGuildId();
  } catch (_) {
    return null;
  }

  // 1) Tenta cache local primeiro (útil se o Firestore demorar ou falhar)
  try {
    const raw = localStorage.getItem(`tagMembros_${guildId}`);
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached?.value) return String(cached.value);
    }
  } catch (_) {}

  // 2) Busca no Firestore
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
    console.error("Erro ao ler tag (configGuilda/{guildId}):", e);
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
  // Atualiza cache local (ajustes carrega instantâneo)
  try { localStorage.setItem(`tagMembros_${guildId}`, JSON.stringify({ value: clean, ts: Date.now() })); } catch (_) {}
  return true;
}

// Toast simples (sem depender de libs)
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

// Proteção de rotas (chame no início de cada página privada)
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

      // Preenche UI de usuário
      const emailEl = document.getElementById("user-email");
      if (emailEl) emailEl.textContent = user.email || "";

      // 1) Tenta obter guildId do perfil
      let guildId = null;
      let username = "";

      try {
        const prof = await getDoc(doc(db, "users", user.uid));
        if (prof.exists()) {
          const d = prof.data() || {};
          guildId = (d.guildId || "").toString().trim() || null;
          username = (d.username || "").toString().trim();
        }
      } catch (_) {}

      // 2) Se não tem guildId, tenta descobrir pela configGuilda (leaders/admins/ownerEmail)
      if (!guildId) {
        try {
          const found = await findGuildByEmail(emailLower);
          if (found?.guildId) guildId = found.guildId;
        } catch (_) {}
      }

      // 3) Se ainda não tem guildId, assume que é dono (nova guilda)
      if (!guildId) guildId = user.uid;

      // 4) Bootstrap: sempre garante users/{uid}; só cria guilda/config se for dono
      try {
        await ensureBootstrapDocs(user, username || "Minha Guilda", guildId);
      } catch (e) {
        console.warn("Falha ao preparar docs:", e);
        showToast("error", "Não foi possível preparar sua guilda no Firestore. Verifique as regras e tente novamente.");
        try { await signOut(auth); } catch (_) {}
        if (!isLoginPage) window.location.href = "index.html";
        resolve(null);
        return;
      }

      // 5) Resolve role e normaliza config (se puder)
      const role = await resolveRoleInGuild(guildId, user.email || "");
      if (role === "Líder") {
        // corrige listas com maiúsculas/minúsculas (evita o bug do 'precisa trocar letra')
        normalizeConfigGuilda(guildId);
      }

      const guildName = await getGuildName(guildId);

      __guildCtx = {
        guildId,
        guildName,
        role,
        email: emailLower,
        uid: user.uid
      };

      // Persiste contexto para outras telas renderizarem cache antes do auth
      try {
        localStorage.setItem(__GUILDCTX_LS_KEY, JSON.stringify({ guildId, guildName, role, email: emailLower, uid: user.uid, ts: Date.now() }));
      } catch (_) {}

      const roleEl = document.getElementById("user-role");
      if (roleEl) roleEl.textContent = role;

      const path = (window.location.pathname || "").toLowerCase();
      const isAdminPage = path.endsWith("/admin") || path.endsWith("/admin.html") || path.includes("admin.html");
      const isMembersPage = path.endsWith("/membros") || path.endsWith("/membros.html") || path.includes("membros.html");
      const isDashboardPage = path.endsWith("/dashboard") || path.endsWith("/dashboard.html") || path.includes("dashboard.html");
      const isCampPage = path.endsWith("/camp") || path.endsWith("/camp.html") || path.includes("camp.html") || path.includes("campeonato");
      const isSettingsPage = path.endsWith("/ajustes") || path.endsWith("/ajustes.html") || path.includes("ajustes.html");
      const isLinesPage = path.endsWith("/lines") || path.endsWith("/lines.html") || path.includes("lines.html");

      // Acesso:
      // - Líder: tudo
      // - Admin: Dashboard + Membros + Ajustes
      // - Membro: sem acesso
      if (role === "Membro") {
        showToast("error", "Acesso negado: conta não autorizada.");
        try { await signOut(auth); } catch (_) {}
        if (!isLoginPage) window.location.href = "index.html";
        resolve(null);
        return;
      }

      
      if (role === "Jogador") {
        // Jogador: somente tela de jogador (leitura)
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
          showToast("error", "Perfil Admin: acesso ao Dashboard, Membros, Lines e Ajustes.");
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

// Sidebar (mobile)
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

// Ícones (lucide)
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
    // Limpa caches locais para não vazar dados entre contas
    try {
      localStorage.removeItem(__GUILDCTX_LS_KEY);
      localStorage.removeItem("membersList");
      localStorage.removeItem("dashboard_stats");
      localStorage.removeItem("campsList");
      // chaves dinâmicas por guilda
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

// Mostra toasts pós-login (ex.: dashboard.html?login=1) e limpa a URL
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
  } catch (e) {
    console.warn("consumeLoginToasts:", e);
  }
}

// Cria conta no Firebase Auth sem derrubar a sessão atual (usa um Auth secundário)
export async function ensureUserAccount(email, password) {
  const e = cleanEmail(email);
  if (!e) throw new Error("E-mail inválido.");

  const methods = await fetchSignInMethodsForEmail(auth, e);
  if (methods && methods.length) return { created: false };

  if (!password || String(password).length < 6) {
    throw new Error("Conta não existe. Informe uma senha (mínimo 6 caracteres) para criar.");
  }

  const secondaryName = "secondary_" + Date.now();
  const secondaryApp = initializeApp(firebaseConfig, secondaryName);
  const secondaryAuth = getAuth(secondaryApp);

  try {
    await createUserWithEmailAndPassword(secondaryAuth, e, password);
    return { created: true };
  } finally {
    try { await signOut(secondaryAuth); } catch (_) {}
    try { await deleteApp(secondaryApp); } catch (_) {}
  }
}

/**
 * Cria (ou garante) o acesso "Jogador" para a guilda atual.
 * - Gera um e-mail único por guilda: jogador.<guildId>@guildahub.app
 * - Cria conta no Auth via app secundário (não derruba o login atual)
 * - Cria users/{uid} com guildId e role "Jogador"
 * - Salva playerEmail em configGuilda/{guildId}
 */
export async function createPlayerAccess(guildId, password) {
  if (!guildId) throw new Error("GuildId inválido.");
  const email = cleanEmail(`jogador.${guildId}@guildahub.app`);

  if (!password || String(password).length < 6) {
    throw new Error("Defina uma senha com no mínimo 6 caracteres.");
  }

  const secondaryName = "secondary_player_" + Date.now();
  const secondaryApp = initializeApp(firebaseConfig, secondaryName);
  const secondaryAuth = getAuth(secondaryApp);
  const secondaryDb = getFirestore(secondaryApp);

  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    const uid = cred.user.uid;

    // Cria o perfil do jogador (com o guildId), logado como ele (regras permitem)
    await setDoc(doc(secondaryDb, "users", uid), {
      email,
      username: "Jogador",
      guildId,
      role: "Jogador",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });

    // Registra no config da guilda (precisa ser Líder/Admin no Auth principal)
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

/**
 * Remove o acesso do jogador (revoga pelo config). Não apaga a conta do Auth.
 */
export async function revokePlayerAccess(guildId) {
  if (!guildId) throw new Error("GuildId inválido.");
  await setDoc(doc(db, "configGuilda", guildId), {
    playerEmail: null,
    playerEnabled: false,
    playerRevokedAt: serverTimestamp()
  }, { merge: true });
  return true;
}

/**
 * Tenta apagar a conta do jogador (Auth) e o doc users/{uid}.
 * Necessita a senha do jogador (para login recente).
 */
export async function deletePlayerAccount(playerEmail, password) {
  const email = cleanEmail(playerEmail);
  if (!email) throw new Error("E-mail inválido.");
  if (!password || String(password).length < 6) throw new Error("Informe a senha do jogador (mínimo 6).");

  const secondaryName = "secondary_delete_" + Date.now();
  const secondaryApp = initializeApp(firebaseConfig, secondaryName);
  const secondaryAuth = getAuth(secondaryApp);
  const secondaryDb = getFirestore(secondaryApp);

  try {
    // Login recente
    const { signInWithEmailAndPassword } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
    const cred = await signInWithEmailAndPassword(secondaryAuth, email, password);
    const uid = cred.user.uid;

    // Remove doc users/{uid} (regras precisam permitir delete do próprio doc)
    try {
      const { deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
      await deleteDoc(doc(secondaryDb, "users", uid));
    } catch (_) {}

    // Apaga Auth user
    await cred.user.delete();

    return { deleted: true };
  } finally {
    try { await signOut(secondaryAuth); } catch (_) {}
    try { await deleteApp(secondaryApp); } catch (_) {}
  }
}
