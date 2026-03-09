import { Router } from 'express';
import { adminGetArticles, adminCreateArticle, adminUpdateArticle, adminDeleteArticle } from '../controllers/article.controller';
import { getOverview, getUserTrend, getDiaryTrend, getStreakDistribution, getIpDistribution, getUsers } from '../controllers/dashboard.controller';
import { adminAuthMiddleware } from '../middleware/auth';

const router = Router();

// 所有管理后台接口都需要管理员认证
router.use(adminAuthMiddleware);

// 数据看板
router.get('/dashboard/overview', getOverview);
router.get('/dashboard/user-trend', getUserTrend);
router.get('/dashboard/diary-trend', getDiaryTrend);
router.get('/dashboard/streak-distribution', getStreakDistribution);
router.get('/dashboard/ip-distribution', getIpDistribution);

// 文章管理
router.get('/articles', adminGetArticles);
router.post('/articles', adminCreateArticle);
router.put('/articles/:id', adminUpdateArticle);
router.delete('/articles/:id', adminDeleteArticle);

// 用户管理
router.get('/users', getUsers);

export default router;
