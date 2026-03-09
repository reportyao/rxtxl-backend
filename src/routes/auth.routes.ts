import { Router } from 'express';
import { sendCode, login, setPin, verifyPin, resetPin, getMe } from '../controllers/auth.controller';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// 公开接口
router.post('/send-code', sendCode);
router.post('/login', login);

// 需要认证的接口
router.get('/me', authMiddleware, getMe);
router.post('/set-pin', authMiddleware, setPin);
router.post('/verify-pin', authMiddleware, verifyPin);
router.post('/reset-pin', authMiddleware, resetPin);

export default router;
