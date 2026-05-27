import { logger } from './logger';
import { auditLog } from './audit';

export function chargeCard(userId: string, amount: number) {
  logger.info('chargeCard', { userId, amount });
  auditLog.emit({ userId, action: 'chargeCard', timestamp: Date.now(), resourceId: userId });
  return { success: true };
}
