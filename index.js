import express from 'express'
import cors from 'cors';
import morgan from 'morgan';
import { createServer } from 'node:http';
import { Server } from 'socket.io';

const port = process.env.PORT || 3000
const app = express()
const server = createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(morgan('tiny'))
app.use(cors({
    origin: 'http://localhost:5173/',
    credentials: true,
}));

let whiteboards = {};

io.on("connection", (socket) => {
    console.log("A user connected");

    socket.on("joinRoom", (roomID) => {
        socket.join(roomID);
        console.log(`user joined on ${roomID}`)
        socket.emit("whiteboardData", whiteboards[roomID])
    })

    socket.on("draw", (roomID, drawData) => {
        if (!whiteboards[roomID]) {
            whiteboards[roomID] = []
        }

        whiteboards[roomID].push(drawData);
        socket.to(boardId).emit("draw", drawData);
    })

    socket.on("disconnect", () => {
        console.log("A user disconnected");
    });

})


app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
