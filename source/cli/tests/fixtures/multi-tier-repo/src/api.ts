import { logger } from './logger';

export function getUser(id: string) {
  logger.info('getUser', { id });
  return { id };
}
