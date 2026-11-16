'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const port = Number(process.env.PORT) || 3000;
const leaderboardFile = process.env.RACE_RUN_LEADERBOARD_FILE
  || (process.env.RACE_LEADERBOARD_FILE
    ? `${process.env.RACE_LEADERBOARD_FILE}.runs.json`
    : path.join(__dirname, 'data', 'duaxe-run-leaderboard.json'));

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

function loadLeaderboard() {
  let contents;
  try {
    contents = fs.readFileSync(leaderboardFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return new Map();
    }
    throw error;
  }

  const records = JSON.parse(contents);
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
}

const leaderboard = loadLeaderboard();
let saveQueue = Promise.resolve();

function getLeaderboard() {
  return [...leaderboard.values()]
    .sort((left, right) => (
      left.bestRunSeconds - right.bestRunSeconds
      || left.name.localeCompare(right.name)
    ))
    .slice(0, 50)
    .map(({ name, bestRunSeconds, updatedAt }) => ({ name, bestRunSeconds, updatedAt }));
}

function saveLeaderboard() {
  const contents = JSON.stringify([...leaderboard.values()], null, 2);
  const save = saveQueue.then(async () => {
    await fs.promises.mkdir(path.dirname(leaderboardFile), { recursive: true });
    const temporaryFile = `${leaderboardFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporaryFile, contents, { mode: 0o600 });
      await fs.promises.rename(temporaryFile, leaderboardFile);
    } catch (error) {
      await fs.promises.unlink(temporaryFile).catch(() => {});
      throw error;
    }
  });
  saveQueue = save.catch(() => {});
  return save;
}

app.use(express.json({ limit: '16kb' }));

function sendGame(_req, res) {
  res.sendFile(path.join(__dirname, 'duaxe.html'));
}

app.get('/', sendGame);
app.get('/duaxe', sendGame);

app.get('/api/race-leaderboard', (_req, res) => {
  res.json({ players: getLeaderboard() });
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

  const previousRecord = leaderboard.get(playerId);
  const recorded = !previousRecord || bestRunSeconds < previousRecord.bestRunSeconds;
  leaderboard.set(playerId, {
    playerId,
    name,
    bestRunSeconds: recorded ? bestRunSeconds : previousRecord.bestRunSeconds,
    updatedAt: recorded ? new Date().toISOString() : previousRecord.updatedAt,
  });

  try {
    await saveLeaderboard();
  } catch (error) {
    console.error('Không thể lưu bảng xếp hạng Đua Xe:', error);
    res.status(500).json({ error: 'Không thể lưu bảng xếp hạng lúc này.' });
    return;
  }

  res.json({ recorded, players: getLeaderboard() });
});

app.get('/healthz', (_req, res) => {
  res.sendStatus(200);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Game Đua Xe server is running on port ${port}`);
});
