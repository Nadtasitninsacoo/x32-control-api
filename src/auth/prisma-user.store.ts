import {
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import {
  CreateUserInput,
  Role,
  UpdateUserInput,
  UserRecord,
  UserStore,
} from './user.store.js';

/** PostgreSQL-backed users, used when `DATABASE_URL` is set. */
@Injectable()
export class PrismaUserStore implements UserStore, OnModuleDestroy {
  readonly kind = 'postgres' as const;
  private readonly prisma: PrismaClient;

  constructor(connectionString: string) {
    this.prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async connect(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async create(input: CreateUserInput): Promise<UserRecord> {
    try {
      return toRecord(await this.prisma.user.create({ data: input }));
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException(
          `a user called "${input.username}" already exists`,
        );
      }
      throw error;
    }
  }

  async findByUsername(username: string): Promise<UserRecord | undefined> {
    const found = await this.prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
    });
    return found ? toRecord(found) : undefined;
  }

  async findById(id: string): Promise<UserRecord | undefined> {
    const found = await this.prisma.user.findUnique({ where: { id } });
    return found ? toRecord(found) : undefined;
  }

  async list(): Promise<UserRecord[]> {
    const users = await this.prisma.user.findMany({
      orderBy: { username: 'asc' },
    });
    return users.map(toRecord);
  }

  async update(id: string, input: UpdateUserInput): Promise<UserRecord> {
    if (!(await this.findById(id)))
      throw new NotFoundException(`no user ${id}`);
    return toRecord(
      await this.prisma.user.update({ where: { id }, data: input }),
    );
  }

  async delete(id: string): Promise<void> {
    await this.prisma.user.deleteMany({ where: { id } });
  }

  count(): Promise<number> {
    return this.prisma.user.count();
  }

  async recordLogin(id: string): Promise<void> {
    await this.prisma.user.updateMany({
      where: { id },
      data: { lastLoginAt: new Date() },
    });
  }
}

function toRecord(user: {
  id: string;
  username: string;
  passwordHash: string;
  role: string;
  displayName: string | null;
  disabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
}): UserRecord {
  return { ...user, role: user.role as Role };
}
