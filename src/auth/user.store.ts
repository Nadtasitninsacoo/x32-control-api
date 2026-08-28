import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/**
 * Who can log in, and what they are allowed to do.
 *
 * Same two-implementation shape as the preset store: PostgreSQL when
 * `DATABASE_URL` is set, memory otherwise, so a fresh clone still runs and the
 * test suite still needs no database.
 */

export const ROLES = ['admin', 'engineer', 'observer'] as const;
export type Role = (typeof ROLES)[number];

/**
 * What each role may do.
 *
 * `observer` is the important one: a guest engineer, a promoter, a phone on
 * the wall showing meters. They can see everything and change nothing.
 */
export const ROLE_RANK: Record<Role, number> = {
  observer: 0,
  engineer: 1,
  admin: 2,
};

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  role: Role;
  displayName?: string | null;
  disabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date | null;
}

export interface CreateUserInput {
  username: string;
  passwordHash: string;
  role: Role;
  displayName?: string;
}

export interface UpdateUserInput {
  passwordHash?: string;
  role?: Role;
  displayName?: string;
  disabled?: boolean;
}

export interface UserStore {
  readonly kind: 'memory' | 'postgres';
  create(input: CreateUserInput): Promise<UserRecord>;
  findByUsername(username: string): Promise<UserRecord | undefined>;
  findById(id: string): Promise<UserRecord | undefined>;
  list(): Promise<UserRecord[]>;
  update(id: string, input: UpdateUserInput): Promise<UserRecord>;
  delete(id: string): Promise<void>;
  count(): Promise<number>;
  recordLogin(id: string): Promise<void>;
}

export const USER_STORE = Symbol('USER_STORE');

@Injectable()
export class MemoryUserStore implements UserStore {
  readonly kind = 'memory' as const;
  private readonly users = new Map<string, UserRecord>();

  async create(input: CreateUserInput): Promise<UserRecord> {
    if (await this.findByUsername(input.username)) {
      throw new ConflictException(
        `a user called "${input.username}" already exists`,
      );
    }
    const now = new Date();
    const user: UserRecord = {
      id: randomUUID(),
      username: input.username,
      passwordHash: input.passwordHash,
      role: input.role,
      displayName: input.displayName ?? null,
      disabled: false,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    };
    this.users.set(user.id, user);
    return user;
  }

  async findByUsername(username: string): Promise<UserRecord | undefined> {
    const wanted = username.toLowerCase();
    for (const user of this.users.values()) {
      if (user.username.toLowerCase() === wanted) return user;
    }
    return undefined;
  }

  async findById(id: string): Promise<UserRecord | undefined> {
    return this.users.get(id);
  }

  async list(): Promise<UserRecord[]> {
    return [...this.users.values()].sort((a, b) =>
      a.username.localeCompare(b.username),
    );
  }

  async update(id: string, input: UpdateUserInput): Promise<UserRecord> {
    const user = this.users.get(id);
    if (!user) throw new NotFoundException(`no user ${id}`);
    const updated: UserRecord = {
      ...user,
      passwordHash: input.passwordHash ?? user.passwordHash,
      role: input.role ?? user.role,
      displayName: input.displayName ?? user.displayName,
      disabled: input.disabled ?? user.disabled,
      updatedAt: new Date(),
    };
    this.users.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    this.users.delete(id);
  }

  async count(): Promise<number> {
    return this.users.size;
  }

  async recordLogin(id: string): Promise<void> {
    const user = this.users.get(id);
    if (user) user.lastLoginAt = new Date();
  }
}
