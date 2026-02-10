# Guilda Admin — Deploy na Vercel (Static)

## Como publicar
1. Crie um projeto na Vercel (New Project).
2. Faça upload **desta pasta** (ou deste .zip) como “Other” / Static.
3. Não precisa de Build Command.
4. Output / Root Directory: deixe como a raiz do projeto (onde está o `index.html`).

## Rotas
Com o `vercel.json`, você pode acessar:
- / (login)
- /dashboard
- /membros
- /campeonato
- /admin

E também funciona com:
- /dashboard.html, /membros.html, etc.

## Observação (Firebase)
Se você alterou regras/permissões no Firebase, isso continua valendo no deploy.
