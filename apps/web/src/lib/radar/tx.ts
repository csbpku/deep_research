// Prisma transaction client 共享类型别名，避免 routes 反复嵌套 Prisma.TransactionClient。
import type { PrismaClient } from '@prisma/client';
export type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;