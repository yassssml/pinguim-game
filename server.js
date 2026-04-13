require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

// Driver Neon Serverless — conecta via WebSocket (porta 443) em vez de TCP 5432
// Funciona mesmo em redes que bloqueiam a porta 5432 do PostgreSQL
const { neon, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');

// Configura WebSocket para ambiente Node.js
neonConfig.webSocketConstructor = ws;

const app = express();
const PORT = process.env.PORT || 3000;

// Cria o cliente SQL usando a connection string
const sql = neon(process.env.DATABASE_URL);

// --- INICIALIZAÇÃO DAS TABELAS ---
async function initDB() {
    try {
        await sql`
            CREATE TABLE IF NOT EXISTS leaderboard (
                user_id     VARCHAR(64) PRIMARY KEY,
                name        VARCHAR(32) NOT NULL DEFAULT 'Jogador',
                ice         INTEGER NOT NULL DEFAULT 0,
                skins_count INTEGER NOT NULL DEFAULT 1,
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `;
        console.log('✅ Tabela "leaderboard" pronta no Neon.');
        return true;
    } catch (err) {
        console.error('❌ Erro ao conectar com o banco:', err.message);
        return false;
    }
}

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json());

// Serve os arquivos estáticos (index.html, etc.) da pasta do projeto
app.use(express.static(path.join(__dirname)));

// --- ROTAS DA API ---

// GET /api/ranking — Retorna top 50 jogadores por gelo
app.get('/api/ranking', async (req, res) => {
    try {
        const rows = await sql`
            SELECT user_id, name, ice, skins_count
            FROM leaderboard
            ORDER BY ice DESC
            LIMIT 50
        `;
        res.json(rows);
    } catch (err) {
        console.error('Erro ao buscar ranking:', err.message);
        res.status(500).json({ error: 'Erro ao buscar ranking' });
    }
});

// POST /api/ranking — Cria ou atualiza dados do jogador
app.post('/api/ranking', async (req, res) => {
    const { userId, name, ice, skinsCount } = req.body;

    if (!userId || !name) {
        return res.status(400).json({ error: 'userId e name são obrigatórios' });
    }

    try {
        await sql`
            INSERT INTO leaderboard (user_id, name, ice, skins_count, updated_at)
            VALUES (${userId}, ${name}, ${ice ?? 0}, ${skinsCount ?? 1}, NOW())
            ON CONFLICT (user_id)
            DO UPDATE SET
                name        = EXCLUDED.name,
                ice         = EXCLUDED.ice,
                skins_count = EXCLUDED.skins_count,
                updated_at  = NOW()
        `;
        res.json({ success: true });
    } catch (err) {
        console.error('Erro ao salvar ranking:', err.message);
        res.status(500).json({ error: 'Erro ao salvar dados' });
    }
});

// GET /api/health — Verificação de saúde
app.get('/api/health', async (req, res) => {
    try {
        await sql`SELECT 1`;
        res.json({ status: 'ok', db: 'connected' });
    } catch (err) {
        res.status(503).json({ status: 'error', db: err.message });
    }
});

// Rota fallback — serve o index.html para qualquer outra rota
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- START ---
app.listen(PORT, async () => {
    console.log(`\n🐧 Penguin Knockout rodando em: http://localhost:${PORT}`);
    const ok = await initDB();
    if (ok) {
        console.log(`🗄️  Banco de dados: Neon PostgreSQL ✅\n`);
    } else {
        console.log(`🗄️  Banco de dados: OFFLINE ⚠️  (ranking não funcionará)\n`);
    }
});
