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
 * 数据安全设计：
 * - 日记内容在前端使用AES-256-GCM加密后上传
 * - 服务器存储的是密文（encryptedData）和初始化向量（iv）
 * - 服务器无法解密日记内容，即使数据库泄露也不影响用户隐私
 * - mainStone（主石头）是用户可选的明文摘要，用于石头收藏馆展示
 *
 * 打卡机制：
 * - 每天写日记自动打卡，同一天多次写入只算一次
 * - 连续天数基于日期字符串计算，避免时区问题
 * - 打卡记录独立存表，支持按月查询日历展示
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
 * 使用upsert策略：同一天只能有一篇日记
 * - 如果当天已有日记 → 更新密文内容
 * - 如果当天没有日记 → 创建新日记 + 自动打卡
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

    // ===== Upsert日记 =====
    // 联合唯一索引：userId + diaryDate，保证每人每天只有一篇日记
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

    // ===== 自动打卡 =====
    // 写日记即打卡，更新连续天数
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
 * 更新打卡记录和连续天数（内部函数）
 *
 * 打卡逻辑：
 * 1. 检查当天是否已打卡（防止重复计算）
 * 2. 检查昨天是否打卡：
 *    - 昨天打卡了 → 连续天数 = 当前连续天数 + 1
 *    - 昨天没打卡 → 连续天数重置为 1
 * 3. 创建打卡记录并更新用户的连续天数
 *
 * 时区处理：
 * - 使用纯字符串日期（YYYY-MM-DD）进行计算
 * - 通过手动构造Date对象计算"昨天"，避免UTC/本地时区偏差
 * - 这样无论服务器在哪个时区，结果都是一致的
 *
 * @param userId - 用户ID
 * @param diaryDate - 打卡日期，格式：YYYY-MM-DD
 */
async function updateCheckin(userId: string, diaryDate: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;

  // 检查是否已经打卡（同一天多次写日记只算一次打卡）
  const existingCheckin = await prisma.checkin.findUnique({
    where: { userId_checkinDate: { userId, checkinDate: diaryDate } },
  });

  if (existingCheckin) return;

  // ===== 计算"昨天"的日期字符串 =====
  // 使用本地时间构造Date对象，避免UTC偏移问题
  const [year, month, day] = diaryDate.split('-').map(Number);
  const todayDate = new Date(year, month - 1, day);
  todayDate.setDate(todayDate.getDate() - 1);
  const yesterdayStr = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, '0')}-${String(todayDate.getDate()).padStart(2, '0')}`;

  // 查询昨天是否有打卡记录
  const yesterdayCheckin = await prisma.checkin.findUnique({
    where: { userId_checkinDate: { userId, checkinDate: yesterdayStr } },
  });

  // 计算新的连续天数
  let newStreakDays: number;
  if (yesterdayCheckin) {
    // 昨天也打卡了 → 连续天数递增
    newStreakDays = user.streakDays + 1;
  } else {
    // 昨天没打卡 → 连续天数重置为1（今天是新的开始）
    newStreakDays = 1;
  }

  // 创建打卡记录（记录当时的连续天数，用于历史回溯）
  await prisma.checkin.create({
    data: {
      userId,
      checkinDate: diaryDate,
      streakCount: newStreakDays,
    },
  });

  // 更新用户表的连续天数和最后打卡时间
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
 *
 * GET /api/diaries
 * Headers: Authorization: Bearer <token>
 * Query: { page?: number, pageSize?: number, month?: string }
 *
 * 注意：列表接口只返回元数据（日期、主石头、创建时间），不返回密文内容
 * 这样可以在不解密的情况下展示日记列表
 * 用户点击具体日记后，再调用详情接口获取密文并在前端解密
 *
 * @param month - 可选，按月筛选，格式：YYYY-MM
 */
export async function getDiaries(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 30;
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
 *
 * 返回完整的日记数据，包括encryptedData和iv
 * 前端收到后使用用户的AES密钥在本地解密展示
 *
 * 安全检查：只能查看自己的日记（where条件包含userId）
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
 *
 * 返回数据：
 * - checkins: 打卡记录列表（日期 + 当时的连续天数）
 * - currentStreak: 当前连续打卡天数
 * - totalCheckins: 历史总打卡天数
 *
 * 前端用途：
 * - 河水日历：在日历上标记已打卡的日期
 * - 打卡统计：展示连续天数和累计天数
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

    const checkins = await prisma.checkin.findMany({
      where,
      select: {
        checkinDate: true,
        streakCount: true,
      },
      orderBy: { checkinDate: 'asc' },
    });

    // 并行获取用户当前连续天数和历史总打卡天数
    const [user, totalCheckins] = await Promise.all([
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
 *
 * 石头收藏馆的核心逻辑：
 * 1. 查询所有有mainStone的日记
 * 2. 按mainStoneHash聚合相同的石头（同一个主题的石头合并）
 * 3. 按出现频次降序排列（最常出现的石头排在前面）
 *
 * 返回数据：
 * - stones: 聚合后的石头列表（内容、出现次数、出现日期、关联日记ID）
 * - totalStones: 石头总数（含重复）
 * - uniqueStones: 去重后的石头种类数
 *
 * 前端用途：
 * - Canvas河床可视化：石头大小与出现频次成正比
 * - 点击石头查看关联的所有日记
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
    // 使用mainStoneHash作为聚合key（如果没有hash则用内容本身）
    // 这样即使用户用不同措辞描述同一个问题，只要hash相同就会聚合
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
 *
 * 安全检查：只能删除自己的日记
 * 注意：删除日记不会影响打卡记录（打卡是不可逆的）
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
