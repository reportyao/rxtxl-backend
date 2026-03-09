import jwt, { SignOptions } from 'jsonwebtoken';
import type { StringValue } from 'ms';
import { config } from '../config/env';

export interface JwtPayload {
  userId: string;
  phone: string;
}

/**
 * 生成JWT Token
 */
export function generateToken(payload: JwtPayload): string {
  const options: SignOptions = {
    expiresIn: config.jwtExpiresIn as StringValue,
  };
  return jwt.sign(payload as object, config.jwtSecret, options);
}

/**
 * 验证JWT Token
 */
export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, config.jwtSecret) as JwtPayload;
}
