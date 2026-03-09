/**
 * ===================================================================
 * 数据库配置 (Database Configuration)
 * ===================================================================
 *
 * 使用Prisma ORM管理数据库连接。
 *
 * 性能优化策略：
 * 1. 单例模式：全局只创建一个PrismaClient实例，避免连接池泄漏
 * 2. 连接池：Prisma默认使用连接池（MySQL默认5个连接），
 *    可通过DATABASE_URL参数调整：?connection_limit=10&pool_timeout=20
 * 3. 查询日志：开发环境输出SQL查询日志，生产环境只输出错误
 * 4. 优雅关闭：进程退出时正确断开数据库连接，防止连接泄漏
 *
 * 生产环境连接池建议：
 * - 轻量云服务器（1核2G）：connection_limit=5
 * - 标准服务器（2核4G）：connection_limit=10
 * - 高配服务器（4核8G）：connection_limit=20
 *
 * MySQL连接URL示例：
 * mysql://user:password@host:3306/rxtxl?connection_limit=10&pool_timeout=20
 *
 * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-prismaclient/connection-pool
 */

import { PrismaClient } from '@prisma/client';

/**
 * 全局PrismaClient单例
 *
 * 为什么用单例？
 * - 每个PrismaClient实例会创建自己的连接池
 * - 如果在每次请求中创建新实例，会导致连接池耗尽
 * - 在开发环境中，热重载可能导致多个实例，通过global缓存避免
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const prisma = globalForPrisma.prisma ?? new PrismaClient({
  /**
   * 查询日志配置
   * - 开发环境：输出query（SQL语句）+ error + warn
   * - 生产环境：只输出error，减少日志量
   */
  log: process.env.NODE_ENV === 'development'
    ? ['query', 'error', 'warn']
    : ['error'],
});

// 开发环境缓存实例，避免热重载时创建多个连接池
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * 优雅关闭数据库连接
 *
 * 当进程收到终止信号时（Ctrl+C、kill、PM2 restart等），
 * 先断开数据库连接，再退出进程。
 * 防止连接泄漏和未完成的事务。
 */
const gracefulShutdown = async (signal: string) => {
  console.log(`\n[Database] Received ${signal}. Disconnecting Prisma...`);
  await prisma.$disconnect();
  console.log('[Database] Prisma disconnected. Exiting.');
  process.exit(0);
};

// 监听进程终止信号
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

export default prisma;
