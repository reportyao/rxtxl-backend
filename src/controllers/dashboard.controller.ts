/**
 * ===================================================================
 * 管理后台数据看板控制器 (Dashboard Controller)
 * ===================================================================
 *
 * v1.1 优化：
 * - [性能] 总览数据增加60秒缓存，避免频繁刷新时重复查询
 * - [性能] 趋势数据增加300秒缓存
 * - [安全] days参数增加上限校验（最大365天）
 */

import { Request, Response } from 'express';
import prisma from '../config/database';
import { success, error } from '../utils/response';
import { apiCache } from '../middleware/performance';

/**
 * 获取总览数据（核心指标卡片）
 *
 * GET /api/admin/dashboard/overview
 *
 * [性能优化] 增加60秒缓存
 */
export async function getOverview(req: Request, res: Response): Promise<void> {
  try {
    // 尝试从缓存获取
    const cacheKey = 'dashboard:overview';
    const cached = apiCache.get<any>(cacheKey);
    if (cached) {
      success(res, cached);
      return;
    }

    // 计算今日的时间范围（UTC 00:00 ~ 23:59）
    const today = new Date().toISOString().split('T')[0];
    const todayStart = new Date(today);
    const todayEnd = new Date(today);
    todayEnd.setDate(todayEnd.getDate() + 1);

    // 30天前的时间点（用于计算MAU）
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // 并行执行7个count查询
    const [
      totalUsers,
      todayNewUsers,
      totalArticles,
      totalDiaries,
      todayDiaries,
      dau,
      mau,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({
        where: { createdAt: { gte: todayStart, lt: todayEnd } },
      }),
      prisma.article.count({ where: { status: 'published' } }),
      prisma.diary.count(),
      prisma.diary.count({
        where: { diaryDate: today },
      }),
      prisma.user.count({
        where: { lastLoginAt: { gte: todayStart } },
      }),
      prisma.user.count({
        where: { lastLoginAt: { gte: thirtyDaysAgo } },
      }),
    ]);

    const result = {
      totalUsers,
      todayNewUsers,
      dau,
      mau,
      totalArticles,
      totalDiaries,
      todayDiaries,
    };

    // 缓存60秒
    apiCache.set(cacheKey, result, 60 * 1000);

    success(res, result);
  } catch (err) {
    console.error('[getOverview]', err);
    error(res, '获取总览数据失败');
  }
}

/**
 * 获取用户增长趋势（折线图数据）
 *
 * GET /api/admin/dashboard/user-trend
 * Query: { days?: number } 默认30天，最大365天
 */
export async function getUserTrend(req: Request, res: Response): Promise<void> {
  try {
    const days = Math.min(Math.max(1, parseInt(req.query.days as string) || 30), 365);

    // 尝试从缓存获取
    const cacheKey = `dashboard:user-trend:${days}`;
    const cached = apiCache.get<any>(cacheKey);
    if (cached) {
      success(res, cached);
      return;
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days + 1);
    const startDateStr = startDate.toISOString().split('T')[0];
    const startDateTime = new Date(startDateStr);

    const [newUsers, activeUsers] = await Promise.all([
      prisma.user.findMany({
        where: { createdAt: { gte: startDateTime } },
        select: { createdAt: true },
      }),
      prisma.user.findMany({
        where: { lastLoginAt: { gte: startDateTime } },
        select: { lastLoginAt: true },
      }),
    ]);

    const newUsersByDate: Record<string, number> = {};
    const activeUsersByDate: Record<string, number> = {};

    for (const u of newUsers) {
      const dateStr = u.createdAt.toISOString().split('T')[0];
      newUsersByDate[dateStr] = (newUsersByDate[dateStr] || 0) + 1;
    }

    for (const u of activeUsers) {
      if (u.lastLoginAt) {
        const dateStr = u.lastLoginAt.toISOString().split('T')[0];
        activeUsersByDate[dateStr] = (activeUsersByDate[dateStr] || 0) + 1;
      }
    }

    const trend: { date: string; newUsers: number; activeUsers: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      trend.push({
        date: dateStr,
        newUsers: newUsersByDate[dateStr] || 0,
        activeUsers: activeUsersByDate[dateStr] || 0,
      });
    }

    // 缓存300秒
    apiCache.set(cacheKey, trend, 300 * 1000);

    success(res, trend);
  } catch (err) {
    console.error('[getUserTrend]', err);
    error(res, '获取用户趋势失败');
  }
}

/**
 * 获取日记写作趋势（折线图数据）
 *
 * GET /api/admin/dashboard/diary-trend
 * Query: { days?: number } 默认30天，最大365天
 */
export async function getDiaryTrend(req: Request, res: Response): Promise<void> {
  try {
    const days = Math.min(Math.max(1, parseInt(req.query.days as string) || 30), 365);

    // 尝试从缓存获取
    const cacheKey = `dashboard:diary-trend:${days}`;
    const cached = apiCache.get<any>(cacheKey);
    if (cached) {
      success(res, cached);
      return;
    }

    const dates: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      dates.push(date.toISOString().split('T')[0]);
    }

    const diaries = await prisma.diary.findMany({
      where: { diaryDate: { in: dates } },
      select: { diaryDate: true },
    });

    const diaryByDate: Record<string, number> = {};
    for (const d of diaries) {
      diaryByDate[d.diaryDate] = (diaryByDate[d.diaryDate] || 0) + 1;
    }

    const trend = dates.map(date => ({
      date,
      diaryCount: diaryByDate[date] || 0,
    }));

    // 缓存300秒
    apiCache.set(cacheKey, trend, 300 * 1000);

    success(res, trend);
  } catch (err) {
    console.error('[getDiaryTrend]', err);
    error(res, '获取日记趋势失败');
  }
}

/**
 * 获取打卡天数分布（柱状图数据）
 *
 * GET /api/admin/dashboard/streak-distribution
 */
export async function getStreakDistribution(req: Request, res: Response): Promise<void> {
  try {
    const cacheKey = 'dashboard:streak-distribution';
    const cached = apiCache.get<any>(cacheKey);
    if (cached) {
      success(res, cached);
      return;
    }

    const users = await prisma.user.findMany({
      select: { streakDays: true },
      where: { streakDays: { gt: 0 } },
    });

    const distribution: Record<string, number> = {
      '1-3天': 0,
      '4-7天': 0,
      '8-14天': 0,
      '15-30天': 0,
      '30天以上': 0,
    };

    for (const user of users) {
      const days = user.streakDays;
      if (days <= 3) distribution['1-3天']++;
      else if (days <= 7) distribution['4-7天']++;
      else if (days <= 14) distribution['8-14天']++;
      else if (days <= 30) distribution['15-30天']++;
      else distribution['30天以上']++;
    }

    // 缓存300秒
    apiCache.set(cacheKey, distribution, 300 * 1000);

    success(res, distribution);
  } catch (err) {
    console.error('[getStreakDistribution]', err);
    error(res, '获取打卡分布失败');
  }
}

/**
 * 获取用户IP地理分布（条形图数据）
 *
 * GET /api/admin/dashboard/ip-distribution
 */
export async function getIpDistribution(req: Request, res: Response): Promise<void> {
  try {
    const cacheKey = 'dashboard:ip-distribution';
    const cached = apiCache.get<any>(cacheKey);
    if (cached) {
      success(res, cached);
      return;
    }

    const users = await prisma.user.findMany({
      select: { ipRegion: true },
      where: { ipRegion: { not: null } },
    });

    const distribution: Record<string, number> = {};
    for (const user of users) {
      const region = user.ipRegion || '未知';
      distribution[region] = (distribution[region] || 0) + 1;
    }

    const sorted = Object.entries(distribution)
      .map(([region, count]) => ({ region, count }))
      .sort((a, b) => b.count - a.count);

    // 缓存300秒
    apiCache.set(cacheKey, sorted, 300 * 1000);

    success(res, sorted);
  } catch (err) {
    console.error('[getIpDistribution]', err);
    error(res, '获取IP分布失败');
  }
}

/**
 * 获取用户列表（管理后台）
 *
 * GET /api/admin/users
 * Query: { page?: number, pageSize?: number }
 */
export async function getUsers(req: Request, res: Response): Promise<void> {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(Math.max(1, parseInt(req.query.pageSize as string) || 20), 100);
    const skip = (page - 1) * pageSize;

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        select: {
          id: true,
          phone: true,
          nickname: true,
          createdAt: true,
          lastLoginAt: true,
          lastLoginIp: true,
          ipRegion: true,
          streakDays: true,
          _count: {
            select: { diaries: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.user.count(),
    ]);

    // 手机号脱敏处理：138****1234
    const maskedUsers = users.map(user => ({
      ...user,
      phone: user.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'),
      diaryCount: user._count.diaries,
      lastIpRegion: user.ipRegion || '未知',
    }));

    success(res, {
      list: maskedUsers,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (err) {
    console.error('[getUsers]', err);
    error(res, '获取用户列表失败');
  }
}
