import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import healthRoutes from './routes/health.js';
import chatRoutes from './routes/chat.js';
import researchRoutes from './routes/research.js';
import visionRoutes from './routes/vision.js';

const app = express();

app.use(cors({ origin: config.allowedOrigins.split(',') }));
app.use(express.json({ limit: '5mb' }));

app.use('/api', healthRoutes);
app.use('/api', chatRoutes);
app.use('/api', researchRoutes);
app.use('/api', visionRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`HeraAI Backend running on port ${config.port}`);
});
