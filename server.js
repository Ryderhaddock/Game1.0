const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// Configure CORS to allow your client's origin
const io = new Server(server, {
  cors: {
    origin: "*", // In production, you should restrict this to your game's URL
    methods: ["GET", "POST"]
  }
});

// Serve static files from the root directory
app.use(express.static(__dirname));

// --- State Management ---
const queues = {
    '1v1': [],
    '2v2': [],
    '3v3': []
};
const gameRooms = {}; // Stores state for active rooms: { roomId: { players: [], hostId: '' } }

// --- Helper Functions ---
function findRoomBySocketId(socketId) {
    for (const roomId in gameRooms) {
        const room = gameRooms[roomId];
        if (room.players.some(p => p.id === socketId)) {
            return roomId;
        }
    }
    return null;
}


function designateNewHost(roomId) {
    const room = gameRooms[roomId];
    if (!room) return;

    // Remove the old host before selecting a new one
    room.players = room.players.filter(p => p.id !== room.hostId);

    if (room.players.length === 0) {
        console.log(`[Game] Room ${roomId} is empty. Deleting.`);
        delete gameRooms[roomId];
        return;
    }
    
    // Designate the next player as the host
    room.hostId = room.players[0].id;
    console.log(`[Host] New host for room ${roomId} is ${room.hostId}`);
    
    // Notify all remaining players of the new host
    io.to(roomId).emit('newHost', room.hostId);
}

// --- Socket.IO Connection Logic ---
io.on('connection', (socket) => {
    console.log(`[Connection] ✅ User connected: ${socket.id}`);

    // --- Queue and Matchmaking ---
    socket.on('joinQueue', ({ gameMode, playerName }) => {
        if (!queues[gameMode]) {
            console.log(`[Error] Invalid game mode from ${socket.id}: ${gameMode}`);
            return;
        }

        console.log(`[Queue] ${playerName} (${socket.id}) joined ${gameMode} queue.`);
        
        // Prevent player from joining multiple queues by cleaning up first
        Object.values(queues).forEach(q => {
             const index = q.findIndex(s => s.id === socket.id);
             if (index !== -1) q.splice(index, 1);
        });

        // Add player properties to the socket object itself for easy access
        socket.playerName = playerName;
        socket.gameMode = gameMode;
        
        queues[gameMode].push(socket);
        socket.emit('queueJoined', `Searching for a ${gameMode} match...`);

        const neededPlayers = parseInt(gameMode.charAt(0)) * 2;

        if (queues[gameMode].length >= neededPlayers) {
            const playerSockets = queues[gameMode].splice(0, neededPlayers);
            const roomId = `room_${Math.random().toString(36).substring(2, 9)}`;
            
            const hostSocket = playerSockets[0];
            const hostId = hostSocket.id;

            const playersForMatch = playerSockets.map(s => ({ id: s.id, name: s.playerName }));
            
            gameRooms[roomId] = { players: playersForMatch, hostId: hostId, gameMode: gameMode };

            console.log(`[Game] Creating ${gameMode} match in ${roomId}. Host: ${hostId}`);

            playerSockets.forEach(playerSocket => {
                playerSocket.join(roomId);
                playerSocket.emit('matchFound', {
                    roomId: roomId,
                    players: playersForMatch,
                    hostId: hostId,
                    gameMode: gameMode
                });
            });
        }
    });

    // --- In-Game Communication ---

    // Relays state from a non-host client to the host client
    socket.on('playerStateUpdate', (data) => {
        const roomId = findRoomBySocketId(socket.id);
        if (roomId && gameRooms[roomId] && gameRooms[roomId].hostId !== socket.id) {
            const hostSocket = io.sockets.sockets.get(gameRooms[roomId].hostId);
            if (hostSocket) {
                // Forward the data, including the sender's ID
                hostSocket.emit('playerStateUpdate', { ...data, id: socket.id });
            }
        }
    });

    // Client requests to fire, host validates and executes
    socket.on('fireRequest', (data) => {
        const roomId = findRoomBySocketId(socket.id);
        if(roomId && gameRooms[roomId] && gameRooms[roomId].hostId !== socket.id) {
            const hostSocket = io.sockets.sockets.get(gameRooms[roomId].hostId);
            if (hostSocket) {
                hostSocket.emit('fireRequest', { ...data, id: socket.id });
            }
        }
    });
    
    // Dedicated event for reload requests from clients
    socket.on('requestReload', () => {
        const roomId = findRoomBySocketId(socket.id);
        // Only forward if the sender is a client in a room
        if (roomId && gameRooms[roomId] && gameRooms[roomId].hostId !== socket.id) {
            const hostSocket = io.sockets.sockets.get(gameRooms[roomId].hostId);
            if (hostSocket) {
                // Tell the host WHICH client wants to reload.
                hostSocket.emit('reloadRequestFromClient', { clientId: socket.id });
            }
        }
    });
    
    // Relays the authoritative game state from the host to all other clients
    socket.on('gameStateSync', (data) => {
        const roomId = data.roomId;
        if (roomId && gameRooms[roomId] && gameRooms[roomId].hostId === socket.id) {
            socket.to(roomId).emit('gameStateSync', data);
        }
    });

    // Host tells clients to start the kill cam
    socket.on('startKillCam', (data) => {
        const roomId = data.roomId;
        if (roomId && gameRooms[roomId] && gameRooms[roomId].hostId === socket.id) {
            // Broadcast to everyone in the room, including the host
            io.to(roomId).emit('startKillCam', data);
        }
    });

    // Generic event forwarder from host to other clients in the room
    const forwardHostEvent = (eventName) => {
        socket.on(eventName, (data) => {
            const roomId = data.roomId;
            if (roomId && gameRooms[roomId] && gameRooms[roomId].hostId === socket.id) {
                if (['roundOver', 'gameOver', 'killFeedEvent'].includes(eventName)) {
                    io.to(roomId).emit(eventName, data);
                } else {
                    socket.to(roomId).emit(eventName, data);
                }
            }
        });
    };
    
    ['bombPlanted', 'bombDefused', 'bombExploded', 'killFeedEvent', 'roundOver', 'gameOver'].forEach(forwardHostEvent);
    
    // --- Disconnect Logic ---
    socket.on('disconnect', () => {
        console.log(`[Connection] ❌ User disconnected: ${socket.id}`);
        
        // Remove from any queue
        Object.keys(queues).forEach(mode => {
            const index = queues[mode].findIndex(s => s.id === socket.id);
            if (index !== -1) {
                queues[mode].splice(index, 1);
                console.log(`[Queue] Removed ${socket.id} from ${mode} queue.`);
            }
        });

        // Handle disconnect from a game room
        const roomId = findRoomBySocketId(socket.id);
        if (roomId && gameRooms[roomId]) {
            const room = gameRooms[roomId];
            
            console.log(`[Game] Player ${socket.id} left room ${roomId}.`);
            socket.to(roomId).emit('playerListUpdate', room.players.filter(p => p.id !== socket.id));

            // If the host disconnected, designate a new one
            if (socket.id === room.hostId) {
                designateNewHost(roomId);
            } else {
                 // If a client disconnected, just remove them from the list
                 room.players = room.players.filter(p => p.id !== socket.id);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
// Listen on 0.0.0.0 to accept connections from any IP, not just localhost
server.listen(PORT, '0.0.0.0', () => {
    // Updated log message to be less confusing
    console.log(`🚀 Server listening on port ${PORT}`);
});