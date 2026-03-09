import { config } from '../config/env';

// 验证码存储（生产环境应使用Redis）
const codeStore = new Map<string, { code: string; expireAt: number }>();

// 验证码有效期（5分钟）
const CODE_EXPIRE_MS = 5 * 60 * 1000;

// 发送频率限制（60秒）
const SEND_INTERVAL_MS = 60 * 1000;
const sendTimeStore = new Map<string, number>();

/**
 * 生成6位随机验证码
 */
function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * 发送短信验证码
 * 开发环境下不实际发送，直接返回验证码
 */
export async function sendVerificationCode(phone: string): Promise<{ success: boolean; message: string; devCode?: string }> {
  // 频率限制检查
  const lastSendTime = sendTimeStore.get(phone);
  if (lastSendTime && Date.now() - lastSendTime < SEND_INTERVAL_MS) {
    const remainSeconds = Math.ceil((SEND_INTERVAL_MS - (Date.now() - lastSendTime)) / 1000);
    return {
      success: false,
      message: `请${remainSeconds}秒后再试`,
    };
  }

  const code = generateCode();

  // 存储验证码
  codeStore.set(phone, {
    code,
    expireAt: Date.now() + CODE_EXPIRE_MS,
  });

  // 记录发送时间
  sendTimeStore.set(phone, Date.now());

  // 开发环境：直接返回验证码，不实际发送短信
  if (config.isDev) {
    console.log(`[DEV SMS] 手机号: ${phone}, 验证码: ${code}`);
    return {
      success: true,
      message: '验证码已发送（开发模式）',
      devCode: code,
    };
  }

  // 生产环境：调用阿里云短信API
  try {
    // TODO: 集成阿里云短信SDK
    // const client = new SmsClient({...});
    // await client.sendSms({...});
    console.log(`[SMS] 向 ${phone} 发送验证码: ${code}`);
    return {
      success: true,
      message: '验证码已发送',
    };
  } catch (err) {
    console.error('[SMS] 发送失败:', err);
    return {
      success: false,
      message: '验证码发送失败，请稍后重试',
    };
  }
}

/**
 * 验证短信验证码
 */
export function verifyCode(phone: string, code: string): boolean {
  const stored = codeStore.get(phone);
  if (!stored) {
    return false;
  }

  // 检查是否过期
  if (Date.now() > stored.expireAt) {
    codeStore.delete(phone);
    return false;
  }

  // 验证码匹配
  if (stored.code === code) {
    codeStore.delete(phone); // 验证成功后删除
    return true;
  }

  return false;
}
