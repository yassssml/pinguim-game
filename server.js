require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

// Driver Neon Serverless — conecta via WebSocket (porta 443) em vez de TCP 5432
// Funciona mesmo em redes que bloqueiam a porta 5432 do PostgreSQL
const { neon, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');

// Configura WebSocket para ambiente Node.js
neonConfig.webSocketConstructor = ws;

const app = express();
const PORT = process.env.PORT || 3000;
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
    cors: { origin: '*' }
});

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

// --- SISTEMA MULTIPLAYER (SOCKET.IO) ---
// Estado global das salas na memória do servidor
const rooms = new Map(); 

function generateRoomCode() {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (let i = 0; i < 5; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

io.on('connection', (socket) => {
    console.log(`🔌 Novo jogador conectado: ${socket.id}`);

    // Criar Sala
    socket.on('create_room', (playerData, callback) => {
        const roomCode = generateRoomCode();
        rooms.set(roomCode, {
            code: roomCode,
            state: 'LOBBY', // LOBBY, PLANNING, SLIDING
            host: socket.id,
            players: new Map(),
            readyCount: 0
        });
        
        socket.join(roomCode);
        const room = rooms.get(roomCode);
        
        // Adiciona host como player
        room.players.set(socket.id, {
            id: socket.id,
            userId: playerData.userId,
            name: playerData.name,
            config: playerData.config, // skin config
            isHost: true,
            status: 'WAITING' // WAITING, READY
        });

        socket.roomId = roomCode;
        
        console.log(`🏠 Sala ${roomCode} criada por ${socket.id}`);
        callback({ success: true, roomCode, players: Array.from(room.players.values()) });
    });

    // Entrar na Sala
    socket.on('join_room', ({ roomCode, playerData }, callback) => {
        const code = roomCode.toUpperCase();
        const room = rooms.get(code);

        if (!room) {
            return callback({ success: false, message: 'Sala não encontrada!' });
        }
        
        if (room.state !== 'LOBBY') {
            return callback({ success: false, message: 'A partida já começou!' });
        }

        if (room.players.size >= 10) {
            return callback({ success: false, message: 'A sala está cheia!' });
        }

        socket.join(code);
        room.players.set(socket.id, {
            id: socket.id,
            userId: playerData.userId,
            name: playerData.name,
            config: playerData.config,
            isHost: false,
            status: 'WAITING'
        });

        socket.roomId = code;

        // Avisa os outros que alguém entrou
        io.to(code).emit('room_update', {
            players: Array.from(room.players.values())
        });

        console.log(`👤 ${socket.id} entrou na sala ${code}`);
        callback({ success: true, roomCode: code, players: Array.from(room.players.values()) });
    });

    // Iniciar Jogo (Apenas Host)
    socket.on('start_game', () => {
        const room = rooms.get(socket.roomId);
        if (room && room.host === socket.id && room.state === 'LOBBY') {
            room.state = 'PLANNING';
            io.to(room.code).emit('game_started', {
                players: Array.from(room.players.values())
            });
            console.log(`🎮 Jogo iniciado na sala ${room.code}`);
        }
    });

    // Enviar Jogada (Ângulo e Força)
    socket.on('lock_turn', (turnData) => {
        const room = rooms.get(socket.roomId);
        if (room && room.state === 'PLANNING') {
            if (turnData._isBotId) {
                // Host enviando jogada de bot
                if (socket.id === room.host) {
                    room.botTurns = room.botTurns || new Map();
                    room.botTurns.set(turnData._isBotId, turnData);
                }
                return; // bots não contam pro readyCount
            }

            const player = room.players.get(socket.id);
            if (player && player.status !== 'READY') {
                player.turnData = turnData; // { power, targetAngle }
                player.status = 'READY';
                room.readyCount++;

                io.to(room.code).emit('player_ready', { id: socket.id });

                // Se todos jogaram, processa e emite o resultado
                if (room.readyCount >= room.players.size) {
                    room.state = 'SLIDING';
                    room.readyCount = 0;

                    const allTurns = [];
                    room.players.forEach((p) => {
                        allTurns.push({
                            id: p.id,
                            power: p.turnData.power,
                            targetAngle: p.turnData.targetAngle
                        });
                        p.status = 'WAITING'; // reseta status para o próximo turno
                    });
                    
                    if (room.botTurns) {
                        room.botTurns.forEach((botData, botId) => {
                            allTurns.push({
                                id: botId,
                                power: botData.power,
                                targetAngle: botData.targetAngle
                            });
                        });
                        room.botTurns.clear();
                    }

                    // Avisa para os clients simularem a física
                    io.to(room.code).emit('start_slide', allTurns);
                }
            }
        }
    });

    // Jogadores avisam que terminaram de deslizar
    socket.on('slide_finished', (survivalData) => {
        const room = rooms.get(socket.roomId);
        if (room && room.state === 'SLIDING') {
            if (survivalData._isBotId) {
                // Host enviando morte de bot
                if (socket.id === room.host) {
                    room.botAliveData = room.botAliveData || new Map();
                    room.botAliveData.set(survivalData._isBotId, survivalData.alive);
                }
                return;
            }

            const player = room.players.get(socket.id);
            if (player && player.status !== 'FINISHED_SLIDING') {
                player.status = 'FINISHED_SLIDING';
                player.alive = survivalData.alive;
                room.readyCount++;

                if (room.readyCount >= room.players.size) {
                    // Verifica ganhador
                    const survivorPlayers = Array.from(room.players.values()).filter(p => p.alive);
                    
                    let botsAlive = 0;
                    if (room.botAliveData) {
                        room.botAliveData.forEach((isAlive) => { if (isAlive) botsAlive++; });
                        room.botAliveData.clear();
                    }

                    const totalAlive = survivorPlayers.length + botsAlive;
                    
                    if (totalAlive <= 1) {
                        room.state = 'GAME_OVER';
                        io.to(room.code).emit('game_over', {
                            winnerId: (survivorPlayers.length === 1 && botsAlive === 0) ? survivorPlayers[0].id : null
                        });
                    } else {
                        // Novo turno
                        room.state = 'PLANNING';
                        room.readyCount = 0;
                        room.players.forEach(p => { if(p.alive) p.status = 'WAITING'; });
                        io.to(room.code).emit('next_turn');
                    }
                }
            }
        }
    });

    // Desconexão
    socket.on('disconnect', () => {
        console.log(`❌ Jogador desconectado: ${socket.id}`);
        if (socket.roomId) {
            const room = rooms.get(socket.roomId);
            if (room) {
                room.players.delete(socket.id);
                
                // Se a sala ficar vazia, apaga
                if (room.players.size === 0) {
                    rooms.delete(socket.roomId);
                    console.log(`🗑️ Sala ${socket.roomId} removida por inatividade.`);
                } else {
                    // Se o host saiu, passa o host pro próximo
                    if (room.host === socket.id) {
                        const nextHostId = room.players.keys().next().value;
                        const nextHost = room.players.get(nextHostId);
                        nextHost.isHost = true;
                        room.host = nextHostId;
                    }
                    io.to(room.code).emit('room_update', {
                        players: Array.from(room.players.values())
                    });
                }
            }
        }
    });
});

// --- START ---
httpServer.listen(PORT, async () => {
    console.log(`\n🐧 Penguin Knockout rodando em: http://localhost:${PORT}`);
    const ok = await initDB();
    if (ok) {
        console.log(`🗄️  Banco de dados: Neon PostgreSQL ✅\n`);
    } else {
        console.log(`🗄️  Banco de dados: OFFLINE ⚠️  (ranking não funcionará)\n`);
    }
});
