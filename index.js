import express from 'express'
import cors from 'cors';
import morgan from 'morgan';
import { createServer } from 'node:http';
import { Server } from 'socket.io';

const port = process.env.PORT || 3000
const app = express()
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: 'https://sketchsync.onrender.com',
        methods: ['GET', 'POST']
    }
});

app.use(express.json());
app.use(morgan('tiny'))
app.use(cors({
    origin: 'https://sketchsync.onrender.com',
    credentials: true,
}));

app.get("/ping", (req, res) => {
    res.send({ message: "Server is alive!" });
});

io.on("connection", (socket) => {

    socket.on('join-room', (roomId) => {
        socket.join(roomId);
    });

    // Broadcast drawing data
    socket.on('draw', (data) => {
        socket.to(data.roomId).emit('draw', { data });
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });

})

server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
