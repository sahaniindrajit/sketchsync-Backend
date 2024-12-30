import express from 'express'
import cors from 'cors';
import morgan from 'morgan';

const port = process.env.PORT || 3000
const app = express()

app.use(express.json());
app.use(morgan('tiny'))
app.use(cors({
    origin: 'http://localhost:5173/',
    credentials: true,
}));




app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
