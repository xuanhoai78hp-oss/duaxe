'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = Number(process.env.PORT) || 3000;
const rooms = new Map();
const raceLeaderboardFile = process.env.RACE_RUN_LEADERBOARD_FILE
  || (process.env.RACE_LEADERBOARD_FILE
    ? `${process.env.RACE_LEADERBOARD_FILE}.runs.json`
    : path.join(__dirname, 'data', 'duaxe-run-leaderboard.json'));
const roomCodeCharacters = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const disconnectedPlayerGraceMs = 30_000;

function loadRaceLeaderboard() {
  try {
    const records = JSON.parse(fs.readFileSync(raceLeaderboardFile, 'utf8'));
    if (!Array.isArray(records)) {
      throw new Error('Dữ liệu bảng xếp hạng Đua Xe phải là một danh sách.');
    }

    return new Map(records.map((record) => {
      const playerId = normalizePlayerId(record?.playerId);
      const name = normalizeName(record?.name);
      if (
        !playerId
        || !name
        || !Number.isFinite(record.bestRunSeconds)
        || record.bestRunSeconds <= 0
        || typeof record.updatedAt !== 'string'
      ) {
        throw new Error('Dữ liệu bảng xếp hạng Đua Xe không hợp lệ.');
      }
      return [playerId, {
        playerId,
        name,
        bestRunSeconds: record.bestRunSeconds,
        updatedAt: record.updatedAt,
      }];
    }));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return new Map();
    }
    throw error;
  }
}

const raceLeaderboard = loadRaceLeaderboard();
let raceLeaderboardSaveQueue = Promise.resolve();

function getRaceLeaderboard() {
  return [...raceLeaderboard.values()]
    .sort((left, right) => (
      left.bestRunSeconds - right.bestRunSeconds
      || left.name.localeCompare(right.name)
    ))
    .slice(0, 50)
    .map(({ name, bestRunSeconds, updatedAt }) => ({ name, bestRunSeconds, updatedAt }));
}

function saveRaceLeaderboard() {
  const records = JSON.stringify([...raceLeaderboard.values()], null, 2);
  const save = raceLeaderboardSaveQueue.then(async () => {
    await fs.promises.mkdir(path.dirname(raceLeaderboardFile), { recursive: true });
    const temporaryFile = `${raceLeaderboardFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporaryFile, records, { mode: 0o600 });
      await fs.promises.rename(temporaryFile, raceLeaderboardFile);
    } catch (error) {
      await fs.promises.unlink(temporaryFile).catch(() => {});
      throw error;
    }
  });
  raceLeaderboardSaveQueue = save.catch(() => {});
  return save;
}

app.use(express.json({ limit: '16kb' }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/duaxe', (req, res) => {
  res.sendFile(path.join(__dirname, 'duaxe.html'));
});

app.get('/game', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/rooms', (req, res) => {
  const activeRooms = [...rooms.values()]
    .map((room) => ({
      code: room.code,
      playerCount: [...room.players.values()].filter((player) => player.connected).length,
    }))
    .filter((room) => room.playerCount > 0)
    .sort((left, right) => right.playerCount - left.playerCount);

  res.json({ rooms: activeRooms });
});

app.get('/api/race-leaderboard', (req, res) => {
  res.json({ players: getRaceLeaderboard() });
});

app.post('/api/race-leaderboard', async (req, res) => {
  const playerId = normalizePlayerId(req.body?.playerId);
  const name = normalizeName(req.body?.name);
  const bestRunSeconds = req.body?.bestRunSeconds;
  if (
    !playerId
    || !name
    || !Number.isFinite(bestRunSeconds)
    || bestRunSeconds < 1
    || bestRunSeconds > 3600
  ) {
    res.status(400).json({ error: 'Tên, mã người chơi hoặc thời gian lượt đua không hợp lệ.' });
    return;
  }

  const previousRecord = raceLeaderboard.get(playerId);
  const recorded = !previousRecord || bestRunSeconds < previousRecord.bestRunSeconds;
  raceLeaderboard.set(playerId, {
    playerId,
    name,
    bestRunSeconds: recorded ? bestRunSeconds : previousRecord.bestRunSeconds,
    updatedAt: recorded ? new Date().toISOString() : previousRecord.updatedAt,
  });

  try {
    await saveRaceLeaderboard();
  } catch (error) {
    console.error('Không thể lưu bảng xếp hạng Đua Xe:', error);
    res.status(500).json({ error: 'Không thể lưu bảng xếp hạng lúc này.' });
    return;
  }

  const players = getRaceLeaderboard();
  io.emit('race_leaderboard_update', { players });
  res.json({ recorded, players });
});

app.get('/healthz', (req, res) => {
  res.sendStatus(200);
});

function acknowledge(callback, response) {
  if (typeof callback === 'function') {
    callback(response);
  }
}

function normalizePlayerId(value) {
  return typeof value === 'string' && /^[a-z\d-]{1,80}$/i.test(value)
    ? value
    : null;
}

function normalizeName(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, 20)
    : '';
}

function normalizeRoomCode(value) {
  return typeof value === 'string'
    ? value.trim().toUpperCase().replace(/[^A-Z\d]/g, '').slice(0, 6)
    : '';
}

function createRoomCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => {
      return roomCodeCharacters[crypto.randomInt(roomCodeCharacters.length)];
    }).join('');
  } while (rooms.has(code));
  return code;
}

function createPlayer(id, name) {
  return {
    id,
    name,
    score: 0,
    frames: Array.from({ length: 10 }, () => ({ rolls: [] })),
    connected: true,
    socketId: null,
    removeTimer: null,
    lastRollId: null,
  };
}

function isFrameComplete(frame, frameIndex) {
  const rolls = frame.rolls;
  if (rolls.length >= 2 && rolls[0] + rolls[1] >= 20) {
    return true;
  }
  if (frameIndex < 9) {
    return rolls.length >= (rolls[0] === 10 ? 3 : 2);
  }

  if (rolls.length < 2) {
    return false;
  }
  return rolls.length >= (rolls[0] === 10 || rolls[0] + rolls[1] === 10 ? 3 : 2);
}

function getCurrentFrameIndex(player) {
  return player.frames.findIndex((frame, index) => !isFrameComplete(frame, index));
}

function getRackRemaining(frame, frameIndex) {
  const rolls = frame.rolls;
  if (rolls.length === 0) {
    return 10;
  }
  if (frameIndex < 9) {
    if (rolls[0] === 10) {
      return 10;
    }
    return 10 - rolls[0];
  }
  if (rolls.length === 1) {
    return rolls[0] === 10 ? 10 : 10 - rolls[0];
  }
  if (rolls.length === 2 && rolls[0] === 10) {
    return rolls[1] === 10 ? 10 : 10 - rolls[1];
  }
  if (rolls.length === 2 && rolls[0] + rolls[1] === 10) {
    return 10;
  }
  return 0;
}

function getPublicRoom(room) {
  return {
    code: room.code,
    players: [...room.players.values()].map(({ id, name, score, frames, connected }) => ({
      id,
      name,
      score,
      frames,
      connected,
    })),
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room_state', getPublicRoom(room));
}

function removePlayer(room, playerId, expectedSocketId) {
  const player = room.players.get(playerId);
  if (!player || (expectedSocketId && player.socketId !== expectedSocketId)) {
    return;
  }

  if (player.removeTimer) {
    clearTimeout(player.removeTimer);
  }
  room.players.delete(playerId);
  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }
  broadcastRoom(room);
}

function attachPlayer(socket, room, playerId, name) {
  const player = room.players.get(playerId) ?? createPlayer(playerId, name);
  if (player.removeTimer) {
    clearTimeout(player.removeTimer);
    player.removeTimer = null;
  }

  if (player.socketId && player.socketId !== socket.id) {
    const previousSocket = io.sockets.sockets.get(player.socketId);
    previousSocket?.leave(room.code);
    if (previousSocket) {
      previousSocket.data.roomCode = null;
      previousSocket.data.playerId = null;
    }
  }

  player.name = name;
  player.connected = true;
  player.socketId = socket.id;
  room.players.set(playerId, player);
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerId = playerId;
  return player;
}

function leaveCurrentRoom(socket) {
  const { roomCode, playerId } = socket.data;
  const room = rooms.get(roomCode);
  socket.data.roomCode = null;
  socket.data.playerId = null;
  if (room) {
    removePlayer(room, playerId, socket.id);
  }
  if (roomCode) {
    socket.leave(roomCode);
  }
}

io.on('connection', (socket) => {
  socket.on('create_room', (payload, callback) => {
    const playerId = normalizePlayerId(payload?.playerId);
    const name = normalizeName(payload?.name);
    if (!playerId || !name) {
      acknowledge(callback, { ok: false, error: 'Hãy nhập tên người chơi hợp lệ.' });
      return;
    }

    leaveCurrentRoom(socket);
    const room = { code: createRoomCode(), players: new Map() };
    rooms.set(room.code, room);
    attachPlayer(socket, room, playerId, name);
    acknowledge(callback, { ok: true, room: getPublicRoom(room) });
    broadcastRoom(room);
  });

  socket.on('join_room', (payload, callback) => {
    const roomCode = normalizeRoomCode(payload?.roomCode);
    const playerId = normalizePlayerId(payload?.playerId);
    const name = normalizeName(payload?.name);
    const room = rooms.get(roomCode);
    if (!room) {
      acknowledge(callback, { ok: false, error: 'Không tìm thấy phòng. Hãy kiểm tra mã phòng.' });
      return;
    }
    if (!playerId || !name) {
      acknowledge(callback, { ok: false, error: 'Hãy nhập tên người chơi hợp lệ.' });
      return;
    }

    if (socket.data.roomCode !== roomCode) {
      leaveCurrentRoom(socket);
    }
    attachPlayer(socket, room, playerId, name);
    acknowledge(callback, { ok: true, room: getPublicRoom(room) });
    broadcastRoom(room);
  });

  socket.on('leave_room', (payload, callback) => {
    const roomCode = normalizeRoomCode(payload?.roomCode);
    if (socket.data.roomCode === roomCode) {
      leaveCurrentRoom(socket);
    }
    acknowledge(callback, { ok: true });
  });

  socket.on('record_roll', (payload, callback) => {
    const roomCode = normalizeRoomCode(payload?.roomCode);
    const room = rooms.get(roomCode);
    const player = room?.players.get(socket.data.playerId);
    if (!room || socket.data.roomCode !== roomCode || !player || player.socketId !== socket.id) {
      acknowledge(callback, { ok: false, error: 'Bạn không còn ở trong phòng này.' });
      return;
    }
    if (typeof payload?.rollId === 'string' && payload.rollId === player.lastRollId) {
      acknowledge(callback, { ok: true, room: getPublicRoom(room) });
      return;
    }

    const frameIndex = getCurrentFrameIndex(player);
    const frame = player.frames[frameIndex];
    if (
      frameIndex < 0
      || payload?.frameIndex !== frameIndex
      || payload?.rollIndex !== frame.rolls.length
      || !Number.isInteger(payload?.pinsDown)
      || payload.pinsDown < 0
      || payload.pinsDown > getRackRemaining(frame, frameIndex)
      || typeof payload.rollId !== 'string'
      || payload.rollId.length > 80
    ) {
      acknowledge(callback, { ok: false, error: 'Lượt ném không khớp với trạng thái ván chơi.' });
      return;
    }

    frame.rolls.push(payload.pinsDown);
    player.score = player.frames.reduce((total, currentFrame) => {
      const frameScore = currentFrame.rolls.reduce((sum, pinsDown) => sum + pinsDown, 0);
      return total + Math.min(frameScore, 20);
    }, 0);
    player.lastRollId = payload.rollId;
    const response = { ok: true, room: getPublicRoom(room) };
    broadcastRoom(room);
    acknowledge(callback, response);
  });

  socket.on('restart_player', (payload, callback) => {
    const roomCode = normalizeRoomCode(payload?.roomCode);
    const room = rooms.get(roomCode);
    const player = room?.players.get(socket.data.playerId);
    if (!room || socket.data.roomCode !== roomCode || !player || player.socketId !== socket.id) {
      acknowledge(callback, { ok: false, error: 'Bạn không còn ở trong phòng này.' });
      return;
    }
    if (getCurrentFrameIndex(player) !== -1) {
      acknowledge(callback, { ok: false, error: 'Bạn cần hoàn thành ván hiện tại trước.' });
      return;
    }

    player.frames = Array.from({ length: 10 }, () => ({ rolls: [] }));
    player.score = 0;
    player.lastRollId = null;
    const response = { ok: true, room: getPublicRoom(room) };
    broadcastRoom(room);
    acknowledge(callback, response);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.data.playerId);
    if (!room || !player || player.socketId !== socket.id) {
      return;
    }

    player.connected = false;
    player.socketId = null;
    player.removeTimer = setTimeout(() => {
      if (!player.connected) {
        removePlayer(room, player.id);
      }
    }, disconnectedPlayerGraceMs);
    player.removeTimer.unref();
    broadcastRoom(room);
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Game Hub server is running on port ${port}`);
});
