// logic.js — módulo compartilhado (Firebase + UI helpers)
// Observação: este arquivo DEVE ser JavaScript. (Antes ele estava com CSS e quebrava o login.)

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Firebase config (mesmo projeto do admin.html)
const firebaseConfig = {
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
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className =
    "animate-in px-4 py-3 rounded-xl shadow-lg border text-sm font-medium flex items-start gap-2 max-w-[320px] " +
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
    if (admins.includes(e)) return "Admin";
    if (leaders.includes(e)) return "Líder";
    return "Membro";
  } catch (e) {
    console.error("Erro ao buscar role:", e);
    return "Membro";
  }
}


// Exporta o papel para uso na tela de login e outras telas
export async function getRoleByEmail(email) {
  return await resolveRoleByEmail(email);
}

// Proteção de rotas (chame no início de cada página privada)
export function checkAuth(redirectToLogin = true) {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        if (redirectToLogin) {
          // evita loop: só redireciona se não estiver na página de login
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

      // Se estiver em página admin e não for Admin, bloqueia
      const path = (window.location.pathname || "").toLowerCase();
      const onAdminPage = path.endsWith("/admin") || path.endsWith("/admin.html") || path.includes("admin.html");
      if (onAdminPage && role !== "Admin" && role !== "Líder") {
        showToast("error", "Acesso negado: somente Admin ou Líder.");
        // Mantém o usuário logado, apenas redireciona
        window.location.href = "dashboard.html";
        resolve(null);
        return;
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

  // Fecha ao navegar (para não ficar travado no mobile)
  sidebar.querySelectorAll("a[href]").forEach((a) => {
    a.addEventListener("click", () => {
      if (window.innerWidth < 1024) close();
    });
  });

  // Estado inicial no mobile
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
  } catch (e) {
    // silencioso
  }
}

export async function logout() {
  try {
    await signOut(auth);
  } finally {
    window.location.href = "index.html";
  }
}
