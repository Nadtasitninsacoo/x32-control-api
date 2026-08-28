import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser, Public, Roles } from './auth.decorators.js';
import type { Principal } from './auth.decorators.js';
import { AuthService } from './auth.service.js';
import {
  CreateUserDto,
  LoginDto,
  LoginResultDto,
  PrincipalDto,
  UpdateUserDto,
  UserDto,
} from './dto/auth.dto.js';
import type { Role, UserRecord } from './user.store.js';

function toUserDto(user: UserRecord): UserDto {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName,
    disabled: user.disabled,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a username and password for a token',
    description:
      'Send the token as `Authorization: Bearer <token>`. When AUTH_ENABLED is false this ' +
      'endpoint is unnecessary — every request already runs as an administrator.',
  })
  @ApiOkResponse({ type: LoginResultDto })
  @ApiUnauthorizedResponse({ description: 'Wrong username or password.' })
  login(@Body() body: LoginDto): Promise<LoginResultDto> {
    return this.auth.login(
      body.username,
      body.password,
    ) as Promise<LoginResultDto>;
  }

  @Get('me')
  @Roles('observer')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Who this token belongs to' })
  @ApiOkResponse({ type: PrincipalDto })
  me(@CurrentUser() user?: Principal): PrincipalDto {
    if (!user) throw new NotFoundException('no principal on this request');
    return user as PrincipalDto;
  }

  @Get('users')
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List accounts' })
  @ApiOkResponse({ type: [UserDto] })
  async users(): Promise<UserDto[]> {
    return (await this.auth.listUsers()).map(toUserDto);
  }

  @Post('users')
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create an account',
    description:
      'admin manages users and safety; engineer mixes; observer sees everything and changes ' +
      'nothing — the role for a guest engineer, a promoter, or a screen on the wall.',
  })
  @ApiCreatedResponse({ type: UserDto })
  @ApiConflictResponse({ description: 'That username is taken.' })
  async create(@Body() body: CreateUserDto): Promise<UserDto> {
    const user = await this.auth.createUser({
      username: body.username,
      password: body.password,
      role: body.role as Role,
      displayName: body.displayName,
    });
    return toUserDto(user);
  }

  @Patch('users/:id')
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change a password, a role, or disable an account' })
  @ApiOkResponse({ type: UserDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateUserDto,
  ): Promise<UserDto> {
    let user = await this.auth
      .listUsers()
      .then((all) => all.find((u) => u.id === id));
    if (!user) throw new NotFoundException(`no user with id "${id}"`);

    if (body.password) user = await this.auth.setPassword(id, body.password);
    if (body.role) user = await this.auth.setRole(id, body.role as Role);
    if (body.disabled !== undefined)
      user = await this.auth.setDisabled(id, body.disabled);
    return toUserDto(user);
  }

  @Delete('users/:id')
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Delete an account',
    description: 'Tokens already issued to it stop working immediately.',
  })
  @ApiNoContentResponse()
  async remove(@Param('id') id: string): Promise<void> {
    await this.auth.deleteUser(id);
  }
}
