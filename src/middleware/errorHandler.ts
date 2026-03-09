/**
 * ===================================================================
 * 全局错误处理中间件 (Error Handler)
 * ===================================================================
 *
 * Express错误处理的最后一道防线，捕获所有未被controller try-catch处理的异常。
 *
 * 包含两个中间件：
 * 1. errorHandler - 处理500（未捕获的运行时异常）
 * 2. notFoundHandler - 处理404（未匹配到任何路由）
 *
 * 注册顺序（在index.ts中）：
 *   app.use('/api/...', routes);  // 先注册路由
 *   app.use(notFoundHandler);     // 再注册404处理
 *   app.use(errorHandler);        // 最后注册全局错误处理
 *
 * 安全策略：
 * - 开发环境：返回完整的错误信息，方便调试
 * - 生产环境：只返回通用错误信息，不暴露内部实现细节
 */

import { Request, Response, NextFunction } from 'express';
import { error } from '../utils/response';

/**
 * 全局错误处理中间件
 *
 * Express的错误处理中间件必须有4个参数（err, req, res, next）
 * 即使_next不使用也不能省略，否则Express不会将其识别为错误处理中间件
 *
 * 触发场景：
 * - controller中未被try-catch捕获的异常
 * - 中间件中抛出的异常
 * - next(error) 显式传递的错误
 *
 * @param err - 错误对象
 * @param req - Express请求对象
 * @param res - Express响应对象
 * @param _next - Express next函数（必须声明但此处不使用）
 */
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  // 记录完整错误信息到控制台（生产环境应接入日志系统如Winston/Pino）
  console.error('[Error]', err.message);
  console.error(err.stack);

  // 开发环境返回完整错误信息方便调试，生产环境返回通用信息防止信息泄露
  error(res, process.env.NODE_ENV === 'development' ? err.message : '服务器内部错误', 500);
}

/**
 * 404 Not Found 处理中间件
 *
 * 当请求未匹配到任何已注册的路由时触发
 * 返回统一格式的404响应，包含请求方法和路径信息方便排查
 */
export function notFoundHandler(req: Request, res: Response): void {
  error(res, `接口不存在: ${req.method} ${req.path}`, 404, 404);
}
