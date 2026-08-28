import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { EnvVars } from '../config/env.validation.js';
import { Principal } from './auth.decorators.js';
import { hashPassword, verifyPassword } from './password.js';
import { USER_STORE } from './user.store.js';
import type { Role, UserRecord, UserStore } from './user.store.js';

export interface LoginResult {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly user: Principal;
}

/** The stand-in principal used when authentication is switched off. */
export const ANONYMOUS: Principal = {
  id: 'anonymous',
  username: 'anonymous',
  role: 'admin',
  displayName: 'Authentication disabled',
  anonymous: true,
};

@Injectable()
export class AuthService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(USER_STORE) private readonly users: UserStore,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  get enabled(): boolean {
    return this.config.get('AUTH_ENABLED', { infer: true });
  }

  get storageKind(): UserStore['kind'] {
    return this.users.kind;
  }

  /**
   * Creates the first administrator, if one is configured and no users exist.
   *
   * Without this, switching authentication on would lock everyone out of their
   * own console — including the person who has to fix it, five minutes before
   * doors.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn(
        'AUTH_ENABLED is false — every request runs as an administrator and anyone who can ' +
          'reach this port can move faders. Fine on a closed show network, not on a shared one.',
      );
      return;
    }

    const username = this.config.get('AUTH_BOOTSTRAP_USERNAME', {
      infer: true,
    });
    const password = this.config.get('AUTH_BOOTSTRAP_PASSWORD', {
      infer: true,
    });
    const count = await this.users.count();

    if (count > 0) {
      this.logger.log(
        `authentication on, ${count} user(s), storage: ${this.users.kind}`,
      );
      return;
    }
    if (!username || !password) {
      this.logger.error(
        'authentication is on but there are no users and no AUTH_BOOTSTRAP_USERNAME / ' +
          'AUTH_BOOTSTRAP_PASSWORD to create one. Nobody can log in.',
      );
      return;
    }

    await this.createUser({
      username,
      password,
      role: 'admin',
      displayName: 'Bootstrap admin',
    });
    this.logger.warn(
      `created the first administrator "${username}" from AUTH_BOOTSTRAP_*. Change that ` +
        'password and clear those variables.',
    );
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const user = await this.users.findByUsername(username);

    // Same work and the same answer whether the user exists or not: a login
    // that fails faster for unknown names is a way to enumerate them.
    const hash = user?.passwordHash ?? (await this.dummyHash());
    const ok = await verifyPassword(password, hash);

    if (!user || !ok)
      throw new UnauthorizedException('wrong username or password');
    if (user.disabled) throw new ForbiddenException('this account is disabled');

    await this.users.recordLogin(user.id);
    return this.issueToken(user);
  }

  async createUser(input: {
    username: string;
    password: string;
    role: Role;
    displayName?: string;
  }): Promise<UserRecord> {
    const passwordHash = await hashPassword(input.password);
    return this.users.create({
      username: input.username,
      passwordHash,
      role: input.role,
      displayName: input.displayName,
    });
  }

  async setPassword(id: string, password: string): Promise<UserRecord> {
    return this.users.update(id, {
      passwordHash: await hashPassword(password),
    });
  }

  async setRole(id: string, role: Role): Promise<UserRecord> {
    return this.users.update(id, { role });
  }

  async setDisabled(id: string, disabled: boolean): Promise<UserRecord> {
    return this.users.update(id, { disabled });
  }

  listUsers(): Promise<UserRecord[]> {
    return this.users.list();
  }

  deleteUser(id: string): Promise<void> {
    return this.users.delete(id);
  }

  /** Verifies a bearer token and returns who it belongs to. */
  async verify(token: string): Promise<Principal> {
    let payload: { sub?: string; username?: string; role?: Role };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('token is invalid or has expired');
    }
    if (!payload.sub)
      throw new UnauthorizedException('token is missing a subject');

    // Checked against storage on every request rather than trusted from the
    // token: disabling an account has to take effect now, not when the token
    // happens to expire.
    const user = await this.users.findById(payload.sub);
    if (!user || user.disabled)
      throw new UnauthorizedException('this account can no longer sign in');

    return principalOf(user);
  }

  private async issueToken(user: UserRecord): Promise<LoginResult> {
    const expiresIn = this.config.get('JWT_EXPIRES_IN_SECONDS', {
      infer: true,
    });
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, username: user.username, role: user.role },
      { expiresIn },
    );
    return { accessToken, expiresIn, user: principalOf(user) };
  }

  /** A hash to compare against when the username does not exist. */
  private async dummyHash(): Promise<string> {
    this.dummy ??= await hashPassword('there is no such user');
    return this.dummy;
  }

  private dummy: string | undefined;
}

export function principalOf(user: UserRecord): Principal {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName,
  };
}
