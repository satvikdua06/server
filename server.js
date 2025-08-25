const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fetch = require('node-fetch'); // Ensure you have run: npm install node-fetch@2

const app = express();
const server = http.createServer(app);

// Configure CORS for Socket.io
const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:3000", "https://*.vercel.app", "https://*.onrender.com", "*"],
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(cors({
  origin: ["http://localhost:3000", "https://*.vercel.app", "https://*.onrender.com", "*"],
  credentials: true
}));

app.use(express.json());

// --- NEW SEARCH ROUTE USING SAAVN V4 API ---
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) {
        return res.status(400).json({ error: 'Search query is required' });
    }
    try {
        // This is the new, more powerful API endpoint
        const apiUrl = `https://jiosaavn-api-2-0.vercel.app/api/search?query=${encodeURIComponent(query)}`;
        const response = await fetch(apiUrl);
        const data = await response.json();
        // The data structure is slightly different, so we map it to our needs
        const songs = data?.data?.songs?.results || [];
        res.json({ data: { results: songs } });
    } catch (error) {
        console.error('Search API error:', error);
        res.status(500).json({ error: 'Failed to fetch search results' });
    }
});

// Store room state
const rooms = new Map();

// Helper: get or create room
function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      currentVideo: null,
      isPlaying: false,
      currentTime: 0,
      lastUpdate: Date.now(),
      lastController: null,
      users: new Map(),
      hostId: null
    });
  }
  return rooms.get(roomId);
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', (roomId, username) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.username = username || `User${socket.id.substring(0, 4)}`;
    const room = getRoom(roomId);
    if (!room.hostId) {
      room.hostId = socket.id;
      console.log(`🎬 ${socket.username} is host of room ${roomId}`);
    }
    room.users.set(socket.id, { id: socket.id, username: socket.username });
    console.log(`${socket.username} joined room ${roomId}`);
    socket.emit('room-state', {
      currentVideo: room.currentVideo,
      isPlaying: room.isPlaying,
      currentTime: room.currentTime,
      lastUpdate: room.lastUpdate,
      roomId: roomId,
      hostId: room.hostId,
      lastController: room.lastController
    });
    socket.to(roomId).emit('user-joined', { username: socket.username, userId: socket.id });
    const userList = Array.from(room.users.values());
    io.to(roomId).emit('user-list', userList);
  });

  socket.on('video-change', (videoData) => {
    if (!socket.roomId) return;
    const room = getRoom(socket.roomId);
    room.currentVideo = videoData;
    room.isPlaying = false;
    room.currentTime = 0;
    room.lastUpdate = Date.now();
    room.lastController = socket.id;
    console.log(`Video changed in room ${socket.roomId} by ${socket.username}:`, videoData.title);
    io.to(socket.roomId).emit('video-change', {
      ...videoData,
      changedBy: socket.username,
      changerId: socket.id
    });
  });

  socket.on('play-pause', (data) => {
    if (!socket.roomId) return;
    const room = getRoom(socket.roomId);
    room.isPlaying = data.isPlaying;
    room.currentTime = data.currentTime || 0;
    room.lastUpdate = Date.now();
    room.lastController = socket.id;
    socket.to(socket.roomId).emit('play-pause', {
      ...data,
      controlledBy: socket.username,
      controllerId: socket.id
    });
  });

  socket.on('seek', (data) => {
    if (!socket.roomId) return;
    const room = getRoom(socket.roomId);
    room.currentTime = data.currentTime;
    room.isPlaying = data.isPlaying || false;
    room.lastUpdate = Date.now();
    room.lastController = socket.id;
    socket.to(socket.roomId).emit('seek', { ...data, controlledBy: socket.username, controllerId: socket.id });
  });

  socket.on('sync-request', () => {
    if (!socket.roomId) return;
    const room = getRoom(socket.roomId);
    const timeSinceLastUpdate = (Date.now() - room.lastUpdate) / 1000;
    const estimatedCurrentTime = room.currentTime + (room.isPlaying ? timeSinceLastUpdate : 0);
    socket.emit('sync-response', {
      currentTime: Math.max(0, estimatedCurrentTime),
      isPlaying: room.isPlaying,
      type: room.currentVideo?.type || "youtube",
      serverTime: Date.now(),
      lastController: room.lastController
    });
  });

  socket.on('state-update', (data) => {
    if (!socket.roomId) return;
    const room = getRoom(socket.roomId);
    room.isPlaying = data.isPlaying;
    room.currentTime = data.currentTime || 0;
    room.lastUpdate = Date.now();
    room.lastController = socket.id;
    socket.to(socket.roomId).emit('state-update', { ...data, from: socket.username, fromId: socket.id });
  });

  socket.on('chat-message', (message) => {
    if (!socket.roomId) return;
    const chatData = {
      username: socket.username,
      message: message.trim(),
      timestamp: Date.now(),
      userId: socket.id
    };
    io.to(socket.roomId).emit('chat-message', chatData);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    if (socket.roomId) {
      const room = getRoom(socket.roomId);
      room.users.delete(socket.id);
      if (room.hostId === socket.id) {
        const nextHost = room.users.keys().next().value || null;
        room.hostId = nextHost;
        if (nextHost) {
          const newHost = room.users.get(nextHost);
          console.log(`👑 New host in room ${socket.roomId}: ${newHost.username}`);
          io.to(socket.roomId).emit('host-change', {
            newHostId: nextHost,
            newHostName: newHost.username
          });
        }
      }
      if (socket.username) {
        socket.to(socket.roomId).emit('user-left', { username: socket.username, userId: socket.id });
      }
      const userList = Array.from(room.users.values());
      socket.to(socket.roomId).emit('user-list', userList);
      if (room.users.size === 0) {
        rooms.delete(socket.roomId);
        console.log(`Room ${socket.roomId} deleted (empty)`);
      }
    }
  });
});

app.get('/', (req, res) => {
  res.json({
    status: 'Sync Music Server is running!',
    rooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    rooms: rooms.size,
    uptime: process.uptime()
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 Sync Music Server running on port ${PORT}`);
  console.log(`📡 Socket.IO ready for connections`);
});
