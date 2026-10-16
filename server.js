const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Helper: Get local network IP addresses (IPv4)
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

// Load 20 Eden questions
let defaultQuestions = [];
try {
  const qData = fs.readFileSync(path.join(__dirname, 'public', 'questions.json'), 'utf8');
  defaultQuestions = JSON.parse(qData);
} catch (err) {
  console.error('Error loading default questions:', err);
}

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const rooms = {};

function generateRoomCode() {
  let code = Math.floor(1000 + Math.random() * 9000).toString();
  while (rooms[code]) {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  }
  return code;
}

// API: Generate QR Code Data URL
app.get('/api/qr', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });
  try {
    const qrDataUrl = await QRCode.toDataURL(url, {
      margin: 2,
      width: 720,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#150024', // High contrast deep purple/black for easy camera focus from far distance
        light: '#FFFFFF'
      }
    });
    res.json({ qr: qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR' });
  }
});

// API: Get Server Info & Network IP
app.get('/api/info', (req, res) => {
  const ips = getLocalIpAddresses();
  res.json({
    localIps: ips,
    primaryIp: ips[0] || 'localhost',
    port: process.env.PORT || 3000,
    totalQuestions: defaultQuestions.length
  });
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Host creates room
  socket.on('create_room', ({ questionCount = 20, timerDuration = 30, shuffle = false } = {}) => {
    const roomCode = generateRoomCode();
    
    let selectedQuestions = shuffle ? shuffleArray(defaultQuestions) : [...defaultQuestions];

    const limit = parseInt(questionCount, 10);
    if (limit > 0 && limit < selectedQuestions.length) {
      selectedQuestions = selectedQuestions.slice(0, limit);
    }

    const duration = parseInt(timerDuration, 10) || 30;

    rooms[roomCode] = {
      code: roomCode,
      hostSocketId: socket.id,
      players: {}, // mapped by persistent playerId
      questions: selectedQuestions,
      currentQuestionIndex: -1,
      status: 'lobby', // 'lobby' | 'playing' | 'revealed' | 'finished'
      questionTimerDuration: duration,
      timer: duration,
      timerInterval: null,
      isPaused: false
    };

    socket.join(roomCode);
    socket.emit('room_created', {
      roomCode,
      totalQuestions: selectedQuestions.length,
      timerDuration: duration
    });
  });

  // Player joins or reconnects
  socket.on('join_room', ({ roomCode, playerId, playerName }) => {
    const room = rooms[roomCode];
    if (!room) {
      return socket.emit('join_error', 'קוד חדר לא קיים או שהמשחק הסתיים');
    }

    const pId = playerId || socket.id;
    const cleanName = playerName ? playerName.trim() : 'אורח/ת ' + pId.substring(0, 4);

    let player = room.players[pId];
    if (player) {
      // Reconnection
      player.socketId = socket.id;
      player.name = cleanName;
      player.active = true;
    } else {
      // New Player
      player = {
        playerId: pId,
        socketId: socket.id,
        name: cleanName,
        score: 0,
        streak: 0,
        correctCount: 0,
        totalAnswered: 0,
        totalSpeedSeconds: 0,
        hasAnswered: false,
        lastAnswerIndex: null,
        lastAnswerTime: 0,
        active: true
      };
      room.players[pId] = player;
    }

    socket.join(roomCode);

    // Prepare current question payload if game in progress
    let currentQPayload = null;
    if (room.status === 'playing' || room.status === 'revealed') {
      const q = room.questions[room.currentQuestionIndex];
      currentQPayload = {
        questionIndex: room.currentQuestionIndex,
        totalQuestions: room.questions.length,
        id: q ? q.id : 1,
        question: q ? q.question : '',
        category: q ? q.category : '',
        image: q ? (q.image || 'images/eden_heart.jpg') : 'images/eden_heart.jpg',
        options: q ? q.options : [],
        timer: room.timer,
        correctIndex: room.status === 'revealed' ? q.correctIndex : null,
        explanation: room.status === 'revealed' ? q.explanation : null
      };
    }

    socket.emit('joined_successfully', {
      roomCode,
      playerId: pId,
      playerName: cleanName,
      status: room.status,
      currentQuestionIndex: room.currentQuestionIndex,
      totalQuestions: room.questions.length,
      score: player.score,
      streak: player.streak,
      lastAnswerIndex: player.lastAnswerIndex,
      currentQuestion: currentQPayload
    });

    const playerList = Object.values(room.players).map(p => ({
      id: p.playerId,
      name: p.name,
      score: p.score,
      active: p.active
    }));

    io.to(roomCode).emit('player_list_updated', playerList);
  });

  // Host starts game
  socket.on('start_game', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostSocketId !== socket.id) return;

    room.currentQuestionIndex = 0;
    room.status = 'playing';
    startQuestionRound(roomCode);
  });

  // Player submits answer choice
  socket.on('submit_answer', ({ roomCode, playerId, answerIndex }) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'playing') return;

    const pId = playerId || socket.id;
    const player = room.players[pId] || Object.values(room.players).find(p => p.socketId === socket.id);
    if (!player) return;

    player.hasAnswered = true;
    player.lastAnswerIndex = answerIndex;
    player.lastAnswerTime = room.timer;

    socket.emit('answer_received', {
      answerIndex,
      score: player.score
    });

    const answeredCount = Object.values(room.players).filter(p => p.hasAnswered).length;
    const totalPlayers = Object.keys(room.players).length;

    io.to(roomCode).emit('answer_progress', {
      answeredCount,
      totalPlayers
    });

    // If all players answered, auto reveal in 1 second
    if (answeredCount === totalPlayers && totalPlayers > 0) {
      setTimeout(() => {
        if (room.status === 'playing') {
          endQuestionRound(roomCode);
        }
      }, 1200);
    }
  });

  // Host advances or reveals round
  socket.on('next_question', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostSocketId !== socket.id) return;

    if (room.status === 'playing') {
      endQuestionRound(roomCode);
    } else if (room.status === 'revealed') {
      if (room.currentQuestionIndex + 1 < room.questions.length) {
        room.currentQuestionIndex++;
        room.status = 'playing';
        startQuestionRound(roomCode);
      } else {
        finishGame(roomCode);
      }
    }
  });

  // Host pauses/resumes timer
  socket.on('toggle_pause', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostSocketId !== socket.id) return;

    room.isPaused = !room.isPaused;
    io.to(roomCode).emit('timer_paused_state', { isPaused: room.isPaused });
  });

  // Host manually ends game early
  socket.on('end_game_early', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostSocketId !== socket.id) return;
    finishGame(roomCode);
  });

  socket.on('disconnect', () => {
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const p = Object.values(room.players).find(p => p.socketId === socket.id);
      if (p) {
        p.active = false;
        const playerList = Object.values(room.players).map(p => ({
          id: p.playerId,
          name: p.name,
          score: p.score,
          active: p.active
        }));
        io.to(roomCode).emit('player_list_updated', playerList);
      }
    }
  });
});

function startQuestionRound(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  if (room.timerInterval) clearInterval(room.timerInterval);

  room.status = 'playing';
  room.timer = room.questionTimerDuration;
  room.isPaused = false;

  Object.values(room.players).forEach(p => {
    p.hasAnswered = false;
    p.lastAnswerIndex = null;
  });

  const q = room.questions[room.currentQuestionIndex];

  const questionPayload = {
    questionIndex: room.currentQuestionIndex,
    totalQuestions: room.questions.length,
    id: q.id,
    question: q.question,
    category: q.category || 'טריוויה על עדן',
    image: q.image || 'images/eden_heart.jpg',
    options: q.options,
    timer: room.timer,
    totalDuration: room.questionTimerDuration
  };

  io.to(roomCode).emit('new_question', questionPayload);

  room.timerInterval = setInterval(() => {
    if (room.isPaused) return;

    room.timer--;
    io.to(roomCode).emit('timer_tick', { timer: room.timer });

    if (room.timer <= 0) {
      clearInterval(room.timerInterval);
      endQuestionRound(roomCode);
    }
  }, 1000);
}

function endQuestionRound(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  if (room.timerInterval) clearInterval(room.timerInterval);

  room.status = 'revealed';

  const q = room.questions[room.currentQuestionIndex];

  // Calculate scores
  Object.values(room.players).forEach(p => {
    if (p.hasAnswered) {
      p.totalAnswered++;
      if (p.lastAnswerIndex === q.correctIndex) {
        p.correctCount++;
        p.streak++;
        // Speed bonus: up to 500 bonus points
        const speedBonus = Math.floor((p.lastAnswerTime / room.questionTimerDuration) * 500);
        // Streak bonus: +100 for each streak level up to 300
        const streakBonus = Math.min((p.streak - 1) * 100, 300);
        p.score += (1000 + speedBonus + streakBonus);
        p.totalSpeedSeconds += p.lastAnswerTime;
      } else {
        p.streak = 0;
      }
    } else {
      p.streak = 0;
    }
  });

  const leaderboard = Object.values(room.players)
    .sort((a, b) => b.score - a.score)
    .map(p => ({
      id: p.playerId,
      name: p.name,
      score: p.score,
      streak: p.streak,
      lastAnswerIndex: p.lastAnswerIndex,
      isCorrect: p.lastAnswerIndex === q.correctIndex
    }));

  const revealPayload = {
    correctIndex: q.correctIndex,
    explanation: q.explanation,
    leaderboard,
    hasNext: room.currentQuestionIndex + 1 < room.questions.length
  };

  io.to(roomCode).emit('question_ended', revealPayload);
}

function finishGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  if (room.timerInterval) clearInterval(room.timerInterval);
  room.status = 'finished';

  const playersList = Object.values(room.players).sort((a, b) => b.score - a.score);

  const winner = playersList[0] || null;
  const secondPlace = playersList[1] || null;
  const thirdPlace = playersList[2] || null;

  const fastestPlayer = [...playersList].sort((a, b) => {
    const avgA = a.correctCount > 0 ? (a.totalSpeedSeconds / a.correctCount) : 0;
    const avgB = b.correctCount > 0 ? (b.totalSpeedSeconds / b.correctCount) : 0;
    return avgB - avgA;
  })[0] || null;

  const mostAccuratePlayer = [...playersList].sort((a, b) => {
    const pctA = a.totalAnswered > 0 ? (a.correctCount / a.totalAnswered) : 0;
    const pctB = b.totalAnswered > 0 ? (b.correctCount / b.totalAnswered) : 0;
    return pctB - pctA;
  })[0] || null;

  const stats = {
    totalQuestionsPlayed: room.currentQuestionIndex + 1,
    totalPlayers: playersList.length,
    fastestPlayerName: fastestPlayer ? fastestPlayer.name : '-',
    mostAccuratePlayerName: mostAccuratePlayer ? `${mostAccuratePlayer.name} (${mostAccuratePlayer.correctCount}/${mostAccuratePlayer.totalAnswered})` : '-'
  };

  io.to(roomCode).emit('game_finished', {
    winner,
    secondPlace,
    thirdPlace,
    stats,
    leaderboard: playersList
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const ips = getLocalIpAddresses();
  console.log(`===============================================`);
  console.log(`🎉 משחק טריוויה בת מצווה לעדן פעיל בהצלחה! 🎉`);
  console.log(`🌐 קישור מקומי: http://localhost:${PORT}`);
  if (ips.length > 0) {
    console.log(`📱 קישור לסמארטפונים באותה רשת Wi-Fi:`);
    ips.forEach(ip => {
      console.log(`   ➜ http://${ip}:${PORT}`);
    });
  }
  console.log(`👑 לוח מנחה: http://localhost:${PORT}/host.html`);
  console.log(`===============================================`);
});
