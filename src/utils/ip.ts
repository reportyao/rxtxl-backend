import { Request } from 'express';

/**
 * 从请求中获取客户端IP
 */
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

/**
 * 简单的IP归属地解析
 * 生产环境可接入IP归属地API（如ip-api.com或淘宝IP接口）
 */
export async function resolveIpRegion(ip: string): Promise<string> {
  // 本地/私有IP
  if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return '本地网络';
  }

  try {
    const response = await fetch(`http://ip-api.com/json/${ip}?lang=zh-CN&fields=status,regionName,city`);
    const data = await response.json();
    if (data.status === 'success') {
      return `${data.regionName || ''}${data.city || ''}`.trim() || '未知';
    }
  } catch (err) {
    console.error('[IP解析] 失败:', err);
  }

  return '未知';
}
