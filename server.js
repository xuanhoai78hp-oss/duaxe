const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" } 
});

app.use(express.static('.'));

const players = {};

io.on('connection', (socket) => {
    console.log('Có người chơi kết nối:', socket.id);

    // Nhận tên khi người chơi vào game
    socket.on('joinGame', (data) => {
        players[socket.id] = {
            id: socket.id,
            name: data.name || 'Tay Đua Vô Danh',
            angle: 0,
            radiusOffset: 0,
            speed: 0,
            avgTime: 0
        };
        io.emit('updateLeaderboard', Object.values(players));
    });

    // Nhận thông tin di chuyển và phát tán cho các thiết bị khác
    socket.on('playerMove', (data) => {
        if (players[socket.id]) {
            players[socket.id].angle = data.angle;
            players[socket.id].radiusOffset = data.radiusOffset;
            players[socket.id].speed = data.speed;
        }
        socket.broadcast.emit('updatePlayerPos', { id: socket.id, ...data });
    });

    // Cập nhật kết quả thời gian trung bình sau khi hoàn thành vòng
    socket.on('updateScore', (data) => {
        if (players[socket.id]) {
            players[socket.id].avgTime = data.avgTime;
            io.emit('updateLeaderboard', Object.values(players));
        }
    });

    socket.on('disconnect', () => {
        console.log('Người chơi thoát:', socket.id);
        delete players[socket.id];
        io.emit('removePlayer', socket.id);
        io.emit('updateLeaderboard', Object.values(players));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server đang chạy trên cổng ${PORT}`);
});