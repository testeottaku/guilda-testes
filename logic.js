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
  getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Firebase config
export const firebaseConfig = {
  apiKey: "AIzaSyA5uana2jcnWCkY3vqpotbpoQKxy7bTMtU",
  authDomain: "guilda-otk.firebaseapp.com",
  projectId: "guilda-otk"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

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
  try {
    const snap = await getDoc(doc(db, "guildConfig", "security"));
    if (!snap.exists()) return "Membro";

    const data = snap.data() || {};
    const admins = Array.isArray(data.admins) ? data.admins : [];
    const leaders = Array.isArray(data.leaders) ? data.leaders : [];

    const e = (email || "").toLowerCase();
    if (admins.map((x) => String(x).toLowerCase()).includes(e)) return "Admin";
    if (leaders.map((x) => String(x).toLowerCase()).includes(e)) return "Líder";
    return "Membro";
  } catch (e) {
    console.error("Erro ao buscar role:", e);
    return "Membro";
  }
}

// Proteção de rotas (chame no início de cada página privada)
export function checkAuth(redirectToLogin = true) {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        if (redirectToLogin) {
          const isLogin = /index\.html$|\/$/.test(window.location.pathname);
          if (!isLogin) window.location.href = "index.html";
        }
        resolve(null);
        return;
      }

      // Preenche UI de usuário
      const emailEl = document.getElementById("user-email");
      if (emailEl) emailEl.textContent = user.email || "";

      const role = await resolveRoleByEmail(user.email || "");
      const roleEl = document.getElementById("user-role");
      if (roleEl) roleEl.textContent = role;

      const path = (window.location.pathname || "").toLowerCase();
      const isAdminPage = path.endsWith("/admin") || path.endsWith("/admin.html") || path.includes("admin.html");
      const isMembersPage = path.endsWith("/membros") || path.endsWith("/membros.html") || path.includes("membros.html");
      const isDashboardPage = path.endsWith("/dashboard") || path.endsWith("/dashboard.html") || path.includes("dashboard.html");
      const isCampPage = path.endsWith("/camp") || path.endsWith("/camp.html") || path.includes("camp.html") || path.includes("campeonato");

      // Regras de acesso (conforme você pediu AGORA):
      // - Líder: tudo
      // - Admin: Dashboard + Membros
      // - Membro: sem acesso (volta pro login)

      if (role === "Membro") {
        showToast("error", "Acesso negado: conta não autorizada.");
        // mantém auth, mas manda pro login
        window.location.href = "index.html";
        resolve(null);
        return;
      }

      if (role === "Admin") {
        // Admin não acessa Camp nem Admin (config)
        if (isAdminPage || isCampPage) {
          showToast("error", "Perfil Admin: acesso apenas ao Dashboard e Membros.");
          window.location.href = "dashboard.html";
          resolve(null);
          return;
        }
        // Dashboard e Membros ok
        if (!isDashboardPage && !isMembersPage) {
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
