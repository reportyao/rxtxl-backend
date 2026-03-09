import { Router } from 'express';
import { createDiary, getDiaries, getDiaryDetail, getCheckins, getStones, deleteDiary } from '../controllers/diary.controller';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// 所有日记接口都需要认证
router.use(authMiddleware);

router.post('/', createDiary);
router.get('/', getDiaries);
router.get('/checkins', getCheckins);
router.get('/stones', getStones);
router.get('/:id', getDiaryDetail);
router.delete('/:id', deleteDiary);

export default router;
