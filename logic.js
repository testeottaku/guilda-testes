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
  collection,
  query,
  where,
  getDoc,
  getDocs,
  setDoc,
  writeBatch,
  updateDoc,
  serverTimestamp,
  arrayUnion,
  arrayRemove
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

// --- Contexto da Guilda (multi-guild) --------------------------------------
// Mantém em memória para todas as telas durante a sessão.
let __guildCtx = null;

// Retorna { guildId, guildName, role, email, uid }
export function getGuildContext() {
  return __guildCtx;
}

function requireGuildId() {
  if (!__guildCtx || !__guildCtx.guildId) throw new Error("Guilda não resolvida. Faça login novamente.");
  return __guildCtx.guildId;
}

async function findGuildIdByEmail(email) {
  const cleanEmail = (email || "").toLowerCase().trim();
  if (!cleanEmail) return null;

  // Procura em configGuilda onde o email esteja em leaders ou admins
  const col = collection(db, "configGuilda");

  const qLeader = query(col, where("leaders", "array-contains", cleanEmail));
  const leaderSnap = await getDocs(qLeader);
  if (!leaderSnap.empty) return leaderSnap.docs[0].id;

  const qAdmin = query(col, where("admins", "array-contains", cleanEmail));
  const adminSnap = await getDocs(qAdmin);
  if (!adminSnap.empty) return adminSnap.docs[0].id;

  return null;
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

async function resolveRoleInGuild(guildId, email) {
  const cleanEmail = (email || "").toLowerCase().trim();
  if (!guildId || !cleanEmail) return "Membro";
  try {
    const snap = await getDoc(doc(db, "configGuilda", guildId));
    if (!snap.exists()) return "Membro";
    const data = snap.data() || {};
    const leaders = Array.isArray(data.leaders) ? data.leaders : [];
    const admins = Array.isArray(data.admins) ? data.admins : [];
    if (leaders.includes(cleanEmail)) return "Líder";
    if (admins.includes(cleanEmail)) return "Admin";
    return "Membro";
  } catch {
    return "Membro";
  }
}

// Cria/atualiza o perfil do usuário (users/{uid}) com a guilda correta.
// Regras de decisão no signup:
// - Se o email já estiver cadastrado em alguma configGuilda (leaders/admins), entra nessa guilda.
// - Caso contrário, cria uma nova guilda para o usuário (guildId = uid).
export async function finalizeSignup(user, username) {
  if (!user || !user.uid) throw new Error("Usuário inválido.");
  const email = (user.email || "").toLowerCase().trim();
  const uname = (username || "").toString().trim();
  if (!uname) throw new Error("Nome de usuário inválido.");

  // 1) Descobre se o email já foi convidado (admin/líder) em alguma guilda existente
  let guildId = await findGuildIdByEmail(email);

  // Se não foi convidado para nenhuma guilda, cria uma nova (guildId = uid)
  const isCreatingNewGuild = !guildId;
  if (!guildId) guildId = user.uid;

  // Firestore não tem "criar coleção": a coleção nasce quando gravamos um documento.
  // Para evitar estado parcial, usamos batch.
  const batch = writeBatch(db);

  const gRef = doc(db, "guildas", guildId);
  const cRef = doc(db, "configGuilda", guildId);

  if (isCreatingNewGuild) {
    // ✅ Criação de guilda (dono = uid)
    batch.set(gRef, {
      name: uname,
      ownerUid: user.uid,
      ownerEmail: email,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });

    batch.set(cRef, {
      ownerUid: user.uid,
      tagMembros: "",
      leaders: [email],   // o dono vira líder automaticamente
      admins: [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
  } else {
    // ✅ Entrada por convite: a guilda e a config devem EXISTIR (não criamos aqui)
    // Se não existirem, é sinal de convite mal configurado (ou regras bloqueando leitura).
    const [gSnap, cSnap] = await Promise.all([getDoc(gRef), getDoc(cRef)]);
    if (!gSnap.exists() || !cSnap.exists()) {
      throw new Error("Convite inválido: a guilda/config não existe. Peça ao líder para criar a guilda primeiro.");
    }
  }

  // 2) Perfil do usuário (sempre)
  batch.set(doc(db, "users", user.uid), {
    email,
    username: uname,
    guildId,
    updatedAt: serverTimestamp(),
    createdAt: serverTimestamp()
  }, { merge: true });

  await batch.commit();
  return { guildId };
}



// --- Ajustes (Firestore) ----------------------------------------------------
// Configuração por guilda: configGuilda/{guildId}.tagMembros
export async function getMemberTagConfig() {
  try {
    const guildId = requireGuildId();
    const snap = await getDoc(doc(db, "configGuilda", guildId));
    if (!snap.exists()) return null;
    const data = snap.data() || {};
    const tag = (data.tagMembros || "").toString().trim();
    return tag ? tag : null;
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

// Determina o papel do usuário baseado em guildConfig/security
async function resolveRoleByEmail(email) {
  const cleanEmail = (email || "").toLowerCase().trim();
  if (!cleanEmail) return "Membro";

  // 1) tenta descobrir guilda pelo próprio perfil
  try {
    const u = auth.currentUser;
    if (u && u.uid) {
      const prof = await getDoc(doc(db, "users", u.uid));
      if (prof.exists()) {
        const data = prof.data() || {};
        if (data.guildId) return await resolveRoleInGuild(String(data.guildId), cleanEmail);
      }
    }
  } catch {}

  // 2) fallback: procura em configGuilda
  const guildId = await findGuildIdByEmail(cleanEmail);
  if (!guildId) return "Membro";
  return await resolveRoleInGuild(guildId, cleanEmail);
}

// Proteção de rotas (chame no início de cada página privada)
export function checkAuth(redirectToLogin = true) {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      const isLoginPage = /index\.html$|\/$/i.test(window.location.pathname || "");
      if (!user) {
        if (redirectToLogin) {
          if (!isLoginPage) window.location.href = "index.html";
        }
        resolve(null);
        return;
      }

      // Preenche UI de usuário
      const emailEl = document.getElementById("user-email");
      if (emailEl) emailEl.textContent = user.email || "";

      // Resolve guilda do usuário
      let guildId = null;

      try {
        const profSnap = await getDoc(doc(db, "users", user.uid));
        if (profSnap.exists()) {
          const pdata = profSnap.data() || {};
          guildId = pdata.guildId ? String(pdata.guildId) : null;
        }
      } catch {}

      if (!guildId) {
        guildId = await findGuildIdByEmail(user.email || "");
        // Se achou guilda por convite, grava no perfil para as próximas telas
        if (guildId) {
          try {
            await setDoc(doc(db, "users", user.uid), {
              email: (user.email || "").toLowerCase().trim(),
              guildId,
              updatedAt: serverTimestamp(),
              createdAt: serverTimestamp()
            }, { merge: true });
          } catch (e) {
            console.warn("Falha ao gravar users/{uid} (vínculo de guilda):", e);
          }
        }
      }

      // Se não conseguimos resolver a guilda, não dá para autorizar a sessão.
      if (!guildId) {
        showToast(
          "error",
          "Conta criada, mas não foi possível vincular/criar a guilda no Firestore (permissão nas regras).\nFaça login novamente após ajustar as regras."
        );
        try { await signOut(auth); } catch (_) {}
        if (!isLoginPage) window.location.href = "index.html";
        resolve(null);
        return;
      }

      const role = guildId ? await resolveRoleInGuild(guildId, user.email || "") : "Membro";
      const guildName = guildId ? (await getGuildName(guildId)) : null;

      __guildCtx = {
        guildId,
        guildName,
        role,
        email: (user.email || "").toLowerCase().trim(),
        uid: user.uid
      };

      const roleEl = document.getElementById("user-role");
      if (roleEl) roleEl.textContent = role;

      const path = (window.location.pathname || "").toLowerCase();
      const isAdminPage = path.endsWith("/admin") || path.endsWith("/admin.html") || path.includes("admin.html");
      const isMembersPage = path.endsWith("/membros") || path.endsWith("/membros.html") || path.includes("membros.html");
      const isDashboardPage = path.endsWith("/dashboard") || path.endsWith("/dashboard.html") || path.includes("dashboard.html");
      const isCampPage = path.endsWith("/camp") || path.endsWith("/camp.html") || path.includes("camp.html") || path.includes("campeonato");
      const isSettingsPage = path.endsWith("/ajustes") || path.endsWith("/ajustes.html") || path.includes("ajustes.html");

      // Regras de acesso (conforme você pediu AGORA):
      // - Líder: tudo
      // - Admin: Dashboard + Membros + Ajustes (somente visualização)
      // - Membro: sem acesso (volta pro login)

      if (role === "Membro") {
        showToast("error", "Acesso negado: conta não autorizada.");
        // Evita loop infinito (index.html recarregando) e limpa a sessão.
        try { await signOut(auth); } catch (_) {}
        if (!isLoginPage) window.location.href = "index.html";
        resolve(null);
        return;
      }

      if (role === "Admin") {
        // Admin não acessa Camp nem Admin (config)
        if (isAdminPage || isCampPage) {
          showToast("error", "Perfil Admin: acesso ao Dashboard, Membros e Ajustes.");
          window.location.href = "dashboard.html";
          resolve(null);
          return;
        }
        // Dashboard, Membros e Ajustes ok
        if (!isDashboardPage && !isMembersPage && !isSettingsPage) {
          window.location.href = "dashboard.html";
          resolve(null);
          return;
        }
      }

      if (role === "Líder") {
        // Líder acessa tudo — sem bloqueio
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
  const cleanEmail = (email || "").toLowerCase().trim();
  if (!cleanEmail) throw new Error("E-mail inválido.");

  const methods = await fetchSignInMethodsForEmail(auth, cleanEmail);
  if (methods && methods.length) return { created: false };

  if (!password || String(password).length < 6) {
    throw new Error("Conta não existe. Informe uma senha (mínimo 6 caracteres) para criar.");
  }

  const secondaryName = "secondary_" + Date.now();
  const secondaryApp = initializeApp(firebaseConfig, secondaryName);
  const secondaryAuth = getAuth(secondaryApp);

  try {
    await createUserWithEmailAndPassword(secondaryAuth, cleanEmail, password);
    return { created: true };
  } finally {
    try { await signOut(secondaryAuth); } catch (_) {}
    try { await deleteApp(secondaryApp); } catch (_) {}
  }
}
