const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" } 
});

// Cho phép phục vụ file tĩnh nếu có thư mục public/ hoặc để chạy đơn giản
app.use(express.static('.'));

io.on('connection', (socket) => {
    console.log('Có người chơi kết nối:', socket.id);
    
    socket.on('playerMove', (data) => {
        // Phát tán vị trí của người chơi này cho tất cả mọi người khác trong phòng
        socket.broadcast.emit('updatePlayer', { id: socket.id, ...data });
    });

    socket.on('disconnect', () => {
        console.log('Người chơi thoát:', socket.id);
        io.emit('removePlayer', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server đang chạy trên cổng ${PORT}`);
});