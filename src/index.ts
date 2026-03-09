import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { config } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import authRoutes from './routes/auth.routes';
import articleRoutes from './routes/article.routes';
import diaryRoutes from './routes/diary.routes';
import adminRoutes from './routes/admin.routes';

const app = express();

// ==================== 中间件 ====================

// 安全头
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// CORS
app.use(cors({
  origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','),
  credentials: true,
}));

// 请求体解析
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 日志
app.use(morgan(config.isDev ? 'dev' : 'combined'));

// 全局速率限制
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分钟
  max: 200, // 最多200次请求
  message: { code: 429, message: '请求过于频繁，请稍后再试', data: null },
});
app.use('/api/', globalLimiter);

// 短信验证码专用速率限制（更严格）
const smsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: 1, // 每分钟最多1次
  message: { code: 429, message: '验证码发送过于频繁，请60秒后再试', data: null },
});
app.use('/api/auth/send-code', smsLimiter);

// ==================== 路由 ====================

// 健康检查
app.get('/api/health', (_req, res) => {
  res.json({ code: 0, message: 'ok', data: { version: '1.0.0', env: config.nodeEnv } });
});

// API路由
app.use('/api/auth', authRoutes);
app.use('/api/articles', articleRoutes);
app.use('/api/diaries', diaryRoutes);
app.use('/api/admin', adminRoutes);

// ==================== 错误处理 ====================

app.use(notFoundHandler);
app.use(errorHandler);

// ==================== 启动服务器 ====================

app.listen(config.port, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║     人选天选论 API Server               ║
  ║     Port: ${config.port}                          ║
  ║     Env:  ${config.nodeEnv.padEnd(28)}║
  ╚══════════════════════════════════════════╝
  `);
});

export default app;
