require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const codeRunner = require('./services/codeRunnerService');

const app = express();

connectDB();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const dockerStatus = codeRunner.checkDockerAvailability({ force: true });
if (dockerStatus.available) {
    console.log(`Docker runner ready: ${dockerStatus.binaryPath}`);
} else {
    console.warn(`Code runner disabled: ${dockerStatus.reason}`);
}

app.get('/', (_req, res) => {
    res.json({ message: "MUJinny Backend is Running" });
});

app.use('/api/chat', require('./routes/chat'));
app.use('/api/models', require('./routes/models'));
app.use('/api/conversations', require('./routes/conversation'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/run', require('./routes/run'));
app.use('/api/pdf', require('./routes/pdf'));
app.use('/api/faculty', require('./routes/faculty'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api', require('./routes/test'));

const PORT = process.env.PORT || 8000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
