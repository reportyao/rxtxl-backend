/**
 * IP工具 - 获取客户端IP和解析归属地
 * 包含LRU缓存，避免对同一IP重复调用外部API
 */

import { Request } from 'express';

/** 从请求中获取客户端真实IP（支持代理） */
export function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded)) {
    return forwarded[0];
  }
  return req.socket.remoteAddress || '0.0.0.0';
}

interface IpApiResponse {
  status: string;
  regionName?: string;
  city?: string;
}

/**
 * IP归属地缓存（简易LRU）
 * 避免同一IP多次登录时重复调用外部API
 * 缓存容量：1000条，超出时清除最早的一半
 * 缓存时间：24小时
 */
const IP_CACHE_MAX = 1000;
const IP_CACHE_TTL = 24 * 60 * 60 * 1000; // 24小时
const ipCache = new Map<string, { region: string; expireAt: number }>();

/** 清理过期和超量的缓存 */
function cleanIpCache(): void {
  const now = Date.now();
  // 清理过期条目
  for (const [key, val] of ipCache) {
    if (now > val.expireAt) {
      ipCache.delete(key);
    }
  }
  // 超量时删除最早的一半
  if (ipCache.size > IP_CACHE_MAX) {
    const keys = Array.from(ipCache.keys());
    const deleteCount = Math.floor(keys.length / 2);
    for (let i = 0; i < deleteCount; i++) {
      ipCache.delete(keys[i]);
    }
  }
}

/**
 * 解析IP归属地（带缓存）
 * 使用ip-api.com免费接口，限制45次/分钟
 */
export async function resolveIpRegion(ip: string): Promise<string> {
  // 本地/私有IP直接返回
  if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return '本地网络';
  }

  // 检查缓存
  const cached = ipCache.get(ip);
  if (cached && Date.now() < cached.expireAt) {
    return cached.region;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000); // 3秒超时

    const response = await fetch(
      `http://ip-api.com/json/${ip}?lang=zh-CN&fields=status,regionName,city`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);

    const data = (await response.json()) as IpApiResponse;
    if (data.status === 'success') {
      const region = `${data.regionName || ''}${data.city || ''}`.trim() || '未知';
      // 写入缓存
      ipCache.set(ip, { region, expireAt: Date.now() + IP_CACHE_TTL });
      cleanIpCache();
      return region;
    }
  } catch (err) {
    // 超时或网络错误，静默处理，不影响登录流程
    console.error('[IP解析] 失败:', (err as Error).message);
  }

  return '未知';
}
