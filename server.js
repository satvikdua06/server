const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Configure CORS for Socket.io
const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:3000", "https://*.vercel.app", "https://*.onrender.com", "https://*.claude.ai"],
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(cors({
  origin: ["http://localhost:3000", "https://*.vercel.app", "https://*.onrender.com", "https://*.claude.ai"],
  credentials: true
}));

app.use(express.json());

// Store room state
const rooms = new Map();

// Helper function to get or create room
function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      currentMedia: null, // Changed from currentVideo to currentMedia
      mediaType: null, // 'youtube' or 'audio'
      isPlaying: false,
      currentTime: 0,
      lastUpdate: Date.now(),
      users: new Map(),
      chatHistory: [] // Store recent chat messages
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

// Helper function to validate media data
function validateMediaData(mediaData, type) {
  if (!mediaData || typeof mediaData !== 'object') return false;
  
  if (type === 'youtube') {
    return mediaData.videoId && mediaData.title;
  } else if (type === 'audio') {
    return mediaData.id && mediaData.title && mediaData.preview_url;
  }
  
  return false;
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
      username: socket.username,
      joinedAt: Date.now()
    });
    
    console.log(`${socket.username} joined room ${roomId}`);
    
    // Send current room state to new user
    socket.emit('room-state', {
      currentMedia: room.currentMedia,
      mediaType: room.mediaType,
      isPlaying: room.isPlaying,
      currentTime: room.currentTime,
      lastUpdate: room.lastUpdate,
      roomId: roomId,
      chatHistory: room.chatHistory.slice(-10) // Send last 10 messages
    });
    
    // Notify others in room
    socket.to(roomId).emit('user-joined', socket.username);
    
    // Send updated user list
    const userList = Array.from(room.users.values());
    io.to(roomId).emit('user-list', userList);
  });
  
  // Handle YouTube video changes
  socket.on('video-change', (videoData) => {
    if (!socket.roomId) return;
    if (!validateMediaData(videoData, 'youtube')) {
      socket.emit('error', 'Invalid video data');
      return;
    }
    
    const room = getRoom(socket.roomId);
    room.currentMedia = videoData;
    room.mediaType = 'youtube';
    room.isPlaying = false;
    room.currentTime = 0;
    room.lastUpdate = Date.now();
    
    console.log(`YouTube video changed in room ${socket.roomId}:`, videoData.title);
    
    // Broadcast to all users in room including sender
    io.to(socket.roomId).emit('video-change', videoData);
    
    // Add system message to chat
    const systemMessage = {
      username: 'System',
      message: `${socket.username} loaded: ${videoData.title}`,
      timestamp: Date.now(),
      type: 'system'
    };
    room.chatHistory.push(systemMessage);
    io.to(socket.roomId).emit('chat-message', systemMessage);
  });
  
  // Handle audio track changes
  socket.on('audio-change', (audioData) => {
    if (!socket.roomId) return;
    if (!validateMediaData(audioData, 'audio')) {
      socket.emit('error', 'Invalid audio data');
      return;
    }
    
    const room = getRoom(socket.roomId);
    room.currentMedia = audioData;
    room.mediaType = 'audio';
    room.isPlaying = false;
    room.currentTime = 0;
    room.lastUpdate = Date.now();
    
    console.log(`Audio track changed in room ${socket.roomId}:`, audioData.title);
    
    // Broadcast to all users in room including sender
    io.to(socket.roomId).emit('audio-change', audioData);
    
    // Add system message to chat
    const systemMessage = {
      username: 'System',
      message: `${socket.username} loaded: ${audioData.title} - ${audioData.artist}`,
      timestamp: Date.now(),
      type: 'system'
    };
    room.chatHistory.push(systemMessage);
    io.to(socket.roomId).emit('chat-message', systemMessage);
  });
  
  // Handle play/pause for both media types
  socket.on('play-pause', (data) => {
    if (!socket.roomId) return;
    
    const room = getRoom(socket.roomId);
    
    // Validate data
    if (typeof data.isPlaying !== 'boolean' || typeof data.currentTime !== 'number') {
      socket.emit('error', 'Invalid play-pause data');
      return;
    }
    
    room.isPlaying = data.isPlaying;
    room.currentTime = Math.max(0, data.currentTime);
    room.lastUpdate = Date.now();
    
    console.log(`Play/pause in room ${socket.roomId}: ${data.isPlaying} at ${data.currentTime}s (${room.mediaType})`);
    
    // Broadcast to other users in room (not sender)
    socket.to(socket.roomId).emit('play-pause', {
      ...data,
      mediaType: room.mediaType
    });
  });
  
  // Handle seeking for both media types
  socket.on('seek', (data) => {
    if (!socket.roomId) return;
    
    const room = getRoom(socket.roomId);
    
    // Validate data
    if (typeof data.currentTime !== 'number') {
      socket.emit('error', 'Invalid seek data');
      return;
    }
    
    room.currentTime = Math.max(0, data.currentTime);
    room.isPlaying = data.isPlaying || false;
    room.lastUpdate = Date.now();
    
    console.log(`Seek in room ${socket.roomId} to: ${data.currentTime}s (${room.mediaType})`);
    
    // Broadcast to other users in room (not sender)
    socket.to(socket.roomId).emit('seek', {
      ...data,
      mediaType: room.mediaType
    });
  });
  
  // Handle time sync requests
  socket.on('sync-request', () => {
    if (!socket.roomId) return;
    
    const room = getRoom(socket.roomId);
    const timeSinceLastUpdate = (Date.now() - room.lastUpdate) / 1000;
    const estimatedCurrentTime = room.currentTime + (room.isPlaying ? timeSinceLastUpdate : 0);
    
    // Get media duration for validation (if available)
    let maxTime = null;
    if (room.currentMedia) {
      if (room.mediaType === 'audio' && room.currentMedia.duration) {
        maxTime = room.currentMedia.duration;
      }
    }
    
    const syncTime = Math.max(0, estimatedCurrentTime);
    const finalTime = maxTime ? Math.min(syncTime, maxTime) : syncTime;
    
    socket.emit('sync-response', {
      currentTime: finalTime,
      isPlaying: room.isPlaying,
      mediaType: room.mediaType,
      currentMedia: room.currentMedia,
      serverTime: Date.now()
    });
    
    console.log(`Sync response for room ${socket.roomId}: ${finalTime}s, playing: ${room.isPlaying}`);
  });
  
  // Handle chat messages with enhanced features
  socket.on('chat-message', (message) => {
    if (!socket.roomId) return;
    if (!message || typeof message !== 'string') return;
    
    const trimmedMessage = message.trim();
    if (!trimmedMessage || trimmedMessage.length > 500) return; // Limit message length
    
    const chatData = {
      username: socket.username,
      message: trimmedMessage,
      timestamp: Date.now(),
      type: 'user'
    };
    
    const room = getRoom(socket.roomId);
    room.chatHistory.push(chatData);
    
    // Keep only last 50 messages
    if (room.chatHistory.length > 50) {
      room.chatHistory = room.chatHistory.slice(-50);
    }
    
    // Broadcast to all users in room including sender
    io.to(socket.roomId).emit('chat-message', chatData);
    
    console.log(`Chat in room ${socket.roomId} from ${socket.username}: ${trimmedMessage}`);
  });
  
  // Handle media info requests (for when users need current media details)
  socket.on('media-info-request', () => {
    if (!socket.roomId) return;
    
    const room = getRoom(socket.roomId);
    socket.emit('media-info-response', {
      currentMedia: room.currentMedia,
      mediaType: room.mediaType,
      isPlaying: room.isPlaying,
      currentTime: room.currentTime
    });
  });
  
  // Handle room stats request
  socket.on('room-stats-request', () => {
    if (!socket.roomId) return;
    
    const room = getRoom(socket.roomId);
    const userList = Array.from(room.users.values());
    
    socket.emit('room-stats-response', {
      roomId: socket.roomId,
      userCount: userList.length,
      users: userList,
      currentMedia: room.currentMedia,
      mediaType: room.mediaType,
      uptime: Date.now() - Math.min(...userList.map(u => u.joinedAt))
    });
  });
  
  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    if (socket.roomId) {
      const room = getRoom(socket.roomId);
      room.users.delete(socket.id);
      
      // Add system message about user leaving
      if (socket.username) {
        const systemMessage = {
          username: 'System',
          message: `${socket.username} left the room`,
          timestamp: Date.now(),
          type: 'system'
        };
        room.chatHistory.push(systemMessage);
        socket.to(socket.roomId).emit('chat-message', systemMessage);
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
  
  // Handle errors
  socket.on('error', (error) => {
    console.error(`Socket error for user ${socket.id}:`, error);
  });
});

// REST API Endpoints

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Enhanced Sync Music Server is running!', 
    rooms: rooms.size,
    features: ['YouTube Videos', 'Audio Tracks', 'Multi-API Search', 'Real-time Chat', 'User Management'],
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    rooms: rooms.size,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: '2.0.0'
  });
});

// Get room information
app.get('/api/room/:roomId', (req, res) => {
  const roomId = req.params.roomId;
  
  if (!rooms.has(roomId)) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  const room = rooms.get(roomId);
  const userList = Array.from(room.users.values());
  
  res.json({
    roomId,
    userCount: userList.length,
    users: userList.map(user => ({ username: user.username, joinedAt: user.joinedAt })),
    currentMedia: room.currentMedia,
    mediaType: room.mediaType,
    isPlaying: room.isPlaying,
    lastUpdate: room.lastUpdate,
    chatMessageCount: room.chatHistory.length
  });
});

// Get server statistics
app.get('/api/stats', (req, res) => {
  const totalUsers = Array.from(rooms.values()).reduce((sum, room) => sum + room.users.size, 0);
  const activeRooms = Array.from(rooms.values()).filter(room => room.users.size > 0).length;
  
  res.json({
    totalRooms: rooms.size,
    activeRooms,
    totalUsers,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: Date.now()
  });
});

// Create a new room (optional endpoint for external integrations)
app.post('/api/room/create', (req, res) => {
  const { roomId, creatorName } = req.body;
  
  if (!roomId || roomId.length < 3 || roomId.length > 20) {
    return res.status(400).json({ error: 'Room ID must be between 3-20 characters' });
  }
  
  if (rooms.has(roomId)) {
    return res.status(409).json({ error: 'Room already exists' });
  }
  
  // Create room (will be created when first user joins)
  res.json({
    roomId,
    message: 'Room ready to be created',
    joinUrl: `${req.protocol}://${req.get('host')}?room=${roomId}`
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Express error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Handle 404
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`🎵 Enhanced Sync Music Server running on ${HOST}:${PORT}`);
  console.log(`📡 Socket.IO ready for connections`);
  console.log(`🎶 Supporting: YouTube Videos + Audio Tracks from iTunes, Deezer, JioSaavn`);
  console.log(`💬 Features: Real-time sync, Chat, User management`);
});
