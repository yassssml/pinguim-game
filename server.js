require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

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

// Funções de criptografia
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
    const [salt, key] = storedHash.split(':');
    if (!salt || !key) return false;
    const hashBuffer = crypto.scryptSync(password, salt, 64);
    const keyBuffer = Buffer.from(key, 'hex');
    return crypto.timingSafeEqual(hashBuffer, keyBuffer);
}

// --- INICIALIZAÇÃO DAS TABELAS ---
async function initDB() {
    if (!sql) return false;
    try {
        // Tabela de contas
        await sql`
            CREATE TABLE IF NOT EXISTS accounts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                username VARCHAR(50) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                display_name VARCHAR(50) NOT NULL,
                ice INTEGER NOT NULL DEFAULT 0,
                skins_count INTEGER NOT NULL DEFAULT 1,
                inventory_data JSONB,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `;

        // Tabela antiga para manter compatibilidade, mas vamos migrar a lógica pro accounts
        await sql`
            CREATE TABLE IF NOT EXISTS leaderboard (
                user_id     VARCHAR(64) PRIMARY KEY,
                name        VARCHAR(32) NOT NULL DEFAULT 'Jogador',
                ice         INTEGER NOT NULL DEFAULT 0,
                skins_count INTEGER NOT NULL DEFAULT 1,
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `;
        console.log('✅ Tabelas "accounts" e "leaderboard" prontas no Neon.');
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

// --- SISTEMA DE RANKING AO VIVO ---
// Armazena quem está online no momento: ws -> { id, name, ice, skinsCount }
const activePlayers = new Map();

// GET /api/ranking — Retorna jogadores online, ordenados por gelo
app.get('/api/ranking', (req, res) => {
    try {
        const playersList = Array.from(activePlayers.values());
        playersList.sort((a, b) => b.ice - a.ice);
        // Retorna top 50 ao vivo
        res.json(playersList.slice(0, 50).map(p => ({
            user_id: p.id,
            name: p.name,
            ice: p.ice,
            skins_count: p.skinsCount
        })));
    } catch (err) {
        console.error('Erro ao gerar ranking ao vivo:', err.message);
        res.status(500).json({ error: 'Erro ao buscar ranking' });
    }
});

// POST /api/register — Criar nova conta
app.post('/api/register', async (req, res) => {
    if (!sql) return res.status(503).json({ error: 'Banco não configurado' });
    const { username, password, displayName, ice, inventoryData } = req.body;

    if (!username || !password || !displayName) {
        return res.status(400).json({ error: 'Preencha todos os campos' });
    }

    try {
        // Verifica se usuário já existe
        const existing = await sql`SELECT id FROM accounts WHERE username = ${username} LIMIT 1`;
        if (existing.length > 0) {
            return res.status(409).json({ error: 'Nome de usuário já está em uso' });
        }

        const passHash = hashPassword(password);
        const skinsCount = inventoryData ? inventoryData.length : 1;
        const invJson = inventoryData ? JSON.stringify(inventoryData) : null;

        const result = await sql`
            INSERT INTO accounts (username, password_hash, display_name, ice, skins_count, inventory_data)
            VALUES (${username}, ${passHash}, ${displayName}, ${ice || 0}, ${skinsCount}, ${invJson})
            RETURNING id, username, display_name, ice, inventory_data
        `;

        res.json({ success: true, account: result[0] });
    } catch (err) {
        console.error('Erro no registro:', err.message);
        res.status(500).json({ error: 'Erro interno ao criar conta' });
    }
});

// POST /api/login — Entrar na conta
app.post('/api/login', async (req, res) => {
    if (!sql) return res.status(503).json({ error: 'Banco não configurado' });
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Preencha usuário e senha' });
    }

    try {
        const result = await sql`SELECT * FROM accounts WHERE username = ${username} LIMIT 1`;
        if (result.length === 0) {
            return res.status(401).json({ error: 'Usuário não encontrado' });
        }

        const account = result[0];
        if (!verifyPassword(password, account.password_hash)) {
            return res.status(401).json({ error: 'Senha incorreta' });
        }

        res.json({ 
            success: true, 
            account: {
                id: account.id,
                username: account.username,
                display_name: account.display_name,
                ice: account.ice,
                inventory_data: account.inventory_data
            }
        });
    } catch (err) {
        console.error('Erro no login:', err.message);
        res.status(500).json({ error: 'Erro interno ao fazer login' });
    }
});

// POST /api/save-progress — Salva gelo, skins e nome de exibição
app.post('/api/save-progress', async (req, res) => {
    if (!sql) return res.status(503).json({ error: 'Banco não configurado' });
    const { accountId, displayName, ice, inventoryData } = req.body;

    if (!accountId) {
        return res.status(400).json({ error: 'accountId é obrigatório' });
    }

    try {
        const skinsCount = inventoryData ? inventoryData.length : 1;
        const invJson = inventoryData ? JSON.stringify(inventoryData) : null;

        await sql`
            UPDATE accounts SET
                display_name = COALESCE(${displayName}, display_name),
                ice = COALESCE(${ice}, ice),
                skins_count = COALESCE(${skinsCount}, skins_count),
                inventory_data = COALESCE(${invJson}, inventory_data),
                updated_at = NOW()
            WHERE id = ${accountId}
        `;
        res.json({ success: true });
    } catch (err) {
        console.error('Erro ao salvar progresso:', err.message);
        res.status(500).json({ error: 'Erro ao salvar dados' });
    }
});

// Rota de fallback do ranking antigo pra não quebrar
app.post('/api/ranking', async (req, res) => { res.json({ success: true, warning: 'deprecated' }); });

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
            case 'GLOBAL_SYNC': {
                activePlayers.set(socket, {
                    id: msg.playerId,
                    name: msg.playerName,
                    ice: msg.ice || 0,
                    skinsCount: msg.skinsCount || 1
                });
                
                // Se o jogador estiver em uma sala, atualiza o nome dele lá também!
                if (currentRoom) {
                    const room = rooms.get(currentRoom);
                    if (room) {
                        const me = room.players.find(p => p.id === msg.playerId);
                        if (me) {
                            me.name = msg.playerName;
                            sendPlayerList(currentRoom); // Avisa os outros na sala que o nome mudou
                        }
                    }
                }
                break;
            }


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

                // Adiciona bots se solicitado
                const fillWithBots = msg.fillWithBots !== false;
                if (fillWithBots) {
                    for (let i = room.players.length; i < totalSlots; i++) {
                        playerPositions.push({
                            id: 'bot_' + i,
                            name: `Bot ${i}`,
                            skinType: Math.random() > 0.6 ? 'sorvete' : 'normal',
                            skinColor: Math.floor(Math.random() * 0xffffff),
                            skinName: 'Bot',
                            isBot: true,
                            position: startPositions[i]
                        });
                    }
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
