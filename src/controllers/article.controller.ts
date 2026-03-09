import { Request, Response } from 'express';
import prisma from '../config/database';
import { success, error, validationError, notFound } from '../utils/response';

/**
 * 获取文章列表（用户端）
 * GET /api/articles
 */
export async function getArticles(req: Request, res: Response): Promise<void> {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const skip = (page - 1) * pageSize;

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
        },
        orderBy: { chapter: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.article.count({ where: { status: 'published' } }),
    ]);

    success(res, {
      list: articles,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (err) {
    console.error('[getArticles]', err);
    error(res, '获取文章列表失败');
  }
}

/**
 * 获取文章详情（用户端）
 * GET /api/articles/:id
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

    // 增加阅读量
    await prisma.article.update({
      where: { id },
      data: { viewCount: { increment: 1 } },
    });

    // 获取上一章和下一章
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

    // 解析quotes JSON字符串
    let quotes: string[] = [];
    try {
      quotes = article.quotes ? JSON.parse(article.quotes) : [];
    } catch (e) {
      quotes = [];
    }

    success(res, {
      ...article,
      quotes,
      viewCount: article.viewCount + 1,
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
 * GET /api/admin/articles
 */
export async function adminGetArticles(req: Request, res: Response): Promise<void> {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
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
 * POST /api/admin/articles
 */
export async function adminCreateArticle(req: Request, res: Response): Promise<void> {
  try {
    const { title, summary, content, chapter, status: articleStatus, quotes } = req.body;

    if (!title || !content || chapter === undefined) {
      validationError(res, '标题、内容和章节号为必填项');
      return;
    }

    // 检查章节号是否重复
    const existing = await prisma.article.findFirst({ where: { chapter } });
    if (existing) {
      validationError(res, `第${chapter}章已存在`);
      return;
    }

    const article = await prisma.article.create({
      data: {
        title,
        summary: summary || '',
        content,
        chapter,
        status: articleStatus || 'draft',
        publishedAt: articleStatus === 'published' ? new Date() : null,
        quotes: quotes ? JSON.stringify(quotes) : null,
      },
    });

    success(res, article, '文章创建成功', 201);
  } catch (err) {
    console.error('[adminCreateArticle]', err);
    error(res, '创建文章失败');
  }
}

/**
 * 更新文章（管理后台）
 * PUT /api/admin/articles/:id
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

    // 如果修改了章节号，检查是否重复
    if (chapter !== undefined && chapter !== existing.chapter) {
      const duplicate = await prisma.article.findFirst({ where: { chapter } });
      if (duplicate) {
        validationError(res, `第${chapter}章已存在`);
        return;
      }
    }

    const updateData: any = {};
    if (title !== undefined) updateData.title = title;
    if (summary !== undefined) updateData.summary = summary;
    if (content !== undefined) updateData.content = content;
    if (chapter !== undefined) updateData.chapter = chapter;
    if (quotes !== undefined) updateData.quotes = JSON.stringify(quotes);
    if (articleStatus !== undefined) {
      updateData.status = articleStatus;
      if (articleStatus === 'published' && !existing.publishedAt) {
        updateData.publishedAt = new Date();
      }
    }

    const article = await prisma.article.update({
      where: { id },
      data: updateData,
    });

    success(res, article, '文章更新成功');
  } catch (err) {
    console.error('[adminUpdateArticle]', err);
    error(res, '更新文章失败');
  }
}

/**
 * 删除文章（管理后台）
 * DELETE /api/admin/articles/:id
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

    success(res, null, '文章已删除');
  } catch (err) {
    console.error('[adminDeleteArticle]', err);
    error(res, '删除文章失败');
  }
}
