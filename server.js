const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Configure CORS for Socket.io
const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:3000", "https://*.vercel.app", "https://*.onrender.com"],
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(cors({
  origin: ["http://localhost:3000", "https://*.vercel.app", "https://*.onrender.com"],
  credentials: true
}));

app.use(express.json());

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
      users: new Map(),
      hostId: null
    });
  }
  return rooms.get(roomId);
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // --- Join Room ---
  socket.on('join-room', (roomId, username) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.username = username || `User${socket.id.substring(0, 4)}`;

    const room = getRoom(roomId);

    // If first user, make host
    if (!room.hostId) {
      room.hostId = socket.id;
      console.log(`🎬 ${socket.username} is host of room ${roomId}`);
    }

    room.users.set(socket.id, {
      id: socket.id,
      username: socket.username
    });

    console.log(`${socket.username} joined room ${roomId}`);

    // Send current room state
    socket.emit('room-state', {
      currentVideo: room.currentVideo,
      isPlaying: room.isPlaying,
      currentTime: room.currentTime,
      lastUpdate: room.lastUpdate,
      roomId: roomId,
      hostId: room.hostId
    });

    // Notify others
    socket.to(roomId).emit('user-joined', socket.username);

    // Send updated user list
    const userList = Array.from(room.users.values());
    io.to(roomId).emit('user-list', userList);
  });

  // --- Video change ---
  socket.on('video-change', (videoData) => {
    if (!socket.roomId) return;

    const room = getRoom(socket.roomId);
    room.currentVideo = videoData;
    room.isPlaying = false;
    room.currentTime = 0;
    room.lastUpdate = Date.now();

    console.log(`Video changed in room ${socket.roomId}:`, videoData.title);

    io.to(socket.roomId).emit('video-change', videoData);
  });

  // --- Play / Pause ---
  socket.on('play-pause', (data) => {
    if (!socket.roomId) return;

    const room = getRoom(socket.roomId);
    room.isPlaying = data.isPlaying;
    room.currentTime = data.currentTime || 0;
    room.lastUpdate = Date.now();

    socket.to(socket.roomId).emit('play-pause', data);
  });

  // --- Seek ---
  socket.on('seek', (data) => {
    if (!socket.roomId) return;

    const room = getRoom(socket.roomId);
    room.currentTime = data.currentTime;
    room.isPlaying = data.isPlaying || false;
    room.lastUpdate = Date.now();

    socket.to(socket.roomId).emit('seek', data);
  });

  // --- Manual Sync Request ---
  socket.on('sync-request', () => {
    if (!socket.roomId) return;

    const room = getRoom(socket.roomId);
    const timeSinceLastUpdate = (Date.now() - room.lastUpdate) / 1000;
    const estimatedCurrentTime =
      room.currentTime + (room.isPlaying ? timeSinceLastUpdate : 0);

    socket.emit('sync-response', {
      currentTime: Math.max(0, estimatedCurrentTime),
      isPlaying: room.isPlaying,
      type: room.currentVideo?.type || "youtube",
      serverTime: Date.now()
    });
  });

  // --- Heartbeat (Host only) ---
  socket.on('heartbeat', (data) => {
    if (!socket.roomId) return;
    const room = getRoom(socket.roomId);

    // Only host updates heartbeat
    if (room.hostId !== socket.id) return;

    room.isPlaying = data.isPlaying;
    room.currentTime = data.currentTime || 0;
    room.lastUpdate = Date.now();

    // Send to all others
    socket.to(socket.roomId).emit('heartbeat', data);

    // console.log(`❤️ Heartbeat from host ${socket.username} in ${socket.roomId}`);
  });

  // --- Chat ---
  socket.on('chat-message', (message) => {
    if (!socket.roomId) return;

    const chatData = {
      username: socket.username,
      message: message.trim(),
      timestamp: Date.now()
    };

    io.to(socket.roomId).emit('chat-message', chatData);
  });

  // --- Disconnect ---
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);

    if (socket.roomId) {
      const room = getRoom(socket.roomId);
      room.users.delete(socket.id);

      // If host left, reassign to first user in room
      if (room.hostId === socket.id) {
        const nextHost = room.users.keys().next().value || null;
        room.hostId = nextHost;
        if (nextHost) {
          const newHost = room.users.get(nextHost);
          console.log(`👑 New host in room ${socket.roomId}: ${newHost.username}`);
          io.to(socket.roomId).emit('room-state', {
            ...room,
            roomId: socket.roomId,
            hostId: room.hostId
          });
        } else {
          console.log(`Room ${socket.roomId} now has no host`);
        }
      }

      if (socket.username) {
        socket.to(socket.roomId).emit('user-left', socket.username);
      }

      const userList = Array.from(room.users.values());
      socket.to(socket.roomId).emit('user-list', userList);

      // Clean up empty rooms
      if (room.users.size === 0) {
        rooms.delete(socket.roomId);
        console.log(`Room ${socket.roomId} deleted (empty)`);
      }
    }
  });
});

// Health check
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
