import express from 'express'
import cors from 'cors';
import morgan from 'morgan';
import { createServer } from 'node:http';
import { Server } from 'socket.io';

const port = process.env.PORT || 3000
const app = express()
const server = createServer(app);
const io = new Server(server, {
    origin: 'http://localhost:5173/',
    credentials: true,
});

app.use(express.json());
app.use(morgan('tiny'))
app.use(cors({
    origin: 'http://localhost:5173/',
    credentials: true,
}));


io.on("connection", (socket) => {
    console.log("A user connected");

    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        console.log(`User ${socket.id} joined room: ${roomId}`);
    });

    // Broadcast drawing data
    socket.on('draw', (data) => {
        socket.to(data.room).emit('draw', data);
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });

})


app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
