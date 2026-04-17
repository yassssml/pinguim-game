require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');

// Driver Neon Serverless — conecta via WebSocket (porta 443) em vez de TCP 5432
// Funciona mesmo em redes que bloqueiam a porta 5432 do PostgreSQL
const { neon, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');

// Configura WebSocket para ambiente Node.js
neonConfig.webSocketConstructor = ws;

const app = express();
const PORT = process.env.PORT || 3000;

// Cria o cliente SQL usando a connection string (se existir)
let sql = null;
if (process.env.DATABASE_URL) {
    sql = neon(process.env.DATABASE_URL);
}

// --- INICIALIZAÇÃO DAS TABELAS ---
async function initDB() {
    if (!sql) return false;
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
    if (!sql) return res.status(503).json({ error: 'Banco não configurado' });
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
    if (!sql) return res.status(503).json({ error: 'Banco não configurado' });
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
    if (!sql) return res.json({ status: 'ok', db: 'not configured' });
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

// ============================================================
// --- SISTEMA DE SALAS MULTIPLAYER (WebSocket) ---
// ============================================================

const server = http.createServer(app);
const wss = new ws.Server({ server });

// Gerenciador de salas em memória
const rooms = new Map();

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return rooms.has(code) ? generateRoomCode() : code;
}

function broadcastToRoom(roomCode, message, excludeWs = null) {
    const room = rooms.get(roomCode);
    if (!room) return;
    const payload = JSON.stringify(message);
    room.players.forEach(p => {
        if (p.ws !== excludeWs && p.ws.readyState === ws.OPEN) {
            p.ws.send(payload);
        }
    });
}

function sendPlayerList(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    const list = room.players.map(p => ({
        id: p.id,
        name: p.name,
        skinType: p.skinType || 'normal',
        skinColor: p.skinColor || 0x333333,
        skinName: p.skinName || 'Clássico',
        isHost: p.id === room.hostId
    }));
    broadcastToRoom(roomCode, { type: 'PLAYER_LIST', players: list, hostId: room.hostId });
}

function cleanupRoom(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (room.players.length === 0) {
        rooms.delete(roomCode);
        console.log(`🗑️  Sala ${roomCode} removida (vazia).`);
    }
}

wss.on('connection', (socket) => {
    let currentRoom = null;
    let playerId = null;

    socket.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {

            case 'CREATE_ROOM': {
                const code = generateRoomCode();
                playerId = msg.playerId || ('p_' + Date.now());
                const room = {
                    code,
                    hostId: playerId,
                    state: 'LOBBY',        // LOBBY | PLAYING
                    players: [{
                        id: playerId,
                        name: msg.playerName || 'Jogador',
                        ws: socket,
                        skinType: msg.skinType || 'normal',
                        skinColor: msg.skinColor || 0x333333,
                        skinName: msg.skinName || 'Clássico',
                        action: null        // { angle, power } quando enviar
                    }],
                    round: 0,
                    turnTimer: null,
                    penguinStates: []       // posições sincronizadas
                };
                rooms.set(code, room);
                currentRoom = code;
                socket.send(JSON.stringify({ type: 'ROOM_CREATED', code, playerId }));
                sendPlayerList(code);
                console.log(`🏠 Sala ${code} criada por ${msg.playerName || playerId}`);
                break;
            }

            case 'JOIN_ROOM': {
                const code = (msg.code || '').toUpperCase().trim();
                const room = rooms.get(code);
                if (!room) {
                    socket.send(JSON.stringify({ type: 'ERROR', message: 'Sala não encontrada.' }));
                    return;
                }
                if (room.state !== 'LOBBY') {
                    socket.send(JSON.stringify({ type: 'ERROR', message: 'Partida já em andamento.' }));
                    return;
                }
                if (room.players.length >= 10) {
                    socket.send(JSON.stringify({ type: 'ERROR', message: 'Sala cheia (máx 10).' }));
                    return;
                }
                playerId = msg.playerId || ('p_' + Date.now());
                // Impede duplicata
                if (room.players.some(p => p.id === playerId)) {
                    socket.send(JSON.stringify({ type: 'ERROR', message: 'Você já está nesta sala.' }));
                    return;
                }
                room.players.push({
                    id: playerId,
                    name: msg.playerName || 'Jogador',
                    ws: socket,
                    skinType: msg.skinType || 'normal',
                    skinColor: msg.skinColor || 0x333333,
                    skinName: msg.skinName || 'Clássico',
                    action: null
                });
                currentRoom = code;
                socket.send(JSON.stringify({ type: 'ROOM_JOINED', code, playerId, hostId: room.hostId }));
                sendPlayerList(code);
                console.log(`👤 ${msg.playerName || playerId} entrou na sala ${code}`);
                break;
            }

            case 'START_GAME': {
                if (!currentRoom) return;
                const room = rooms.get(currentRoom);
                if (!room || room.hostId !== playerId) return;
                if (room.players.length < 2) {
                    socket.send(JSON.stringify({ type: 'ERROR', message: 'Mínimo 2 jogadores.' }));
                    return;
                }
                room.state = 'PLAYING';
                room.round = 1;

                // Gera posições iniciais para todos os jogadores
                const totalSlots = 10;
                const startPositions = [];
                for (let i = 0; i < totalSlots; i++) {
                    const ang = (Math.PI * 2 / totalSlots) * i;
                    const dist = 12;
                    startPositions.push({
                        x: Math.cos(ang) * dist,
                        z: Math.sin(ang) * dist
                    });
                }

                // Atribui posições: jogadores reais primeiro, bots completam
                const playerPositions = room.players.map((p, i) => ({
                    id: p.id,
                    name: p.name,
                    skinType: p.skinType,
                    skinColor: p.skinColor,
                    skinName: p.skinName,
                    isBot: false,
                    position: startPositions[i]
                }));

                // Completa com bots
                for (let i = room.players.length; i < totalSlots; i++) {
                    playerPositions.push({
                        id: 'bot_' + i,
                        name: 'Bot',
                        skinType: Math.random() > 0.6 ? 'sorvete' : 'normal',
                        skinColor: Math.floor(Math.random() * 0xffffff),
                        skinName: 'Bot',
                        isBot: true,
                        position: startPositions[i]
                    });
                }

                broadcastToRoom(currentRoom, {
                    type: 'GAME_START',
                    players: playerPositions,
                    round: 1
                });
                console.log(`🎮 Partida iniciada na sala ${currentRoom} com ${room.players.length} jogadores`);

                // Inicia timer de turno (5 segundos)
                room.players.forEach(p => p.action = null);
                if (room.turnTimer) clearTimeout(room.turnTimer);
                room.turnTimer = setTimeout(() => resolveRound(currentRoom), 5500);
                break;
            }

            case 'PLAYER_ACTION': {
                if (!currentRoom) return;
                const room = rooms.get(currentRoom);
                if (!room || room.state !== 'PLAYING') return;
                const me = room.players.find(p => p.id === playerId);
                if (me) {
                    me.action = { angle: msg.angle, power: msg.power };
                }
                // Se todos já enviaram ação, resolve imediatamente
                const allSent = room.players.every(p => p.action !== null);
                if (allSent) {
                    if (room.turnTimer) clearTimeout(room.turnTimer);
                    resolveRound(currentRoom);
                }
                break;
            }

            case 'ROUND_RESULT': {
                // Client informa o resultado da simulação de física (quem caiu, posições finais)
                // Apenas o HOST envia isso para sincronizar
                if (!currentRoom) return;
                const room = rooms.get(currentRoom);
                if (!room || room.hostId !== playerId) return;

                broadcastToRoom(currentRoom, {
                    type: 'SYNC_ROUND_RESULT',
                    alivePlayers: msg.alivePlayers,
                    eliminatedPlayers: msg.eliminatedPlayers,
                    positions: msg.positions,
                    gameOver: msg.gameOver,
                    winnerId: msg.winnerId
                });

                if (msg.gameOver) {
                    room.state = 'LOBBY';
                    room.round = 0;
                    room.players.forEach(p => p.action = null);
                    // Não deletar a sala — permite jogar novamente
                } else {
                    // Próximo turno
                    room.round++;
                    room.players.forEach(p => p.action = null);
                    if (room.turnTimer) clearTimeout(room.turnTimer);
                    room.turnTimer = setTimeout(() => resolveRound(currentRoom), 5500);
                }
                break;
            }

            case 'BACK_TO_LOBBY': {
                if (!currentRoom) return;
                const room = rooms.get(currentRoom);
                if (!room) return;
                room.state = 'LOBBY';
                room.round = 0;
                room.players.forEach(p => p.action = null);
                broadcastToRoom(currentRoom, { type: 'RETURN_TO_LOBBY' });
                sendPlayerList(currentRoom);
                break;
            }
        }
    });

    socket.on('close', () => {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        room.players = room.players.filter(p => p.ws !== socket);
        console.log(`👋 Jogador desconectou da sala ${currentRoom}`);

        // Se o host saiu, atribuir novo host
        if (room.hostId === playerId && room.players.length > 0) {
            room.hostId = room.players[0].id;
            console.log(`👑 Novo host da sala ${currentRoom}: ${room.players[0].name}`);
        }

        if (room.players.length > 0) {
            sendPlayerList(currentRoom);
        } else {
            if (room.turnTimer) clearTimeout(room.turnTimer);
            cleanupRoom(currentRoom);
        }
    });
});

function resolveRound(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || room.state !== 'PLAYING') return;

    // Coleta as ações de todos os jogadores
    const actions = room.players.map(p => ({
        id: p.id,
        angle: p.action ? p.action.angle : (Math.random() * Math.PI * 2),
        power: p.action ? p.action.power : 0.55
    }));

    // Envia as ações para todos simularem a física localmente
    broadcastToRoom(roomCode, {
        type: 'RESOLVE_ACTIONS',
        actions,
        round: room.round
    });

    // Reset ações para próximo turno
    room.players.forEach(p => p.action = null);
}

// --- START ---
server.listen(PORT, async () => {
    console.log(`\n🐧 Penguin Knockout rodando em: http://localhost:${PORT}`);
    const ok = await initDB();
    if (ok) {
        console.log(`🗄️  Banco de dados: Neon PostgreSQL ✅`);
    } else {
        console.log(`🗄️  Banco de dados: OFFLINE ⚠️  (ranking não funcionará)`);
    }
    console.log(`🔌 WebSocket: Pronto para salas multiplayer ✅\n`);
});
