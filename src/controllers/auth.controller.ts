import { Request, Response } from 'express';
import prisma from '../config/database';
import { sendVerificationCode, verifyCode } from '../services/sms.service';
import { generateToken } from '../utils/jwt';
import { getClientIp, resolveIpRegion } from '../utils/ip';
import { success, error, validationError } from '../utils/response';
// bcrypt不再需要 - PIN码hash在前端完成，服务器只存储hash值

/**
 * 发送验证码
 * POST /api/auth/send-code
 */
export async function sendCode(req: Request, res: Response): Promise<void> {
  try {
    const { phone } = req.body;

    if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
      validationError(res, '请输入正确的手机号');
      return;
    }

    const result = await sendVerificationCode(phone);

    if (!result.success) {
      error(res, result.message, 429);
      return;
    }

    // 开发模式下返回验证码
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
 * 登录/注册
 * POST /api/auth/login
 */
export async function login(req: Request, res: Response): Promise<void> {
  try {
    const { phone, code } = req.body;

    if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
      validationError(res, '请输入正确的手机号');
      return;
    }

    if (!code || code.length !== 6) {
      validationError(res, '请输入6位验证码');
      return;
    }

    // 验证验证码
    const isValid = verifyCode(phone, code);
    if (!isValid) {
      validationError(res, '验证码错误或已过期');
      return;
    }

    // 获取客户端IP
    const clientIp = getClientIp(req);
    const ipRegion = await resolveIpRegion(clientIp);

    // 查找或创建用户
    let user = await prisma.user.findUnique({ where: { phone } });
    let isNewUser = false;

    if (!user) {
      // 新用户注册
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
      // 更新登录信息
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          lastLoginAt: new Date(),
          lastLoginIp: clientIp,
          ipRegion,
        },
      });
    }

    // 生成Token
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
 * 设置PIN码
 * POST /api/auth/set-pin
 */
export async function setPin(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { pinHash, salt } = req.body;

    if (!pinHash) {
      validationError(res, '缺少PIN码哈希值');
      return;
    }

    if (!salt) {
      validationError(res, '缺少加密盐值');
      return;
    }

    // 存储前端传来的pinHash和salt
    // PIN码明文永远不会发送到服务器
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
 * POST /api/auth/verify-pin
 */
export async function verifyPin(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { pinHash } = req.body;

    if (!pinHash) {
      validationError(res, '缺少PIN码哈希值');
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.pinHash) {
      validationError(res, '请先设置PIN码');
      return;
    }

    // 比较前端发来的hash与存储的hash是否一致
    if (pinHash !== user.pinHash) {
      validationError(res, 'PIN码错误');
      return;
    }

    success(res, { salt: user.pinSalt }, 'PIN码验证成功');
  } catch (err) {
    console.error('[verifyPin]', err);
    error(res, 'PIN码验证失败');
  }
}

/**
 * 重置PIN码（清除所有日记数据）
 * POST /api/auth/reset-pin
 */
export async function resetPin(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { phone, code, newPinHash, newSalt } = req.body;

    // 验证手机号
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.phone !== phone) {
      validationError(res, '手机号不匹配');
      return;
    }

    // 验证验证码
    const isValid = verifyCode(phone, code);
    if (!isValid) {
      validationError(res, '验证码错误或已过期');
      return;
    }

    if (!newPinHash || !newSalt) {
      validationError(res, '缺少新PIN码哈希值或盐值');
      return;
    }

    // 删除所有日记数据
    await prisma.diary.deleteMany({ where: { userId } });

    // 重置PIN码
    await prisma.user.update({
      where: { id: userId },
      data: { pinHash: newPinHash, pinSalt: newSalt },
    });

    success(res, null, 'PIN码已重置，历史日记数据已清除');
  } catch (err) {
    console.error('[resetPin]', err);
    error(res, 'PIN码重置失败');
  }
}

/**
 * 获取当前用户信息
 * GET /api/auth/me
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
