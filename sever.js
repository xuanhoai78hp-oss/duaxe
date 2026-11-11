const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Cho phép server phục vụ các file tĩnh (html, css, js, ảnh) trong cùng thư mục
app.use(express.static(__dirname));

io.on('connection', (socket) => {
    console.log('Có người chơi kết nối:', socket.id);

    socket.on('playerMove', (data) => {
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