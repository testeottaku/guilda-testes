import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, getDocs, setDoc, doc, deleteDoc, serverTimestamp, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyA5uana2jcnWCkY3vqpotbpoQKxy7bTMtU",
  authDomain: "guilda-otk.firebaseapp.com",
  projectId: "guilda-otk",
  storageBucket: "guilda-otk.firebasestorage.app",
  messagingSenderId: "628349020809",
  appId: "1:628349020809:web:be1457404159f9ea2a3458"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Função de segurança aprimorada
async function checkAuthAndRedirect() {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      const path = window.location.pathname;
      const isLogin = path.includes('index.html') || path.endsWith('/');

      if (!user) {
        if (!isLogin) window.location.href = 'index.html';
        resolve(null);
      } else {
        try {
          // Busca permissões
          const snap = await getDoc(doc(db, "guildConfig", "security"));
          const data = snap.exists() ? snap.data() : { admins: [], leaders: [] };
          const email = user.email.toLowerCase();

          // Se a lista de admin estiver vazia (primeiro uso), libera o primeiro usuário
          const isFirstUser = (!data.admins || data.admins.length === 0);

          if (isFirstUser || data.admins?.includes(email) || data.leaders?.includes(email)) {
             const role = (isFirstUser || data.admins?.includes(email)) ? 'admin' : 'leader';
             window.__session = { email, role }; // Salva sessão
             
             if (isLogin) window.location.href = 'dashboard.html';
             resolve(user);
          } else {
            alert("Sem permissão de acesso. Contate o administrador.");
            await signOut(auth);
            window.location.href = 'index.html';
          }
        } catch (error) {
          console.error("Erro de segurança:", error);
          alert("Erro ao verificar permissões.");
          resolve(null);
        }
      }
    });
  });
}

// Expõe funções globalmente
window.authApi = {
  login: (email, pass) => signInWithEmailAndPassword(auth, email, pass),
  logout: () => signOut(auth),
  check: checkAuthAndRedirect
};

window.guildDB = {
  async getMembers() {
    try {
      const s = await getDocs(collection(db, "membros"));
      let d = []; 
      s.forEach(x => d.push({id: x.id, ...x.data()}));
      return d.sort((a,b) => (a.nick||"").localeCompare(b.nick||""));
    } catch (e) {
      console.error("Erro ao buscar membros:", e);
      return []; // Retorna lista vazia para não travar a tela
    }
  },
  async saveMember(data) {
    if(!data.id) throw new Error("ID inválido");
    data.updatedAt = serverTimestamp();
    await setDoc(doc(db, "membros", data.id), data, { merge: true });
  },
  async deleteMember(id) {
    await deleteDoc(doc(db, "membros", id));
  },
  async getSecurity() {
    const s = await getDoc(doc(db, "guildConfig", "security"));
    return s.exists() ? s.data() : { admins: [], leaders: [] };
  },
  async saveSecurity(data) {
    await setDoc(doc(db, "guildConfig", "security"), data, { merge: true });
  }
};
