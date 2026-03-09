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
 * 安全设计要点：
 * - PIN码明文永远不会发送到服务器（前端用SHA-256+salt生成hash后发送）
 * - 日记加密密钥由前端通过PBKDF2从PIN派生，服务器无法获取
 * - 登录时记录IP并解析归属地，用于管理后台数据分析
 */

import { Request, Response } from 'express';
import prisma from '../config/database';
import { sendVerificationCode, verifyCode } from '../services/sms.service';
import { generateToken } from '../utils/jwt';
import { getClientIp, resolveIpRegion } from '../utils/ip';
import { success, error, validationError } from '../utils/response';

/**
 * 发送短信验证码
 *
 * POST /api/auth/send-code
 * Body: { phone: string }
 *
 * 流程：
 * 1. 校验手机号格式（中国大陆11位手机号）
 * 2. 调用短信服务发送6位数字验证码
 * 3. 验证码有效期5分钟，存储在内存Map中
 *
 * 频率限制：每个IP每分钟最多1次（在index.ts中配置）
 * 开发模式：不实际发送短信，验证码会在响应中返回（devCode字段）
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
 *
 * 流程：
 * 1. 校验手机号和验证码格式
 * 2. 验证短信验证码是否正确且未过期
 * 3. 获取客户端真实IP并解析归属地
 * 4. 查找用户：存在则更新登录信息，不存在则自动创建新用户
 * 5. 生成JWT Token返回给前端
 *
 * 返回数据：
 * - token: JWT令牌，有效期7天
 * - user: 用户基本信息（含hasPinSet标记，前端据此决定是否跳转PIN设置页）
 * - isNewUser: 是否新注册用户（前端据此决定是否显示引导）
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

    // 验证短信验证码（验证后自动从内存中删除，防止重放攻击）
    const isValid = verifyCode(phone, code);
    if (!isValid) {
      validationError(res, '验证码错误或已过期');
      return;
    }

    // 获取客户端真实IP（支持X-Forwarded-For代理头）
    const clientIp = getClientIp(req);
    // 异步解析IP归属地（调用ip-api.com免费接口）
    const ipRegion = await resolveIpRegion(clientIp);

    // 查找或创建用户（手机号作为唯一标识）
    let user = await prisma.user.findUnique({ where: { phone } });
    let isNewUser = false;

    if (!user) {
      // ===== 新用户注册 =====
      // 自动生成昵称：取手机号后4位
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
      // 更新最后登录时间和IP信息
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          lastLoginAt: new Date(),
          lastLoginIp: clientIp,
          ipRegion,
        },
      });
    }

    // 生成JWT Token（有效期在env.ts中配置，默认7天）
    const token = generateToken({ userId: user.id, phone: user.phone });

    success(res, {
      token,
      user: {
        id: user.id,
        phone: user.phone,
        nickname: user.nickname,
        avatar: user.avatar,
        hasPinSet: !!user.pinHash,  // 是否已设置日记加密PIN码
        streakDays: user.streakDays, // 当前连续打卡天数
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
 *
 * 安全设计：
 * - 前端生成随机salt → 用SHA-256(pin + salt)生成pinHash → 发送pinHash和salt到服务器
 * - 服务器只存储pinHash和salt，永远不接触PIN明文
 * - 同时，前端用PBKDF2(pin, salt, 100000次)派生AES-256密钥用于加密日记
 * - 这样即使数据库泄露，攻击者也无法：
 *   1. 知道用户的PIN码（只有hash）
 *   2. 解密用户的日记（需要PIN码才能派生AES密钥）
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
 * 使用场景：
 * - 用户查看历史日记时，需要先验证PIN码
 * - 前端用SHA-256(pin + salt)生成hash，发送到服务器比对
 * - 验证通过后返回salt，前端用salt+PIN派生AES密钥解密日记
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

    // 直接比较hash值（前端和服务器使用相同的hash算法）
    if (pinHash !== user.pinHash) {
      validationError(res, 'PIN码错误');
      return;
    }

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
 * 重要：由于端到端加密的特性，重置PIN码意味着：
 * - 旧的AES密钥无法恢复 → 所有历史日记永久无法解密
 * - 因此重置PIN码会同时删除所有历史日记数据
 * - 需要短信验证码二次确认，防止误操作
 *
 * 这个设计是故意的，与文章哲学一致——"改河道"的代价很大
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

    if (!newPinHash || !newSalt) {
      validationError(res, '缺少新PIN码哈希值或盐值');
      return;
    }

    // ===== 危险操作：删除所有历史日记 =====
    // 因为旧PIN码对应的AES密钥已无法恢复，旧日记密文永远无法解密
    await prisma.diary.deleteMany({ where: { userId } });

    // 更新为新的PIN码hash和salt
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
 * 获取当前登录用户信息
 *
 * GET /api/auth/me
 * Headers: Authorization: Bearer <token>
 *
 * 返回用户基本信息，前端用于：
 * - 判断是否已设置PIN码（hasPinSet）
 * - 获取salt用于派生加密密钥
 * - 展示个人中心信息
 * - 展示连续打卡天数
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
