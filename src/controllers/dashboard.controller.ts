import { Request, Response } from 'express';
import prisma from '../config/database';
import { success, error } from '../utils/response';

/**
 * 获取总览数据
 * GET /api/admin/dashboard/overview
 */
export async function getOverview(req: Request, res: Response): Promise<void> {
  try {
    const today = new Date().toISOString().split('T')[0];
    const todayStart = new Date(today);
    const todayEnd = new Date(today);
    todayEnd.setDate(todayEnd.getDate() + 1);

    // 30天前
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

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

    success(res, {
      totalUsers,
      todayNewUsers,
      dau,
      mau,
      totalArticles,
      totalDiaries,
      todayDiaries,
    });
  } catch (err) {
    console.error('[getOverview]', err);
    error(res, '获取总览数据失败');
  }
}

/**
 * 获取用户增长趋势（最近30天）
 * 优化：使用批量查询替代N+1循环查询
 * GET /api/admin/dashboard/user-trend
 */
export async function getUserTrend(req: Request, res: Response): Promise<void> {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days + 1);
    const startDateStr = startDate.toISOString().split('T')[0];
    const startDateTime = new Date(startDateStr);

    // 批量获取时间范围内的所有新用户
    const newUsers = await prisma.user.findMany({
      where: { createdAt: { gte: startDateTime } },
      select: { createdAt: true },
    });

    // 批量获取时间范围内的所有活跃用户
    const activeUsers = await prisma.user.findMany({
      where: { lastLoginAt: { gte: startDateTime } },
      select: { lastLoginAt: true },
    });

    // 在内存中按日期分组
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

    // 生成趋势数据
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

    success(res, trend);
  } catch (err) {
    console.error('[getUserTrend]', err);
    error(res, '获取用户趋势失败');
  }
}

/**
 * 获取日记写作趋势（最近30天）
 * 优化：使用批量查询替代N+1循环查询
 * GET /api/admin/dashboard/diary-trend
 */
export async function getDiaryTrend(req: Request, res: Response): Promise<void> {
  try {
    const days = parseInt(req.query.days as string) || 30;

    // 生成日期范围
    const dates: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      dates.push(date.toISOString().split('T')[0]);
    }

    // 批量查询所有日期的日记数量
    const diaries = await prisma.diary.findMany({
      where: { diaryDate: { in: dates } },
      select: { diaryDate: true },
    });

    // 在内存中按日期分组
    const diaryByDate: Record<string, number> = {};
    for (const d of diaries) {
      diaryByDate[d.diaryDate] = (diaryByDate[d.diaryDate] || 0) + 1;
    }

    const trend = dates.map(date => ({
      date,
      diaryCount: diaryByDate[date] || 0,
    }));

    success(res, trend);
  } catch (err) {
    console.error('[getDiaryTrend]', err);
    error(res, '获取日记趋势失败');
  }
}

/**
 * 获取打卡天数分布
 * GET /api/admin/dashboard/streak-distribution
 */
export async function getStreakDistribution(req: Request, res: Response): Promise<void> {
  try {
    const users = await prisma.user.findMany({
      select: { streakDays: true },
      where: { streakDays: { gt: 0 } },
    });

    // 分组统计
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

    success(res, distribution);
  } catch (err) {
    console.error('[getStreakDistribution]', err);
    error(res, '获取打卡分布失败');
  }
}

/**
 * 获取用户IP地理分布
 * GET /api/admin/dashboard/ip-distribution
 */
export async function getIpDistribution(req: Request, res: Response): Promise<void> {
  try {
    const users = await prisma.user.findMany({
      select: { ipRegion: true },
      where: { ipRegion: { not: null } },
    });

    const distribution: Record<string, number> = {};
    for (const user of users) {
      const region = user.ipRegion || '未知';
      distribution[region] = (distribution[region] || 0) + 1;
    }

    // 转换为数组并排序
    const sorted = Object.entries(distribution)
      .map(([region, count]) => ({ region, count }))
      .sort((a, b) => b.count - a.count);

    success(res, sorted);
  } catch (err) {
    console.error('[getIpDistribution]', err);
    error(res, '获取IP分布失败');
  }
}

/**
 * 获取用户列表（管理后台）
 * GET /api/admin/users
 */
export async function getUsers(req: Request, res: Response): Promise<void> {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
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

    // 手机号脱敏
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
