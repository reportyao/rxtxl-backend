import { Request, Response, NextFunction } from 'express';
import { verifyToken, JwtPayload } from '../utils/jwt';
import { unauthorized } from '../utils/response';
import { config } from '../config/env';

// 扩展Express Request类型
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/**
 * 用户认证中间件
 * 从请求头中提取JWT Token并验证
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    unauthorized(res, '请先登录');
    return;
  }

  const token = authHeader.substring(7);

  try {
    const payload = verifyToken(token);
    req.user = payload;
    next();
  } catch (err) {
    unauthorized(res, '登录已过期，请重新登录');
    return;
  }
}

/**
 * 管理员认证中间件
 * 使用Basic Auth进行简单的管理员认证
 */
export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    unauthorized(res, '请提供管理员凭据');
    return;
  }

  const base64Credentials = authHeader.substring(6);
  const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
  const [username, password] = credentials.split(':');

  if (username === config.admin.username && password === config.admin.password) {
    next();
  } else {
    unauthorized(res, '管理员凭据错误');
    return;
  }
}
