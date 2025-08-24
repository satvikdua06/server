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

// Helper function to get or create room
function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      currentVideo: null,
      isPlaying: false,
      currentTime: 0,
      lastUpdate: Date.now(),
      users: new Map() // Changed to Map to store user info
    });
  }
  return rooms.get(roomId);
}

// Helper function to get video title from YouTube URL
function extractVideoTitle(url) {
  const videoId = extractVideoId(url);
  if (!videoId) return 'Unknown Video';
  return `Video ${videoId.substring(0, 8)}...`; // Simplified title
}

function extractVideoId(url) {
  const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  // Join a room
  socket.on('join-room', (roomId, username) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.username = username || `User${socket.id.substring(0, 4)}`;
    
    const room = getRoom(roomId);
    room.users.set(socket.id, {
      id: socket.id,
      username: socket.username
    });
    
    console.log(`${socket.username} joined room ${roomId}`);
    
    // Send current room state to new user
    socket.emit('room-state', {
      currentVideo: room.currentVideo,
      isPlaying: room.isPlaying,
      currentTime: room.currentTime,
      lastUpdate: room.lastUpdate,
      roomId: roomId
    });
    
    // Notify others in room
    socket.to(roomId).emit('user-joined', socket.username);
    
    // Send updated user list
    const userList = Array.from(room.users.values());
    io.to(roomId).emit('user-list', userList);
  });
  
  // Handle video changes
  socket.on('video-change', (videoData) => {
    if (!socket.roomId) return;
    
    const room = getRoom(socket.roomId);
    room.currentVideo = videoData;
    room.isPlaying = false;
    room.currentTime = 0;
    room.lastUpdate = Date.now();
    
    console.log(`Video changed in room ${socket.roomId}:`, videoData.title);
    
    // Broadcast to all users in room including sender
    io.to(socket.roomId).emit('video-change', videoData);
  });
  
  // Handle play/pause
  socket.on('play-pause', (data) => {
    if (!socket.roomId) return;
    
    const room = getRoom(socket.roomId);
    room.isPlaying = data.isPlaying;
    room.currentTime = data.currentTime || 0;
    room.lastUpdate = Date.now();
    
    console.log(`Play/pause in room ${socket.roomId}: ${data.isPlaying} at ${data.currentTime}`);
    
    // Broadcast to other users in room (not sender)
    socket.to(socket.roomId).emit('play-pause', data);
  });
  
  // Handle seeking
  socket.on('seek', (data) => {
    if (!socket.roomId) return;
    
    const room = getRoom(socket.roomId);
    room.currentTime = data.currentTime;
    room.isPlaying = data.isPlaying || false;
    room.lastUpdate = Date.now();
    
    console.log(`Seek in room ${socket.roomId} to: ${data.currentTime}`);
    
    // Broadcast to other users in room (not sender)
    socket.to(socket.roomId).emit('seek', data);
  });
  
  // Handle time sync requests
  socket.on('sync-request', () => {
    if (!socket.roomId) return;
    
    const room = getRoom(socket.roomId);
    const timeSinceLastUpdate = (Date.now() - room.lastUpdate) / 1000;
    const estimatedCurrentTime = room.currentTime + (room.isPlaying ? timeSinceLastUpdate : 0);
    
    socket.emit('sync-response', {
      currentTime: Math.max(0, estimatedCurrentTime),
      isPlaying: room.isPlaying,
      serverTime: Date.now()
    });
  });
  
  // Handle chat messages
  socket.on('chat-message', (message) => {
    if (!socket.roomId) return;
    
    const chatData = {
      username: socket.username,
      message: message.trim(),
      timestamp: Date.now()
    };
    
    // Broadcast to all users in room including sender
    io.to(socket.roomId).emit('chat-message', chatData);
  });
  
  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    if (socket.roomId) {
      const room = getRoom(socket.roomId);
      room.users.delete(socket.id);
      
      // Notify others in room
      if (socket.username) {
        socket.to(socket.roomId).emit('user-left', socket.username);
      }
      
      // Send updated user list
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

// Health check endpoint
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
