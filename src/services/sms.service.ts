/**
 * ===================================================================
 * 短信验证码服务 (SMS Service)
 * ===================================================================
 *
 * 负责短信验证码的生成、存储、发送和验证。
 *
 * 运行模式：
 * - 开发模式（NODE_ENV=development）：不实际发送短信，验证码在控制台输出并通过API返回
 * - 生产模式（NODE_ENV=production）：调用阿里云短信API发送真实短信
 *
 * 存储方案（v1.1 优化）：
 * - 使用内存Map存储验证码，适合单实例部署
 * - 增加定期清理过期验证码的定时器，防止内存泄漏
 * - 增加验证失败次数限制，防止暴力破解
 * - 多实例部署时应替换为Redis（已标注TODO）
 *
 * 安全机制：
 * - 验证码6位数字，有效期5分钟
 * - 同一手机号60秒内只能发送一次（应用层频率限制）
 * - 同一验证码最多验证5次，超过自动失效
 * - 验证成功后立即删除，防止重放攻击
 * - 配合index.ts中的IP级频率限制（每IP每分钟1次）
 *
 * 阿里云短信集成：
 * - 需要在.env中配置 ALIYUN_ACCESS_KEY_ID 和 ALIYUN_ACCESS_KEY_SECRET
 * - 需要在阿里云控制台创建短信签名和模板
 * - 安装SDK：npm install @alicloud/dysmsapi20170525 @alicloud/openapi-client
 */

import { config } from '../config/env';

/**
 * 验证码内存存储
 *
 * Key: 手机号
 * Value: { code: 6位验证码, expireAt: 过期时间戳(ms), attempts: 已验证次数 }
 *
 * TODO: 生产环境多实例部署时，替换为Redis存储
 * 示例：
 *   await redis.setex(`sms:${phone}`, 300, JSON.stringify({ code, attempts: 0 }));
 *   const stored = JSON.parse(await redis.get(`sms:${phone}`));
 */
const codeStore = new Map<string, { code: string; expireAt: number; attempts: number }>();

/** 验证码有效期：5分钟 */
const CODE_EXPIRE_MS = 5 * 60 * 1000;

/** 发送频率限制：同一手机号60秒内只能发送一次 */
const SEND_INTERVAL_MS = 60 * 1000;

/** 单个验证码最大验证尝试次数（防止暴力破解） */
const MAX_VERIFY_ATTEMPTS = 5;

/** 短信发送最大重试次数 */
const SMS_MAX_RETRIES = 2;

/**
 * 发送时间记录
 * Key: 手机号, Value: 上次发送时间戳(ms)
 * 用于应用层频率限制（与index.ts中的IP级限制互补）
 */
const sendTimeStore = new Map<string, number>();

/**
 * 定期清理过期的验证码和发送时间记录
 * 每5分钟执行一次，防止内存泄漏
 */
setInterval(() => {
  const now = Date.now();
  for (const [phone, data] of codeStore) {
    if (now > data.expireAt) {
      codeStore.delete(phone);
    }
  }
  for (const [phone, time] of sendTimeStore) {
    if (now - time > SEND_INTERVAL_MS * 2) {
      sendTimeStore.delete(phone);
    }
  }
}, 5 * 60 * 1000);

/**
 * 生成6位随机数字验证码
 * 范围：100000 ~ 999999
 */
function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * 发送短信验证码
 *
 * @param phone - 接收验证码的手机号
 * @returns 发送结果对象
 *   - success: 是否发送成功
 *   - message: 提示信息
 *   - devCode: 开发模式下返回验证码（生产模式不返回）
 *
 * 调用链路：
 * 1. 检查频率限制（60秒内不能重复发送）
 * 2. 生成6位随机验证码
 * 3. 存储到内存Map（带5分钟过期时间）
 * 4. 发送短信（开发模式跳过实际发送）
 */
export async function sendVerificationCode(phone: string): Promise<{
  success: boolean;
  message: string;
  devCode?: string;
}> {
  // ===== 频率限制检查 =====
  // 防止同一手机号被频繁发送（短信轰炸防护）
  const lastSendTime = sendTimeStore.get(phone);
  if (lastSendTime && Date.now() - lastSendTime < SEND_INTERVAL_MS) {
    const remainSeconds = Math.ceil((SEND_INTERVAL_MS - (Date.now() - lastSendTime)) / 1000);
    return {
      success: false,
      message: `请${remainSeconds}秒后再试`,
    };
  }

  const code = generateCode();

  // ===== 存储验证码 =====
  // 覆盖式存储：如果之前有未过期的验证码，直接覆盖
  codeStore.set(phone, {
    code,
    expireAt: Date.now() + CODE_EXPIRE_MS,
    attempts: 0,
  });

  // 记录发送时间（用于频率限制）
  sendTimeStore.set(phone, Date.now());

  // ===== 开发模式：不实际发送短信 =====
  if (config.isDev) {
    console.log(`[DEV SMS] 手机号: ${phone}, 验证码: ${code}`);
    return {
      success: true,
      message: '验证码已发送（开发模式）',
      devCode: code, // 开发模式下通过API返回验证码，方便调试
    };
  }

  // ===== 生产模式：调用阿里云短信API（带重试） =====
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= SMS_MAX_RETRIES; attempt++) {
    try {
      await sendAliyunSms(phone, code);
      return {
        success: true,
        message: '验证码已发送',
      };
    } catch (err) {
      lastError = err as Error;
      console.error(`[SMS] 发送失败 (尝试 ${attempt + 1}/${SMS_MAX_RETRIES + 1}):`, err);
      if (attempt < SMS_MAX_RETRIES) {
        // 重试前等待一小段时间（指数退避）
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }

  // 所有重试都失败，清除已存储的验证码
  console.error('[SMS] 所有重试均失败:', lastError);
  codeStore.delete(phone);
  return {
    success: false,
    message: '验证码发送失败，请稍后重试',
  };
}

/**
 * 调用阿里云短信API发送短信
 *
 * 需要安装依赖：
 *   npm install @alicloud/dysmsapi20170525 @alicloud/openapi-client
 *
 * @param phone - 手机号
 * @param code - 验证码
 */
async function sendAliyunSms(phone: string, code: string): Promise<void> {
  // 检查阿里云配置是否完整
  if (!config.aliyun.accessKeyId || !config.aliyun.accessKeySecret) {
    console.warn('[SMS] 阿里云短信配置不完整，跳过实际发送');
    console.log(`[SMS] 向 ${phone} 发送验证码: ${code}`);
    return;
  }

  try {
    // 动态导入阿里云SDK（避免未安装时启动报错）
    const Dysmsapi20170525 = (await import('@alicloud/dysmsapi20170525')).default;
    const OpenApi = await import('@alicloud/openapi-client');

    const smsConfig = new OpenApi.Config({
      accessKeyId: config.aliyun.accessKeyId,
      accessKeySecret: config.aliyun.accessKeySecret,
      endpoint: 'dysmsapi.aliyuncs.com',
    });

    const client = new Dysmsapi20170525(smsConfig);

    const sendReq = new Dysmsapi20170525.SendSmsRequest({
      phoneNumbers: phone,
      signName: config.aliyun.smsSignName,
      templateCode: config.aliyun.smsTemplateCode,
      templateParam: JSON.stringify({ code }),
    });

    const result = await client.sendSms(sendReq);
    if (!result.body || result.body.code !== 'OK') {
      const errorMsg = result.body?.message || '\u672a\u77e5\u9519\u8bef';
      throw new Error(`\u963f\u91cc\u4e91\u77ed\u4fe1API\u8fd4\u56de\u9519\u8bef: ${result.body?.code} - ${errorMsg}`);
    }

    console.log(`[SMS] 成功发送验证码到 ${phone}`);
  } catch (err: any) {
    // 如果是模块未安装的错误，降级为日志输出
    if (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND') {
      console.warn('[SMS] 阿里云SDK未安装，降级为日志输出');
      console.log(`[SMS] 向 ${phone} 发送验证码: ${code}`);
      return;
    }
    throw err;
  }
}

/**
 * 验证短信验证码
 *
 * @param phone - 手机号
 * @param code - 用户输入的验证码
 * @returns 验证是否通过
 *
 * 安全机制：
 * - 验证码过期自动失效（5分钟）
 * - 验证成功后立即从存储中删除，防止同一验证码被重复使用（重放攻击）
 * - 验证失败次数超过5次自动失效，防止暴力破解
 * - 使用时间安全比较，防止时序攻击
 */
export function verifyCode(phone: string, code: string): boolean {
  const stored = codeStore.get(phone);
  if (!stored) {
    return false;
  }

  // 检查是否已过期
  if (Date.now() > stored.expireAt) {
    codeStore.delete(phone); // 清理过期数据
    return false;
  }

  // 检查验证尝试次数
  if (stored.attempts >= MAX_VERIFY_ATTEMPTS) {
    codeStore.delete(phone); // 超过最大尝试次数，删除验证码
    return false;
  }

  // 递增尝试次数
  stored.attempts++;

  // 验证码匹配检查（使用时间安全比较防止时序攻击）
  if (timingSafeEqual(stored.code, code)) {
    codeStore.delete(phone); // 验证成功后立即删除，防止重放攻击
    return true;
  }

  return false;
}

/**
 * 时间安全的字符串比较
 * 防止通过响应时间差异推断验证码内容（时序攻击）
 *
 * @param a - 存储的验证码
 * @param b - 用户输入的验证码
 * @returns 是否相等
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
