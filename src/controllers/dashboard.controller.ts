/**
 * ===================================================================
 * 管理后台数据看板控制器 (Dashboard Controller)
 * ===================================================================
 *
 * 负责管理后台的数据统计和可视化接口：
 * 1. 总览数据（核心指标卡片）
 * 2. 用户增长趋势（折线图数据）
 * 3. 日记写作趋势（折线图数据）
 * 4. 打卡天数分布（柱状图数据）
 * 5. IP地理分布（条形图数据）
 * 6. 用户列表（分页，含手机号脱敏）
 *
 * 性能优化策略：
 * - 所有统计接口使用 Promise.all 并行查询，减少数据库往返
 * - 趋势数据使用"批量查询 + 内存分组"替代"N次循环查询"
 *   例如：30天趋势只需2次DB查询（而非60次），时间复杂度从O(N)降到O(1)
 * - 用户列表使用Prisma的_count关联查询，避免N+1问题
 *
 * 安全策略：
 * - 所有接口需要Basic Auth认证（在admin.routes.ts中配置）
 * - 用户手机号在返回前做脱敏处理（中间4位替换为****）
 */

import { Request, Response } from 'express';
import prisma from '../config/database';
import { success, error } from '../utils/response';

/**
 * 获取总览数据（核心指标卡片）
 *
 * GET /api/admin/dashboard/overview
 *
 * 返回7个核心指标：
 * - totalUsers: 注册用户总数
 * - todayNewUsers: 今日新增用户数
 * - dau: 日活跃用户数（今日登录过的用户）
 * - mau: 月活跃用户数（30天内登录过的用户）
 * - totalArticles: 已发布文章总数
 * - totalDiaries: 日记总数
 * - todayDiaries: 今日新增日记数
 *
 * 性能：7个指标通过1次Promise.all并行查询完成
 */
export async function getOverview(req: Request, res: Response): Promise<void> {
  try {
    // 计算今日的时间范围（UTC 00:00 ~ 23:59）
    const today = new Date().toISOString().split('T')[0];
    const todayStart = new Date(today);
    const todayEnd = new Date(today);
    todayEnd.setDate(todayEnd.getDate() + 1);

    // 30天前的时间点（用于计算MAU）
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // 并行执行7个count查询，大幅减少总耗时
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
      // DAU：今日登录过的用户数
      prisma.user.count({
        where: { lastLoginAt: { gte: todayStart } },
      }),
      // MAU：30天内登录过的用户数
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
 * 获取用户增长趋势（折线图数据）
 *
 * GET /api/admin/dashboard/user-trend
 * Query: { days?: number } 默认30天
 *
 * 优化策略（替代N+1循环查询）：
 * 1. 一次性查询时间范围内的所有新用户和活跃用户
 * 2. 在内存中按日期分组统计
 * 3. 总共只需2次DB查询（而非 days*2 次）
 *
 * 返回：按日期排列的数组，每项包含 { date, newUsers, activeUsers }
 */
export async function getUserTrend(req: Request, res: Response): Promise<void> {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days + 1);
    const startDateStr = startDate.toISOString().split('T')[0];
    const startDateTime = new Date(startDateStr);

    // ===== 批量查询（2次DB查询替代 days*2 次） =====
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

    // ===== 内存中按日期分组 =====
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

    // 生成完整的日期序列（确保没有数据的日期也有记录，值为0）
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
 * 获取日记写作趋势（折线图数据）
 *
 * GET /api/admin/dashboard/diary-trend
 * Query: { days?: number } 默认30天
 *
 * 优化策略：同getUserTrend，使用"批量查询 + 内存分组"
 * 利用diaryDate字段（YYYY-MM-DD字符串）的IN查询批量获取
 *
 * 返回：按日期排列的数组，每项包含 { date, diaryCount }
 */
export async function getDiaryTrend(req: Request, res: Response): Promise<void> {
  try {
    const days = parseInt(req.query.days as string) || 30;

    // 生成日期范围数组
    const dates: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      dates.push(date.toISOString().split('T')[0]);
    }

    // 一次IN查询获取所有日期的日记（替代N次循环查询）
    const diaries = await prisma.diary.findMany({
      where: { diaryDate: { in: dates } },
      select: { diaryDate: true },
    });

    // 内存中按日期分组计数
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
 * 获取打卡天数分布（柱状图数据）
 *
 * GET /api/admin/dashboard/streak-distribution
 *
 * 将用户按连续打卡天数分为5个区间：
 * - 1-3天、4-7天、8-14天、15-30天、30天以上
 *
 * 用途：了解用户的留存和习惯养成情况
 * - 大部分用户在1-3天 → 需要加强新手引导和激励
 * - 30天以上用户较多 → 产品粘性好，可以推进商业化
 */
export async function getStreakDistribution(req: Request, res: Response): Promise<void> {
  try {
    // 只查询有打卡记录的用户
    const users = await prisma.user.findMany({
      select: { streakDays: true },
      where: { streakDays: { gt: 0 } },
    });

    // 按区间分组统计
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
 * 获取用户IP地理分布（条形图数据）
 *
 * GET /api/admin/dashboard/ip-distribution
 *
 * 基于用户最后登录IP解析的归属地进行统计
 * IP归属地在用户登录时通过ip-api.com解析并存储
 *
 * 返回：按用户数降序排列的地区列表
 * 用途：了解用户地域分布，指导运营策略
 */
export async function getIpDistribution(req: Request, res: Response): Promise<void> {
  try {
    const users = await prisma.user.findMany({
      select: { ipRegion: true },
      where: { ipRegion: { not: null } },
    });

    // 按地区聚合计数
    const distribution: Record<string, number> = {};
    for (const user of users) {
      const region = user.ipRegion || '未知';
      distribution[region] = (distribution[region] || 0) + 1;
    }

    // 转换为数组并按用户数降序排列
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
 *
 * GET /api/admin/users
 * Query: { page?: number, pageSize?: number }
 *
 * 返回用户列表，包含：
 * - 基本信息（昵称、注册时间、最后登录时间）
 * - 手机号（脱敏处理：138****1234）
 * - IP归属地
 * - 连续打卡天数
 * - 日记总数（通过Prisma _count关联查询，避免N+1问题）
 *
 * 安全处理：
 * - 手机号中间4位替换为****，保护用户隐私
 * - 不返回pinHash、pinSalt等敏感字段
 */
export async function getUsers(req: Request, res: Response): Promise<void> {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const skip = (page - 1) * pageSize;

    // 使用Prisma的_count关联查询，一次查询获取用户信息和日记数量
    // 避免了"先查用户列表，再逐个查日记数"的N+1问题
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
