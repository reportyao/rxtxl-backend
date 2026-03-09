/**
 * ===================================================================
 * 人选天选论 - 后端API服务器入口
 * ===================================================================
 *
 * 技术栈：Express + TypeScript + Prisma + SQLite/MySQL
 *
 * 架构说明：
 * - 采用经典的 MVC 分层架构（Routes → Controllers → Services → Prisma ORM）
 * - 中间件链：Helmet安全头 → CORS → 请求体解析 → 日志 → 缓存控制 → 频率限制 → 路由 → 错误处理
 * - 认证方式：JWT Bearer Token（用户端） + Basic Auth（管理后台）
 * - 数据库：开发环境使用SQLite，生产环境切换MySQL（通过Prisma schema切换）
 *
 * API路由总览：
 * - /api/auth/*       用户认证（发送验证码、登录、设置PIN、重置PIN）
 * - /api/articles/*   文章阅读（列表、详情）
 * - /api/diaries/*    道痕日记（创建、查询、打卡统计、石头收藏）
 * - /api/admin/*      管理后台（数据看板、文章CRUD、用户管理）
 * - /admin            管理后台前端页面（静态HTML）
 *
 * 安全策略：
 * - Helmet设置安全HTTP头
 * - CORS白名单（生产环境）
 * - 多层频率限制（全局/短信/登录/写入）
 * - 日记内容端到端加密（服务器只存密文）
 *
 * @author 人选天选论开发团队
 * @version 1.1.0
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { config } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { cacheControl, requestTimeout } from './middleware/performance';
import authRoutes from './routes/auth.routes';
import articleRoutes from './routes/article.routes';
import diaryRoutes from './routes/diary.routes';
import adminRoutes from './routes/admin.routes';

const app = express();

// ==================== 基础配置 ====================

/**
 * 信任代理设置
 * 当部署在Nginx/CDN后面时，需要信任代理以获取真实客户端IP
 * trust proxy = 1 表示信任第一层代理（即直接连接的Nginx）
 * 这影响 req.ip 和 X-Forwarded-For 的解析
 */
app.set('trust proxy', 1);

// ==================== 安全中间件 ====================

/**
 * Helmet - 设置安全相关的HTTP响应头
 * - CSP（内容安全策略）：限制资源加载来源，防止XSS
 * - 管理后台需要 unsafe-inline 和 CDN 域名（WangEditor富文本编辑器）
 * - crossOriginResourcePolicy: 允许跨域资源访问（前端H5跨域请求API）
 */
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://unpkg.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com", "https://unpkg.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'"],
    },
  },
}));

/**
 * CORS（跨域资源共享）配置
 * - 开发环境：允许所有来源（方便本地调试）
 * - 生产环境：从 CORS_ORIGIN 环境变量读取白名单域名
 *   格式：逗号分隔，如 "https://example.com,https://m.example.com"
 */
const corsOptions: cors.CorsOptions = {
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

if (config.isDev || config.corsOrigin === '*') {
  corsOptions.origin = true;
} else {
  const allowedOrigins = config.corsOrigin.split(',').map(s => s.trim());
  corsOptions.origin = (origin, callback) => {
    // 允许无origin的请求（服务端调用、curl、Postman等）
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS not allowed'));
    }
  };
}
app.use(cors(corsOptions));

// ==================== 请求解析 ====================

/**
 * JSON请求体解析
 * limit: 10mb - 富文本文章内容可能较大
 */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

/**
 * HTTP请求日志
 * - 开发环境：dev格式（简洁彩色输出）
 * - 生产环境：combined格式（包含完整信息，适合日志分析）
 */
app.use(morgan(config.isDev ? 'dev' : 'combined'));

// ==================== 性能中间件 ====================

/**
 * 缓存控制中间件
 * 根据路由类型设置不同的 Cache-Control 头
 */
app.use(cacheControl);

/**
 * 请求超时中间件
 * 防止慢查询或死锁导致连接长时间占用，默认30秒
 */
app.use(requestTimeout(30000));

// ==================== 频率限制（防刷防滥用） ====================

/**
 * 全局速率限制
 * 15分钟内最多300次请求，超出返回429状态码
 * 适用于所有API接口
 */
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 429, message: '请求过于频繁，请稍后再试', data: null },
});
app.use('/api/', globalLimiter);

/**
 * 短信验证码专用速率限制（最严格）
 * 每分钟最多1次，防止短信轰炸
 * 注意：此限制基于IP，同一IP下所有用户共享配额
 */
const smsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 429, message: '验证码发送过于频繁，请60秒后再试', data: null },
});
app.use('/api/auth/send-code', smsLimiter);

/**
 * 登录接口速率限制
 * 15分钟内最多10次登录尝试，防止暴力破解
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 429, message: '登录尝试过于频繁，请稍后再试', data: null },
});
app.use('/api/auth/login', loginLimiter);

/**
 * 日记写入接口速率限制（仅POST方法）
 * 每分钟最多10次写入操作，防止恶意刷数据
 *
 * [BUG FIX] 原来的 writeLimiter 使用 app.use('/api/diaries', writeLimiter)
 * 会对所有 /api/diaries 路由生效（包括GET请求），导致用户查看日记列表、
 * 打卡记录、石头数据等读操作也被限速（每分钟仅10次）。
 * 修复：改用 skip 选项，只对 POST/PUT/DELETE 方法限速，GET 请求不受影响。
 */
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'GET',
  message: { code: 429, message: '操作过于频繁，请稍后再试', data: null },
});
app.use('/api/diaries', writeLimiter);

// ==================== 路由注册 ====================

/**
 * 健康检查接口
 * 用于负载均衡器、监控系统探测服务是否存活
 * 返回版本号和当前运行环境
 */
app.get('/api/health', (_req, res) => {
  res.json({ code: 0, message: 'ok', data: { version: '1.1.0', env: config.nodeEnv } });
});

/**
 * 管理后台页面
 * 直接返回静态HTML文件（单文件SPA）
 * 访问路径：/admin
 */
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

/**
 * API路由挂载
 * 每个模块独立路由文件，按功能域划分
 */
app.use('/api/auth', authRoutes);       // 用户认证相关
app.use('/api/articles', articleRoutes); // 文章阅读相关
app.use('/api/diaries', diaryRoutes);   // 道痕日记相关
app.use('/api/admin', adminRoutes);     // 管理后台相关

// ==================== 错误处理 ====================

/** 404处理 - 未匹配到任何路由 */
app.use(notFoundHandler);

/** 全局错误处理 - 捕获所有未处理的异常 */
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
