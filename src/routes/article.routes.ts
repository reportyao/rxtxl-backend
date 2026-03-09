import { Router } from 'express';
import { getArticles, getArticleDetail } from '../controllers/article.controller';

const router = Router();

router.get('/', getArticles);
router.get('/:id', getArticleDetail);

export default router;
