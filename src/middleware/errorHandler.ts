import { Request, Response, NextFunction } from 'express';
import { error } from '../utils/response';

/**
 * 全局错误处理中间件
 */
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  console.error('[Error]', err.message);
  console.error(err.stack);

  error(res, process.env.NODE_ENV === 'development' ? err.message : '服务器内部错误', 500);
}

/**
 * 404处理中间件
 */
export function notFoundHandler(req: Request, res: Response): void {
  error(res, `接口不存在: ${req.method} ${req.path}`, 404, 404);
}
