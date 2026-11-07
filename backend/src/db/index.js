import { MemoryRepo } from './memoryRepo.js';
import { MysqlRepo } from './mysqlRepo.js';

export function createRepo(env = process.env) {
  if ((env.NETSWITCH_DB || 'mysql').toLowerCase() === 'memory') {
    return new MemoryRepo();
  }
  return new MysqlRepo({
    host: env.MYSQL_HOST || '127.0.0.1',
    port: Number(env.MYSQL_PORT || 3306),
    user: env.MYSQL_USER || 'root',
    password: env.MYSQL_PASSWORD || '',
    database: env.MYSQL_DATABASE || 'netswitch',
  });
}
