/**
 * ===================================================================
 * 用户认证控制器 (Auth Controller)
 * ===================================================================
 *
 * v2.0 改为用户名+密码注册登录模式：
 * 1. 注册：用户名 + 密码（bcrypt 加密存储）
 * 2. 登录：用户名 + 密码
 * 3. 设置日记加密PIN码（服务器只存hash，不存明文）
 * 4. 验证PIN码（前端发hash，服务器比对hash）
 * 5. 重置PIN码（会清除所有历史日记）
 * 6. 获取当前用户信息
 */

import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import prisma from '../config/database';
import { generateToken } from '../utils/jwt';
import { getClientIp, resolveIpRegion } from '../utils/ip';
import { success, error, validationError } from '../utils/response';

const BCRYPT_ROUNDS = 10;

/** PIN验证失败计数器（内存存储，防止暴力破解） */
const pinFailureCount = new Map<string, { count: number; lockUntil: number }>();
const PIN_MAX_FAILURES = 10;
const PIN_LOCK_DURATION_MS = 15 * 60 * 1000; // 锁定15分钟

/**
 * 用户注册
 *
 * POST /api/auth/register
 * Body: { username: string, password: string, confirmPassword: string }
 */
export async function register(req: Request, res: Response): Promise<void> {
  try {
    const { username, password, confirmPassword } = req.body;

    // 校验用户名：2-20位字母数字下划线
    if (!username || !/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/.test(username)) {
      validationError(res, '用户名需为2-20位字母、数字、下划线或中文');
      return;
    }

    // 校验密码长度
    if (!password || password.length < 6 || password.length > 50) {
      validationError(res, '密码长度需在6-50位之间');
      return;
    }

    // 校验两次密码一致
    if (password !== confirmPassword) {
      validationError(res, '两次输入的密码不一致');
      return;
    }

    // 检查用户名是否已存在
    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
      validationError(res, '该用户名已被使用，请换一个');
      return;
    }

    // 加密密码
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // 获取客户端 IP
    const clientIp = getClientIp(req);
    const ipRegion = await resolveIpRegion(clientIp).catch(() => '未知');

    // 创建用户
    const user = await prisma.user.create({
      data: {
        username,
        passwordHash,
        nickname: username,
        lastLoginAt: new Date(),
        lastLoginIp: clientIp,
        ipRegion,
      },
    });

    // 生成 JWT Token
    const token = generateToken({ userId: user.id, phone: user.phone || '' });

    success(res, {
      token,
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname,
        avatar: user.avatar,
        hasPinSet: !!user.pinHash,
        streakDays: user.streakDays,
        salt: user.pinSalt || undefined,
      },
      isNewUser: true,
    }, '注册成功');
  } catch (err) {
    console.error('[register]', err);
    error(res, '注册失败，请稍后重试');
  }
}

/**
 * 用户登录
 *
 * POST /api/auth/login
 * Body: { username: string, password: string }
 */
export async function login(req: Request, res: Response): Promise<void> {
  try {
    const { username, password } = req.body;

    if (!username || typeof username !== 'string' || username.trim() === '') {
      validationError(res, '请输入用户名');
      return;
    }

    if (!password || typeof password !== 'string' || password.length === 0) {
      validationError(res, '请输入密码');
      return;
    }

    // 查找用户（支持用户名登录）
    const user = await prisma.user.findUnique({ where: { username: username.trim() } });

    if (!user || !user.passwordHash) {
      validationError(res, '用户名或密码错误');
      return;
    }

    // 验证密码
    const isMatch = await bcrypt.compare(password, user.passwordHash as string);
    if (!isMatch) {
      validationError(res, '用户名或密码错误');
      return;
    }
    // 获取客户端 IP
    const clientIp = getClientIp(req);;
    const ipRegion = await resolveIpRegion(clientIp).catch(() => '未知');

    // 更新最后登录信息
    await prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        lastLoginIp: clientIp,
        ipRegion,
      },
    });

    // 生成 JWT Token
    const token = generateToken({ userId: user.id, phone: user.phone || '' });

    success(res, {
      token,
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname,
        avatar: user.avatar,
        hasPinSet: !!user.pinHash,
        streakDays: user.streakDays,
        salt: user.pinSalt || undefined,
      },
      isNewUser: false,
    }, '登录成功');
  } catch (err) {
    console.error('[login]', err);
    error(res, '登录失败，请稍后重试');
  }
}

/**
 * 设置日记加密PIN码
 *
 * POST /api/auth/set-pin
 * Headers: Authorization: Bearer <token>
 * Body: { pinHash: string, salt: string }
 */
export async function setPin(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { pinHash, salt } = req.body;

    if (!pinHash || typeof pinHash !== 'string') {
      validationError(res, '缺少PIN码哈希值');
      return;
    }

    if (!salt || typeof salt !== 'string') {
      validationError(res, '缺少加密盐值');
      return;
    }

    if (pinHash.length > 128) {
      validationError(res, 'PIN码哈希值格式错误');
      return;
    }

    if (salt.length > 64) {
      validationError(res, '盐值格式错误');
      return;
    }

    await prisma.user.update({
      where: { id: userId },
      data: { pinHash, pinSalt: salt },
    });

    success(res, null, 'PIN码设置成功');
  } catch (err) {
    console.error('[setPin]', err);
    error(res, 'PIN码设置失败');
  }
}

/**
 * 验证PIN码
 *
 * POST /api/auth/verify-pin
 * Headers: Authorization: Bearer <token>
 * Body: { pinHash: string }
 */
export async function verifyPin(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { pinHash } = req.body;

    if (!pinHash || typeof pinHash !== 'string') {
      validationError(res, '缺少PIN码哈希值');
      return;
    }

    // 检查是否被锁定
    const failureRecord = pinFailureCount.get(userId);
    if (failureRecord && Date.now() < failureRecord.lockUntil) {
      const remainMinutes = Math.ceil((failureRecord.lockUntil - Date.now()) / 60000);
      error(res, `PIN码验证失败次数过多，请${remainMinutes}分钟后再试`, 429);
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.pinHash) {
      validationError(res, '请先设置PIN码');
      return;
    }

    if (pinHash !== user.pinHash) {
      const current = pinFailureCount.get(userId) || { count: 0, lockUntil: 0 };
      current.count++;
      if (current.count >= PIN_MAX_FAILURES) {
        current.lockUntil = Date.now() + PIN_LOCK_DURATION_MS;
        current.count = 0;
      }
      pinFailureCount.set(userId, current);
      validationError(res, 'PIN码错误');
      return;
    }

    pinFailureCount.delete(userId);
    success(res, { salt: user.pinSalt }, 'PIN码验证成功');
  } catch (err) {
    console.error('[verifyPin]', err);
    error(res, 'PIN码验证失败');
  }
}

/**
 * 重置PIN码（危险操作，会清除所有日记）
 *
 * POST /api/auth/reset-pin
 * Headers: Authorization: Bearer <token>
 * Body: { password: string, newPinHash: string, newSalt: string }
 */
export async function resetPin(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { password, newPinHash, newSalt } = req.body;

    // 验证当前登录密码（替代原来的短信验证）
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.passwordHash) {
      error(res, '用户不存在', 404);
      return;
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash as string);
    if (!isMatch) {
      validationError(res, '密码错误，无法重置PIN码');
      return;
    }

    if (!newPinHash || typeof newPinHash !== 'string' || newPinHash.length > 128) {
      validationError(res, '缺少新PIN码哈希值或格式错误');
      return;
    }

    if (!newSalt || typeof newSalt !== 'string' || newSalt.length > 64) {
      validationError(res, '缺少新盐值或格式错误');
      return;
    }

    // 使用事务确保原子性
    await prisma.$transaction(async (tx) => {
      await tx.diary.deleteMany({ where: { userId } });
      await tx.user.update({
        where: { id: userId },
        data: { pinHash: newPinHash, pinSalt: newSalt },
      });
    });

    pinFailureCount.delete(userId);
    success(res, null, 'PIN码已重置，历史日记数据已清除');
  } catch (err) {
    console.error('[resetPin]', err);
    error(res, 'PIN码重置失败');
  }
}

/**
 * 获取当前登录用户信息
 *
 * GET /api/auth/me
 * Headers: Authorization: Bearer <token>
 */
export async function getMe(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        username: true,
        nickname: true,
        avatar: true,
        pinHash: true,
        pinSalt: true,
        streakDays: true,
        lastCheckinAt: true,
        createdAt: true,
      },
    });

    if (!user) {
      error(res, '用户不存在', 404);
      return;
    }

    success(res, {
      id: user.id,
      phone: user.phone,
      username: user.username,
      nickname: user.nickname,
      avatar: user.avatar,
      hasPinSet: !!user.pinHash,
      salt: user.pinSalt,
      streakDays: user.streakDays,
      lastCheckinAt: user.lastCheckinAt,
      createdAt: user.createdAt,
    });
  } catch (err) {
    console.error('[getMe]', err);
    error(res, '获取用户信息失败');
  }
}
