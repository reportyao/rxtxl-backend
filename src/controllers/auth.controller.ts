/**
 * ===================================================================
 * 用户认证控制器 (Auth Controller)
 * ===================================================================
 *
 * 负责用户认证相关的所有业务逻辑：
 * 1. 发送短信验证码（对接阿里云短信服务）
 * 2. 手机号+验证码 登录/注册（自动判断新老用户）
 * 3. 设置日记加密PIN码（服务器只存hash，不存明文）
 * 4. 验证PIN码（前端发hash，服务器比对hash）
 * 5. 重置PIN码（需短信二次验证，会清除所有历史日记）
 * 6. 获取当前用户信息
 *
 * v1.1 优化：
 * - [BUG FIX] resetPin使用事务确保删除日记和更新PIN的原子性
 * - [安全] PIN验证增加失败次数限制（防暴力破解）
 * - [安全] pinHash/salt增加格式校验
 */

import { Request, Response } from 'express';
import prisma from '../config/database';
import { sendVerificationCode, verifyCode } from '../services/sms.service';
import { generateToken } from '../utils/jwt';
import { getClientIp, resolveIpRegion } from '../utils/ip';
import { success, error, validationError } from '../utils/response';

/** PIN验证失败计数器（内存存储，防止暴力破解） */
const pinFailureCount = new Map<string, { count: number; lockUntil: number }>();
const PIN_MAX_FAILURES = 10;
const PIN_LOCK_DURATION_MS = 15 * 60 * 1000; // 锁定15分钟

/**
 * 发送短信验证码
 *
 * POST /api/auth/send-code
 * Body: { phone: string }
 */
export async function sendCode(req: Request, res: Response): Promise<void> {
  try {
    const { phone } = req.body;

    // 校验手机号格式：必须是1开头的11位数字
    if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
      validationError(res, '请输入正确的手机号');
      return;
    }

    const result = await sendVerificationCode(phone);

    if (!result.success) {
      error(res, result.message, 429);
      return;
    }

    // 开发模式下在响应中返回验证码，方便调试
    const responseData: any = { message: result.message };
    if (result.devCode) {
      responseData.devCode = result.devCode;
    }

    success(res, responseData, '验证码已发送');
  } catch (err) {
    console.error('[sendCode]', err);
    error(res, '发送验证码失败');
  }
}

/**
 * 用户登录/注册（合一接口）
 *
 * POST /api/auth/login
 * Body: { phone: string, code: string }
 */
export async function login(req: Request, res: Response): Promise<void> {
  try {
    const { phone, code } = req.body;

    if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
      validationError(res, '请输入正确的手机号');
      return;
    }

    if (!code || !/^\d{6}$/.test(code)) {
      validationError(res, '请输入6位数字验证码');
      return;
    }

    // 验证短信验证码（验证后自动从内存中删除，防止重放攻击）
    const isValid = verifyCode(phone, code);
    if (!isValid) {
      validationError(res, '验证码错误或已过期');
      return;
    }

    // 获取客户端真实IP（支持X-Forwarded-For代理头）
    const clientIp = getClientIp(req);
    // 异步解析IP归属地（不阻塞登录流程，失败时使用"未知"）
    const ipRegion = await resolveIpRegion(clientIp).catch(() => '未知');

    // 查找或创建用户（手机号作为唯一标识）
    let user = await prisma.user.findUnique({ where: { phone } });
    let isNewUser = false;

    if (!user) {
      // ===== 新用户注册 =====
      isNewUser = true;
      user = await prisma.user.create({
        data: {
          phone,
          nickname: `用户${phone.slice(-4)}`,
          lastLoginAt: new Date(),
          lastLoginIp: clientIp,
          ipRegion,
        },
      });
    } else {
      // ===== 老用户登录 =====
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          lastLoginAt: new Date(),
          lastLoginIp: clientIp,
          ipRegion,
        },
      });
    }

    // 生成JWT Token
    const token = generateToken({ userId: user.id, phone: user.phone });

    success(res, {
      token,
      user: {
        id: user.id,
        phone: user.phone,
        nickname: user.nickname,
        avatar: user.avatar,
        hasPinSet: !!user.pinHash,
        streakDays: user.streakDays,
      },
      isNewUser,
    }, isNewUser ? '注册成功' : '登录成功');
  } catch (err) {
    console.error('[login]', err);
    error(res, '登录失败');
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

    // 格式校验：pinHash应该是Base64编码的SHA-256哈希
    if (pinHash.length > 128) {
      validationError(res, 'PIN码哈希值格式错误');
      return;
    }

    if (salt.length > 64) {
      validationError(res, '盐值格式错误');
      return;
    }

    // 存储PIN码hash和salt到用户表
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
 *
 * [安全增强] 增加失败次数限制，超过10次锁定15分钟
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

    // 比较hash值
    if (pinHash !== user.pinHash) {
      // 记录失败次数
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

    // 验证成功，清除失败计数
    pinFailureCount.delete(userId);

    // 返回salt，前端用它来派生AES解密密钥
    success(res, { salt: user.pinSalt }, 'PIN码验证成功');
  } catch (err) {
    console.error('[verifyPin]', err);
    error(res, 'PIN码验证失败');
  }
}

/**
 * 重置PIN码（危险操作）
 *
 * POST /api/auth/reset-pin
 * Headers: Authorization: Bearer <token>
 * Body: { phone: string, code: string, newPinHash: string, newSalt: string }
 *
 * [BUG FIX] 使用事务确保删除日记和更新PIN的原子性
 * 原来的实现中，如果删除日记成功但更新PIN失败，会导致数据丢失但PIN未更新
 */
export async function resetPin(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { phone, code, newPinHash, newSalt } = req.body;

    // 验证手机号归属（防止篡改）
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.phone !== phone) {
      validationError(res, '手机号不匹配');
      return;
    }

    // 短信验证码二次确认
    const isValid = verifyCode(phone, code);
    if (!isValid) {
      validationError(res, '验证码错误或已过期');
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

    // ===== 使用事务确保原子性 =====
    await prisma.$transaction(async (tx) => {
      // 删除所有历史日记（旧密钥无法恢复，旧日记永远无法解密）
      await tx.diary.deleteMany({ where: { userId } });

      // 更新为新的PIN码hash和salt
      await tx.user.update({
        where: { id: userId },
        data: { pinHash: newPinHash, pinSalt: newSalt },
      });
    });

    // 清除PIN验证失败计数
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
