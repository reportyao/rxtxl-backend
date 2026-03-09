import { Response } from 'express';

/**
 * 统一成功响应格式
 */
export function success(res: Response, data: any = null, message: string = 'success', statusCode: number = 200) {
  return res.status(statusCode).json({
    code: 0,
    message,
    data,
  });
}

/**
 * 统一错误响应格式
 */
export function error(res: Response, message: string = '服务器内部错误', statusCode: number = 500, code: number = -1) {
  return res.status(statusCode).json({
    code,
    message,
    data: null,
  });
}

/**
 * 参数校验错误
 */
export function validationError(res: Response, message: string = '参数校验失败') {
  return error(res, message, 400, 400);
}

/**
 * 未授权错误
 */
export function unauthorized(res: Response, message: string = '未授权，请先登录') {
  return error(res, message, 401, 401);
}

/**
 * 禁止访问错误
 */
export function forbidden(res: Response, message: string = '禁止访问') {
  return error(res, message, 403, 403);
}

/**
 * 资源未找到
 */
export function notFound(res: Response, message: string = '资源不存在') {
  return error(res, message, 404, 404);
}
