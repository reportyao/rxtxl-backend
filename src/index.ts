import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { config } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import authRoutes from './routes/auth.routes';
import articleRoutes from './routes/article.routes';
import diaryRoutes from './routes/diary.routes';
import adminRoutes from './routes/admin.routes';

const app = express();

// ==================== 基础配置 ====================

// 信任代理（Nginx反向代理场景，获取真实IP）
app.set('trust proxy', 1);

// ==================== 中间件 ====================

// 安全头
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
    },
  },
}));

// CORS - 生产环境限制域名，开发环境允许所有
const corsOptions: cors.CorsOptions = {
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

if (config.isDev || config.corsOrigin === '*') {
  corsOptions.origin = true; // 开发环境允许所有来源
} else {
  // 生产环境：从环境变量读取允许的域名列表
  const allowedOrigins = config.corsOrigin.split(',').map(s => s.trim());
  corsOptions.origin = (origin, callback) => {
    // 允许无origin的请求（如服务端请求、curl等）
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS not allowed'));
    }
  };
}
app.use(cors(corsOptions));

// 请求体解析
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 日志
app.use(morgan(config.isDev ? 'dev' : 'combined'));

// ==================== 频率限制 ====================

// 全局速率限制
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分钟
  max: 300, // 最多300次请求
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 429, message: '请求过于频繁，请稍后再试', data: null },
});
app.use('/api/', globalLimiter);

// 短信验证码专用速率限制（更严格）
const smsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: 1, // 每分钟最多1次
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 429, message: '验证码发送过于频繁，请60秒后再试', data: null },
});
app.use('/api/auth/send-code', smsLimiter);

// 登录接口速率限制
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分钟
  max: 10, // 最多10次
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 429, message: '登录尝试过于频繁，请稍后再试', data: null },
});
app.use('/api/auth/login', loginLimiter);

// 写入接口速率限制（日记创建等）
const writeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: 10, // 每分钟最多10次写入
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 429, message: '操作过于频繁，请稍后再试', data: null },
});
app.use('/api/diaries', writeLimiter);

// ==================== 路由 ====================

// 健康检查
app.get('/api/health', (_req, res) => {
  res.json({ code: 0, message: 'ok', data: { version: '1.0.0', env: config.nodeEnv } });
});

// 管理后台静态文件
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
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
