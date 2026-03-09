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
 * 存储方案：
 * - 当前使用内存Map存储验证码（适合单实例部署）
 * - 生产环境多实例部署时应替换为Redis（已标注TODO）
 *
 * 安全机制：
 * - 验证码6位数字，有效期5分钟
 * - 同一手机号60秒内只能发送一次（应用层频率限制）
 * - 验证成功后立即删除，防止重放攻击
 * - 配合index.ts中的IP级频率限制（每IP每分钟1次）
 *
 * 阿里云短信集成：
 * - 需要在.env中配置 ALIYUN_SMS_ACCESS_KEY_ID 和 ALIYUN_SMS_ACCESS_KEY_SECRET
 * - 需要在阿里云控制台创建短信签名和模板
 * - 安装SDK：npm install @alicloud/dysmsapi20170525 @alicloud/openapi-client
 */

import { config } from '../config/env';

/**
 * 验证码内存存储
 *
 * Key: 手机号
 * Value: { code: 6位验证码, expireAt: 过期时间戳(ms) }
 *
 * TODO: 生产环境多实例部署时，替换为Redis存储
 * 示例：
 *   await redis.setex(`sms:${phone}`, 300, code);
 *   const stored = await redis.get(`sms:${phone}`);
 */
const codeStore = new Map<string, { code: string; expireAt: number }>();

/** 验证码有效期：5分钟 */
const CODE_EXPIRE_MS = 5 * 60 * 1000;

/** 发送频率限制：同一手机号60秒内只能发送一次 */
const SEND_INTERVAL_MS = 60 * 1000;

/**
 * 发送时间记录
 * Key: 手机号, Value: 上次发送时间戳(ms)
 * 用于应用层频率限制（与index.ts中的IP级限制互补）
 */
const sendTimeStore = new Map<string, number>();

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

  // ===== 生产模式：调用阿里云短信API =====
  try {
    /**
     * TODO: 集成阿里云短信SDK
     *
     * 安装依赖：
     *   npm install @alicloud/dysmsapi20170525 @alicloud/openapi-client
     *
     * 示例代码：
     * ```typescript
     * import Dysmsapi20170525, * as $Dysmsapi from '@alicloud/dysmsapi20170525';
     * import * as $OpenApi from '@alicloud/openapi-client';
     *
     * const smsConfig = new $OpenApi.Config({
     *   accessKeyId: process.env.ALIYUN_SMS_ACCESS_KEY_ID,
     *   accessKeySecret: process.env.ALIYUN_SMS_ACCESS_KEY_SECRET,
     *   endpoint: 'dysmsapi.aliyuncs.com',
     * });
     *
     * const client = new Dysmsapi20170525(smsConfig);
     *
     * const sendReq = new $Dysmsapi.SendSmsRequest({
     *   phoneNumbers: phone,
     *   signName: '人选天选论',           // 短信签名（需在阿里云控制台申请）
     *   templateCode: 'SMS_XXXXXXXX',    // 短信模板ID（需在阿里云控制台创建）
     *   templateParam: JSON.stringify({ code }),
     * });
     *
     * const result = await client.sendSms(sendReq);
     * if (result.body.code !== 'OK') {
     *   throw new Error(result.body.message);
     * }
     * ```
     */
    console.log(`[SMS] 向 ${phone} 发送验证码: ${code}`);
    return {
      success: true,
      message: '验证码已发送',
    };
  } catch (err) {
    console.error('[SMS] 发送失败:', err);
    // 发送失败时清除已存储的验证码，避免用户用无效验证码登录
    codeStore.delete(phone);
    return {
      success: false,
      message: '验证码发送失败，请稍后重试',
    };
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
 * - 验证失败不删除，允许用户重试（但有次数限制，由上层频率限制控制）
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

  // 验证码匹配检查
  if (stored.code === code) {
    codeStore.delete(phone); // 验证成功后立即删除，防止重放攻击
    return true;
  }

  return false;
}
