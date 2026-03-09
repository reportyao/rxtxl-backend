/**
 * ===================================================================
 * 环境变量配置 (Environment Configuration)
 * ===================================================================
 *
 * 集中管理所有环境变量，提供类型安全的配置访问。
 * 所有配置项都有默认值，确保开发环境无需额外配置即可运行。
 *
 * 环境变量来源：
 * 1. .env 文件（dotenv加载，适合本地开发）
 * 2. 系统环境变量（适合生产环境，如Docker/PM2）
 * 3. 默认值（代码中的fallback）
 *
 * 生产环境必须配置的变量：
 * - JWT_SECRET: 必须使用强随机字符串（至少32位）
 * - ADMIN_PASSWORD: 管理后台密码
 * - ALIYUN_ACCESS_KEY_ID/SECRET: 阿里云短信服务
 * - CORS_ORIGIN: 前端域名白名单
 * - DATABASE_URL: MySQL连接字符串（在.env或环境变量中设置）
 */

import dotenv from 'dotenv';
dotenv.config();

export const config = {
  /** 服务器监听端口 */
  port: parseInt(process.env.PORT || '3000', 10),

  /** 运行环境：development / production */
  nodeEnv: process.env.NODE_ENV || 'development',

  /** 是否为开发环境（快捷判断） */
  isDev: process.env.NODE_ENV === 'development',

  // ===== JWT认证配置 =====
  /**
   * JWT签名密钥
   * 生产环境必须替换为强随机字符串！
   * 生成方式：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   */
  jwtSecret: process.env.JWT_SECRET || 'default_secret',

  /**
   * JWT过期时间
   * 格式：数字+单位（s/m/h/d），如 '30d' = 30天
   * 用户30天内不需要重新登录
   */
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',

  // ===== 阿里云短信服务配置 =====
  aliyun: {
    /** 阿里云AccessKey ID */
    accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID || '',
    /** 阿里云AccessKey Secret */
    accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET || '',
    /** 短信签名名称（需在阿里云控制台申请） */
    smsSignName: process.env.ALIYUN_SMS_SIGN_NAME || '',
    /** 短信模板Code（需在阿里云控制台申请） */
    smsTemplateCode: process.env.ALIYUN_SMS_TEMPLATE_CODE || '',
  },

  // ===== 管理后台认证 =====
  admin: {
    /** 管理后台用户名 */
    username: process.env.ADMIN_USERNAME || 'admin',
    /**
     * 管理后台密码
     * 生产环境必须修改！使用Basic Auth认证
     */
    password: process.env.ADMIN_PASSWORD || 'admin123456',
  },

  // ===== CORS跨域配置 =====
  /**
   * 允许的前端域名
   * - 开发环境：'*'（允许所有）
   * - 生产环境：逗号分隔的域名列表
   *   如：'https://rxtxl.example.com,https://m.rxtxl.example.com'
   */
  corsOrigin: process.env.CORS_ORIGIN || '*',
};
