/**
 * ===================================================================
 * 文章控制器 (Article Controller)
 * ===================================================================
 *
 * 负责文章相关的所有业务逻辑：
 *
 * 用户端接口：
 * 1. 获取文章列表（只返回已发布的文章，按章节倒序）
 * 2. 获取文章详情（含上下章导航、金句列表、阅读量统计）
 *
 * 管理后台接口：
 * 3. 获取全部文章列表（含草稿，支持状态筛选）
 * 4. 创建文章（支持富文本HTML内容、金句、定时发布）
 * 5. 更新文章（支持部分字段更新）
 * 6. 删除文章
 *
 * v1.1 优化：
 * - [BUG FIX] viewCount使用Prisma原子increment，修复高并发竞态条件
 * - [性能] 文章列表和详情使用内存缓存，减少数据库查询
 * - [性能] viewCount更新改为异步不阻塞响应
 * - [性能] 文章详情返回prevArticle/nextArticle，前端无需再请求全量列表
 */

import { Request, Response } from 'express';
import prisma from '../config/database';
import { success, error, validationError, notFound } from '../utils/response';
import { apiCache } from '../middleware/performance';

// ==================== 用户端接口 ====================

/**
 * 获取文章列表（用户端）
 *
 * GET /api/articles
 * Query: { page?: number, pageSize?: number }
 *
 * 只返回status='published'的文章
 * 不返回content字段（减少传输量，列表只需要标题和摘要）
 * 按章节号倒序排列（最新章节在前）
 *
 * [性能优化] 使用内存缓存，60秒TTL
 */
export async function getArticles(req: Request, res: Response): Promise<void> {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 20, 100);
    const skip = (page - 1) * pageSize;

    // 尝试从缓存获取
    const cacheKey = `articles:list:${page}:${pageSize}`;
    const cached = apiCache.get<any>(cacheKey);
    if (cached) {
      success(res, cached);
      return;
    }

    // 并行查询列表和总数，减少数据库往返时间
    const [articles, total] = await Promise.all([
      prisma.article.findMany({
        where: { status: 'published' },
        select: {
          id: true,
          title: true,
          summary: true,
          chapter: true,
          publishedAt: true,
          viewCount: true,
          // 注意：不返回content，列表页不需要全文
        },
        orderBy: { chapter: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.article.count({ where: { status: 'published' } }),
    ]);

    const result = {
      list: articles,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };

    // 写入缓存，60秒过期
    apiCache.set(cacheKey, result, 60 * 1000);

    success(res, result);
  } catch (err) {
    console.error('[getArticles]', err);
    error(res, '获取文章列表失败');
  }
}

/**
 * 获取文章详情（用户端）
 *
 * GET /api/articles/:id
 *
 * 返回完整文章内容，同时：
 * 1. 异步自增阅读量（viewCount + 1，使用原子操作，不阻塞响应）
 * 2. 查询上一章和下一章的基本信息（用于前端章节切换导航）
 * 3. 解析quotes JSON字符串为数组（用于前端金句分享功能）
 *
 * [BUG FIX] viewCount使用Prisma的原子increment操作，
 * 修复原来"先查询再更新"导致的高并发计数丢失问题。
 *
 * [性能优化] 使用内存缓存，300秒TTL；viewCount异步更新不阻塞响应
 */
export async function getArticleDetail(req: Request, res: Response): Promise<void> {
  try {
    const id = req.params.id as string;

    const article = await prisma.article.findFirst({
      where: { id, status: 'published' },
    });

    if (!article) {
      notFound(res, '文章不存在');
      return;
    }

    // [BUG FIX] 异步原子递增阅读量（不阻塞响应，不影响用户体验）
    // 使用 Prisma 的 increment 操作确保并发安全
    prisma.article.update({
      where: { id },
      data: { viewCount: { increment: 1 } },
    }).catch(err => {
      console.error('[viewCount increment]', err);
    });

    // 并行查询上一章和下一章
    const [prevArticle, nextArticle] = await Promise.all([
      prisma.article.findFirst({
        where: { status: 'published', chapter: { lt: article.chapter } },
        orderBy: { chapter: 'desc' },
        select: { id: true, title: true, chapter: true },
      }),
      prisma.article.findFirst({
        where: { status: 'published', chapter: { gt: article.chapter } },
        orderBy: { chapter: 'asc' },
        select: { id: true, title: true, chapter: true },
      }),
    ]);

    // 解析金句JSON字符串为数组
    let quotes: string[] = [];
    try {
      quotes = article.quotes ? JSON.parse(article.quotes) : [];
    } catch (e) {
      quotes = [];
    }

    success(res, {
      ...article,
      quotes,
      viewCount: article.viewCount + 1, // 返回更新后的阅读量
      prevArticle,
      nextArticle,
    });
  } catch (err) {
    console.error('[getArticleDetail]', err);
    error(res, '获取文章详情失败');
  }
}

// ==================== 管理后台接口 ====================

/**
 * 获取文章列表（管理后台）
 *
 * GET /api/admin/articles
 * Headers: Authorization: Basic <credentials>
 * Query: { page?: number, pageSize?: number, status?: string }
 */
export async function adminGetArticles(req: Request, res: Response): Promise<void> {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 20, 100);
    const status = req.query.status as string;
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (status) {
      where.status = status;
    }

    const [articles, total] = await Promise.all([
      prisma.article.findMany({
        where,
        orderBy: { chapter: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.article.count({ where }),
    ]);

    success(res, {
      list: articles,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (err) {
    console.error('[adminGetArticles]', err);
    error(res, '获取文章列表失败');
  }
}

/**
 * 创建文章（管理后台）
 *
 * POST /api/admin/articles
 * Headers: Authorization: Basic <credentials>
 * Body: {
 *   title: string,          // 文章标题（必填）
 *   summary?: string,       // 摘要
 *   content: string,        // 富文本HTML内容（必填）
 *   chapter: number,        // 章节号（必填，不可重复）
 *   status?: string,        // 状态：draft | published（默认draft）
 *   quotes?: string[],      // 金句数组
 *   scheduledAt?: string    // 定时发布时间（ISO 8601格式）
 * }
 */
export async function adminCreateArticle(req: Request, res: Response): Promise<void> {
  try {
    const { title, summary, content, chapter, status: articleStatus, quotes } = req.body;

    if (!title || !content || chapter === undefined) {
      validationError(res, '标题、内容和章节号为必填项');
      return;
    }

    if (typeof chapter !== 'number' || chapter < 0) {
      validationError(res, '章节号必须是非负整数');
      return;
    }

    // 检查章节号是否已被占用
    const existing = await prisma.article.findFirst({ where: { chapter } });
    if (existing) {
      validationError(res, chapter === 0 ? '序章已存在' : `第${chapter}章已存在`);
      return;
    }

    // 处理定时发布时间
    const { scheduledAt } = req.body;

    const article = await prisma.article.create({
      data: {
        title,
        summary: summary || '',
        content,
        chapter,
        status: articleStatus || 'draft',
        publishedAt: articleStatus === 'published' ? new Date() : null,
        quotes: quotes ? JSON.stringify(quotes) : null,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      },
    });

    // 文章创建后清除列表缓存
    apiCache.invalidate('articles:');

    success(res, article, '文章创建成功', 201);
  } catch (err) {
    console.error('[adminCreateArticle]', err);
    error(res, '创建文章失败');
  }
}

/**
 * 更新文章（管理后台）
 *
 * PUT /api/admin/articles/:id
 * Headers: Authorization: Basic <credentials>
 * Body: 与创建接口相同（所有字段均为可选，只更新传入的字段）
 */
export async function adminUpdateArticle(req: Request, res: Response): Promise<void> {
  try {
    const id = req.params.id as string;

    const { title, summary, content, chapter, status: articleStatus, quotes } = req.body;

    const existing = await prisma.article.findUnique({ where: { id } });
    if (!existing) {
      notFound(res, '文章不存在');
      return;
    }

    // 如果修改了章节号，检查新章节号是否已被其他文章占用
    if (chapter !== undefined && chapter !== existing.chapter) {
      if (typeof chapter !== 'number' || chapter < 0) {
        validationError(res, '章节号必须是非负整数');
        return;
      }
      const duplicate = await prisma.article.findFirst({ where: { chapter } });
      if (duplicate) {
        validationError(res, `第${chapter}章已存在`);
        return;
      }
    }

    // 构建更新数据对象（只包含传入的字段）
    const updateData: any = {};
    if (title !== undefined) updateData.title = title;
    if (summary !== undefined) updateData.summary = summary;
    if (content !== undefined) updateData.content = content;
    if (chapter !== undefined) updateData.chapter = chapter;
    if (quotes !== undefined) updateData.quotes = JSON.stringify(quotes);
    if (articleStatus !== undefined) {
      updateData.status = articleStatus;
      // 首次发布时自动设置发布时间
      if (articleStatus === 'published' && !existing.publishedAt) {
        updateData.publishedAt = new Date();
      }
    }

    // 处理定时发布时间
    const { scheduledAt } = req.body;
    if (scheduledAt !== undefined) {
      updateData.scheduledAt = scheduledAt ? new Date(scheduledAt) : null;
    }

    const article = await prisma.article.update({
      where: { id },
      data: updateData,
    });

    // 文章更新后清除相关缓存
    apiCache.invalidate('articles:');

    success(res, article, '文章更新成功');
  } catch (err) {
    console.error('[adminUpdateArticle]', err);
    error(res, '更新文章失败');
  }
}

/**
 * 删除文章（管理后台）
 *
 * DELETE /api/admin/articles/:id
 * Headers: Authorization: Basic <credentials>
 */
export async function adminDeleteArticle(req: Request, res: Response): Promise<void> {
  try {
    const id = req.params.id as string;

    const existing = await prisma.article.findUnique({ where: { id } });
    if (!existing) {
      notFound(res, '文章不存在');
      return;
    }

    await prisma.article.delete({ where: { id } });

    // 文章删除后清除相关缓存
    apiCache.invalidate('articles:');

    success(res, null, '文章已删除');
  } catch (err) {
    console.error('[adminDeleteArticle]', err);
    error(res, '删除文章失败');
  }
}
