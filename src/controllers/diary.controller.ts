import { Request, Response } from 'express';
import prisma from '../config/database';
import { success, error, validationError, notFound } from '../utils/response';

/**
 * 创建/更新道痕日记
 * POST /api/diaries
 */
export async function createDiary(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { encryptedData, iv, mainStone, mainStoneHash, diaryDate } = req.body;

    if (!encryptedData || !iv || !diaryDate) {
      validationError(res, '加密数据、IV和日期为必填项');
      return;
    }

    // 验证日期格式 YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(diaryDate)) {
      validationError(res, '日期格式错误，应为YYYY-MM-DD');
      return;
    }

    // 使用upsert，如果当天已有日记则更新
    const diary = await prisma.diary.upsert({
      where: {
        userId_diaryDate: { userId, diaryDate },
      },
      update: {
        encryptedData,
        iv,
        mainStone: mainStone || null,
        mainStoneHash: mainStoneHash || null,
      },
      create: {
        userId,
        encryptedData,
        iv,
        mainStone: mainStone || null,
        mainStoneHash: mainStoneHash || null,
        diaryDate,
      },
    });

    // 更新打卡记录
    await updateCheckin(userId, diaryDate);

    success(res, {
      id: diary.id,
      diaryDate: diary.diaryDate,
      mainStone: diary.mainStone,
      createdAt: diary.createdAt,
    }, '道痕已保存');
  } catch (err) {
    console.error('[createDiary]', err);
    error(res, '保存道痕失败');
  }
}

/**
 * 更新打卡记录和连续天数
 */
async function updateCheckin(userId: string, diaryDate: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;

  // 检查是否已经打卡
  const existingCheckin = await prisma.checkin.findUnique({
    where: { userId_checkinDate: { userId, checkinDate: diaryDate } },
  });

  if (existingCheckin) return; // 已打卡，不重复计算

  // 计算连续天数
  const today = new Date(diaryDate);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  const yesterdayCheckin = await prisma.checkin.findUnique({
    where: { userId_checkinDate: { userId, checkinDate: yesterdayStr } },
  });

  let newStreakDays: number;
  if (yesterdayCheckin) {
    // 昨天也打卡了，连续天数+1
    newStreakDays = user.streakDays + 1;
  } else {
    // 昨天没打卡，重新开始计数
    newStreakDays = 1;
  }

  // 创建打卡记录
  await prisma.checkin.create({
    data: {
      userId,
      checkinDate: diaryDate,
      streakCount: newStreakDays,
    },
  });

  // 更新用户连续天数
  await prisma.user.update({
    where: { id: userId },
    data: {
      streakDays: newStreakDays,
      lastCheckinAt: new Date(),
    },
  });
}

/**
 * 获取日记列表
 * GET /api/diaries
 */
export async function getDiaries(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 30;
    const month = req.query.month as string; // YYYY-MM 格式
    const skip = (page - 1) * pageSize;

    const where: any = { userId };

    // 按月份筛选
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      where.diaryDate = {
        startsWith: month,
      };
    }

    const [diaries, total] = await Promise.all([
      prisma.diary.findMany({
        where,
        select: {
          id: true,
          diaryDate: true,
          mainStone: true,
          mainStoneHash: true,
          createdAt: true,
        },
        orderBy: { diaryDate: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.diary.count({ where }),
    ]);

    success(res, {
      list: diaries,
      total,
      page,
      pageSize,
    });
  } catch (err) {
    console.error('[getDiaries]', err);
    error(res, '获取日记列表失败');
  }
}

/**
 * 获取日记详情（加密数据）
 * GET /api/diaries/:id
 */
export async function getDiaryDetail(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;

    const diary = await prisma.diary.findFirst({
      where: { id, userId },
    });

    if (!diary) {
      notFound(res, '日记不存在');
      return;
    }

    success(res, diary);
  } catch (err) {
    console.error('[getDiaryDetail]', err);
    error(res, '获取日记详情失败');
  }
}

/**
 * 获取打卡记录
 * GET /api/diaries/checkins
 */
export async function getCheckins(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const month = req.query.month as string; // YYYY-MM

    const where: any = { userId };
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      where.checkinDate = {
        startsWith: month,
      };
    }

    const checkins = await prisma.checkin.findMany({
      where,
      select: {
        checkinDate: true,
        streakCount: true,
      },
      orderBy: { checkinDate: 'asc' },
    });

    // 获取用户当前连续天数
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { streakDays: true },
    });

    success(res, {
      checkins,
      currentStreak: user?.streakDays || 0,
    });
  } catch (err) {
    console.error('[getCheckins]', err);
    error(res, '获取打卡记录失败');
  }
}

/**
 * 获取石头收藏馆数据
 * GET /api/diaries/stones
 */
export async function getStones(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;

    // 获取所有有主石头的日记
    const diaries = await prisma.diary.findMany({
      where: {
        userId,
        mainStone: { not: null },
      },
      select: {
        id: true,
        mainStone: true,
        mainStoneHash: true,
        diaryDate: true,
      },
      orderBy: { diaryDate: 'asc' },
    });

    // 聚合相同的石头
    const stoneMap = new Map<string, {
      content: string;
      count: number;
      dates: string[];
      diaryIds: string[];
    }>();

    for (const diary of diaries) {
      const key = diary.mainStoneHash || diary.mainStone || '';
      if (!key) continue;

      if (stoneMap.has(key)) {
        const existing = stoneMap.get(key)!;
        existing.count++;
        existing.dates.push(diary.diaryDate);
        existing.diaryIds.push(diary.id);
      } else {
        stoneMap.set(key, {
          content: diary.mainStone!,
          count: 1,
          dates: [diary.diaryDate],
          diaryIds: [diary.id],
        });
      }
    }

    const stones = Array.from(stoneMap.values()).sort((a, b) => b.count - a.count);

    success(res, {
      stones,
      totalStones: diaries.length,
      uniqueStones: stones.length,
    });
  } catch (err) {
    console.error('[getStones]', err);
    error(res, '获取石头数据失败');
  }
}

/**
 * 删除日记
 * DELETE /api/diaries/:id
 */
export async function deleteDiary(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;

    const diary = await prisma.diary.findFirst({
      where: { id, userId },
    });

    if (!diary) {
      notFound(res, '日记不存在');
      return;
    }

    await prisma.diary.delete({ where: { id } });

    success(res, null, '日记已删除');
  } catch (err) {
    console.error('[deleteDiary]', err);
    error(res, '删除日记失败');
  }
}
