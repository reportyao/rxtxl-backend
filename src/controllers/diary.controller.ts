/**
 * ===================================================================
 * 道痕日记控制器 (Diary Controller)
 * ===================================================================
 *
 * 负责道痕日记相关的所有业务逻辑：
 * 1. 创建/更新日记（接收前端加密后的密文，服务器不解密）
 * 2. 查询日记列表（只返回元数据，不含密文内容）
 * 3. 查询日记详情（返回密文，由前端解密展示）
 * 4. 打卡记录管理（自动记录打卡、计算连续天数）
 * 5. 石头收藏馆数据（聚合主石头、统计出现频次）
 * 6. 删除日记
 *
 * v1.1 优化：
 * - [BUG FIX] 日记创建和打卡使用事务，确保数据一致性
 * - [BUG FIX] 日期验证增强，防止未来日期和无效日期
 * - [性能] pageSize增加上限校验，防止恶意大量请求
 * - [安全] 增加encryptedData长度校验
 */

import { Request, Response } from 'express';
import prisma from '../config/database';
import { success, error, validationError, notFound } from '../utils/response';

/**
 * 创建或更新道痕日记
 *
 * POST /api/diaries
 * Headers: Authorization: Bearer <token>
 * Body: {
 *   encryptedData: string,  // AES-256-GCM加密后的Base64密文
 *   iv: string,             // 加密使用的初始化向量（Base64）
 *   mainStone?: string,     // 主石头明文摘要（可选，用于石头收藏馆）
 *   mainStoneHash?: string, // 主石头内容的SHA-256 hash（用于聚合相同石头）
 *   diaryDate: string       // 日记日期，格式：YYYY-MM-DD
 * }
 *
 * [BUG FIX] 使用Prisma事务确保日记创建和打卡记录的原子性
 */
export async function createDiary(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { encryptedData, iv, mainStone, mainStoneHash, diaryDate } = req.body;

    // ===== 参数校验 =====
    if (!encryptedData || !iv || !diaryDate) {
      validationError(res, '加密数据、IV和日期为必填项');
      return;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(diaryDate)) {
      validationError(res, '日期格式错误，应为YYYY-MM-DD');
      return;
    }

    // 验证日期有效性（防止无效日期如2024-02-30）
    const [year, month, day] = diaryDate.split('-').map(Number);
    const dateObj = new Date(year, month - 1, day);
    if (dateObj.getFullYear() !== year || dateObj.getMonth() !== month - 1 || dateObj.getDate() !== day) {
      validationError(res, '无效的日期');
      return;
    }

    // 防止未来日期（允许当天）
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    if (diaryDate > todayStr) {
      validationError(res, '不能创建未来日期的日记');
      return;
    }

    // 加密数据长度校验（防止恶意超大数据，最大1MB Base64）
    if (encryptedData.length > 1024 * 1024) {
      validationError(res, '日记内容过长');
      return;
    }

    // mainStone长度校验
    if (mainStone && mainStone.length > 200) {
      validationError(res, '主石头内容过长（最多200字）');
      return;
    }

    // ===== 使用事务确保日记和打卡的原子性 =====
    const result = await prisma.$transaction(async (tx) => {
      // Upsert日记
      const diary = await tx.diary.upsert({
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

      // 自动打卡（在事务内执行）
      await updateCheckinInTransaction(tx, userId, diaryDate);

      return diary;
    });

    success(res, {
      id: result.id,
      diaryDate: result.diaryDate,
      mainStone: result.mainStone,
      createdAt: result.createdAt,
    }, '道痕已保存');
  } catch (err) {
    console.error('[createDiary]', err);
    error(res, '保存道痕失败');
  }
}

/**
 * 更新打卡记录和连续天数（事务内部函数）
 *
 * [BUG FIX] 原来的updateCheckin是独立函数，与日记创建不在同一事务中。
 * 如果打卡更新失败，日记已经创建成功，导致数据不一致。
 * 现在改为在事务内执行，确保原子性。
 *
 * @param tx - Prisma事务客户端
 * @param userId - 用户ID
 * @param diaryDate - 打卡日期，格式：YYYY-MM-DD
 */
async function updateCheckinInTransaction(tx: any, userId: string, diaryDate: string): Promise<void> {
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user) return;

  // 检查是否已经打卡（同一天多次写日记只算一次打卡）
  const existingCheckin = await tx.checkin.findUnique({
    where: { userId_checkinDate: { userId, checkinDate: diaryDate } },
  });

  if (existingCheckin) return;

  // ===== 计算"昨天"的日期字符串 =====
  const [year, month, day] = diaryDate.split('-').map(Number);
  const todayDate = new Date(year, month - 1, day);
  todayDate.setDate(todayDate.getDate() - 1);
  const yesterdayStr = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, '0')}-${String(todayDate.getDate()).padStart(2, '0')}`;

  // 查询昨天是否有打卡记录
  const yesterdayCheckin = await tx.checkin.findUnique({
    where: { userId_checkinDate: { userId, checkinDate: yesterdayStr } },
  });

  // 计算新的连续天数
  let newStreakDays: number;
  if (yesterdayCheckin) {
    newStreakDays = user.streakDays + 1;
  } else {
    newStreakDays = 1;
  }

  // 创建打卡记录
  await tx.checkin.create({
    data: {
      userId,
      checkinDate: diaryDate,
      streakCount: newStreakDays,
    },
  });

  // 更新用户表的连续天数和最后打卡时间
  await tx.user.update({
    where: { id: userId },
    data: {
      streakDays: newStreakDays,
      lastCheckinAt: new Date(),
    },
  });
}

/**
 * 获取日记列表
 *
 * GET /api/diaries
 * Headers: Authorization: Bearer <token>
 * Query: { page?: number, pageSize?: number, month?: string }
 *
 * [性能优化] pageSize增加上限100，防止恶意请求大量数据
 */
export async function getDiaries(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(Math.max(1, parseInt(req.query.pageSize as string) || 30), 100);
    const month = req.query.month as string;
    const skip = (page - 1) * pageSize;

    const where: any = { userId };

    // 按月份筛选：利用diaryDate字符串的前缀匹配
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      where.diaryDate = {
        startsWith: month,
      };
    }

    // 并行查询列表和总数，减少数据库往返
    const [diaries, total] = await Promise.all([
      prisma.diary.findMany({
        where,
        select: {
          id: true,
          diaryDate: true,
          mainStone: true,
          mainStoneHash: true,
          createdAt: true,
          // 注意：不返回encryptedData和iv，减少传输量
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
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (err) {
    console.error('[getDiaries]', err);
    error(res, '获取日记列表失败');
  }
}

/**
 * 获取日记详情（包含加密数据）
 *
 * GET /api/diaries/:id
 * Headers: Authorization: Bearer <token>
 */
export async function getDiaryDetail(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;

    // 同时校验id和userId，防止越权访问
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
 *
 * GET /api/diaries/checkins
 * Headers: Authorization: Bearer <token>
 * Query: { month?: string }
 */
export async function getCheckins(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const month = req.query.month as string;

    const where: any = { userId };
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      where.checkinDate = {
        startsWith: month,
      };
    }

    // 并行获取打卡记录、用户连续天数和总打卡天数
    const [checkins, user, totalCheckins] = await Promise.all([
      prisma.checkin.findMany({
        where,
        select: {
          checkinDate: true,
          streakCount: true,
        },
        orderBy: { checkinDate: 'asc' },
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { streakDays: true },
      }),
      prisma.checkin.count({ where: { userId } }),
    ]);

    success(res, {
      checkins,
      currentStreak: user?.streakDays || 0,
      totalCheckins,
    });
  } catch (err) {
    console.error('[getCheckins]', err);
    error(res, '获取打卡记录失败');
  }
}

/**
 * 获取石头收藏馆数据
 *
 * GET /api/diaries/stones
 * Headers: Authorization: Bearer <token>
 */
export async function getStones(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;

    // 查询所有有主石头的日记
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

    // ===== 聚合相同的石头 =====
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

    // 按出现频次降序排列
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
 *
 * DELETE /api/diaries/:id
 * Headers: Authorization: Bearer <token>
 */
export async function deleteDiary(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;

    // 先查询确认日记存在且属于当前用户
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
