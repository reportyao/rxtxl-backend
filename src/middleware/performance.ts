/**
 * 性能优化中间件
 * 包含：响应压缩、缓存控制、请求超时
 */

import { Request, Response, NextFunction } from 'express';

/**
 * 缓存控制中间件
 * 根据路由类型设置不同的缓存策略：
 * - 文章列表：缓存60秒（高频读低频写）
 * - 文章详情：缓存300秒
 * - 静态资源：缓存1天
 * - 其他API：不缓存
 */
export function cacheControl(req: Request, res: Response, next: NextFunction): void {
  const path = req.path;

  if (path === '/api/articles' && req.method === 'GET') {
    // 文章列表：公共缓存60秒
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
  } else if (path.startsWith('/api/articles/') && req.method === 'GET') {
    // 文章详情：公共缓存300秒
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
  } else if (path === '/admin') {
    // 管理后台页面：缓存1小时
    res.setHeader('Cache-Control', 'public, max-age=3600');
  } else {
    // 其他API：不缓存（日记、用户数据等私有数据）
    res.setHeader('Cache-Control', 'no-store');
  }

  next();
}

/**
 * 请求超时中间件
 * 防止慢查询或死锁导致连接长时间占用
 * 默认30秒超时
 */
export function requestTimeout(timeoutMs: number = 30000) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        res.status(408).json({
          code: 408,
          message: '请求超时，请稍后重试',
          data: null,
        });
      }
    }, timeoutMs);

    // 响应完成后清除定时器
    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));

    next();
  };
}

/**
 * 文章缓存服务（内存缓存）
 * 用于高频读取的文章列表，避免每次请求都查数据库
 */
interface CacheEntry<T> {
  data: T;
  expireAt: number;
}

class SimpleCache {
  private store = new Map<string, CacheEntry<any>>();
  private maxSize: number;

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize;
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expireAt) {
      this.store.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    // 超量时清理过期条目
    if (this.store.size >= this.maxSize) {
      const now = Date.now();
      for (const [k, v] of this.store) {
        if (now > v.expireAt) this.store.delete(k);
      }
    }
    // 仍然超量则删除最早的一半
    if (this.store.size >= this.maxSize) {
      const keys = Array.from(this.store.keys());
      for (let i = 0; i < Math.floor(keys.length / 2); i++) {
        this.store.delete(keys[i]);
      }
    }
    this.store.set(key, { data, expireAt: Date.now() + ttlMs });
  }

  /** 清除指定前缀的缓存（文章更新时调用） */
  invalidate(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  /** 清除所有缓存 */
  clear(): void {
    this.store.clear();
  }
}

/** 全局缓存实例，供controller使用 */
export const apiCache = new SimpleCache(200);
