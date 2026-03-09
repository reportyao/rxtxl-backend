/**
 * ===================================================================
 * 认证中间件 (Auth Middleware)
 * ===================================================================
 *
 * 提供两种认证方式：
 *
 * 1. JWT Bearer Token 认证（用户端）
 *    - 用于所有需要用户登录的API（日记、打卡、个人信息等）
 *    - Token在登录时生成，有效期7天
 *    - 请求头格式：Authorization: Bearer <jwt_token>
 *
 * 2. HTTP Basic Auth 认证（管理后台）
 *    - 用于管理后台的所有API（数据看板、文章管理、用户管理）
 *    - 账号密码在.env中配置（ADMIN_USERNAME / ADMIN_PASSWORD）
 *    - 请求头格式：Authorization: Basic <base64(username:password)>
 *
 * TypeScript类型扩展：
 * - 在Express的Request对象上扩展了user属性（JwtPayload类型）
 * - 通过JWT验证后，req.user包含 { userId, phone }
 * - 后续controller可通过 req.user!.userId 获取当前用户ID
 */

import { Request, Response, NextFunction } from 'express';
import { verifyToken, JwtPayload } from '../utils/jwt';
import { unauthorized } from '../utils/response';
import { config } from '../config/env';

/**
 * 扩展Express的Request类型定义
 * 使得TypeScript能识别 req.user 属性
 */
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/**
 * JWT Bearer Token 认证中间件（用户端）
 *
 * 使用方式：
 *   router.get('/api/diaries', authMiddleware, getDiaries);
 *
 * 流程：
 * 1. 从请求头中提取 Authorization: Bearer <token>
 * 2. 使用JWT密钥验证Token的签名和有效期
 * 3. 将解码后的用户信息（userId, phone）挂载到 req.user
 * 4. 如果验证失败，返回401状态码，前端据此跳转登录页
 *
 * 错误场景：
 * - 未提供Token → 401 "请先登录"
 * - Token格式错误 → 401 "请先登录"
 * - Token已过期 → 401 "登录已过期，请重新登录"
 * - Token签名被篡改 → 401 "登录已过期，请重新登录"
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  // 检查Authorization头是否存在且为Bearer格式
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    unauthorized(res, '请先登录');
    return;
  }

  // 提取Token（去掉"Bearer "前缀，共7个字符）
  const token = authHeader.substring(7);

  try {
    // 验证Token签名和有效期，返回解码后的载荷
    const payload = verifyToken(token);
    // 将用户信息挂载到req对象，后续handler可通过 req.user!.userId 访问
    req.user = payload;
    next();
  } catch (err) {
    // Token无效或已过期
    unauthorized(res, '登录已过期，请重新登录');
    return;
  }
}

/**
 * HTTP Basic Auth 认证中间件（管理后台专用）
 *
 * 使用方式：
 *   router.get('/api/admin/dashboard', adminAuthMiddleware, getOverview);
 *
 * 流程：
 * 1. 从请求头中提取 Authorization: Basic <base64_credentials>
 * 2. Base64解码获取 "username:password" 字符串
 * 3. 与.env中配置的管理员账号密码比对
 * 4. 验证失败返回401，浏览器会自动弹出登录对话框
 *
 * 安全建议（生产环境）：
 * - 务必修改默认的admin/admin123密码
 * - 配合HTTPS使用，防止Basic Auth凭据被中间人截获
 * - 在Nginx层限制管理后台的访问IP
 * - 考虑增加登录失败次数限制
 */
export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    // 返回WWW-Authenticate头，浏览器会弹出原生的用户名/密码输入框
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    unauthorized(res, '请提供管理员凭据');
    return;
  }

  // Base64解码：Buffer.from("YWRtaW46YWRtaW4xMjM=", "base64") → "admin:admin123"
  const base64Credentials = authHeader.substring(6);
  const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
  const [username, password] = credentials.split(':');

  // 与环境变量中的管理员凭据比对
  if (username === config.admin.username && password === config.admin.password) {
    next();
  } else {
    unauthorized(res, '管理员凭据错误');
    return;
  }
}
